import path from 'node:path';

import type { Config } from '../config/index.js';
import type { GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { ProjectsClient } from '../projects/index.js';
import type {
  OperatorActionReason,
  RunningEntry,
  RunningWatchdog,
  RunTracker,
} from '../server/tracker.js';

import { handleFailureExhaustion, type NotifyFailureExhaustedFn } from './run.js';
import { parseRepositoryNameWithOwner, type Repository } from './repository.js';
import { type RetryQueue } from './retry-queue.js';

/**
 * watchdog (#105) が `orphaned + stale` を同時に立てた entry のうち、安全条件を満たすものだけ
 * を retry queue / Failed safety-net に接続する自動 recovery (#109)。
 *
 * - **対象**: `entry.watchdog.reasons` が `['orphaned', 'stale']` の両方を含む entry のみ
 *   (片方しか立たないケースは長時間 tool wait / advisor wait の可能性があるため touch しない)
 * - **追加ガード**: open PR / unsafe workspacePath / retry queue 未注入 / `maxRetryAttempts <= 0`
 *   のいずれかに当たれば `operatorActionRequired` を立てて queue / cleanup には触らない
 * - **副作用** (合格時):
 *   1. `tracker.runFinished({ kind: 'failed', reason: 'stalled' })` を呼んで in-flight set から外す
 *   2. retry queue に `kind: 'failure'` で schedule する。attempt は既存 entry の `attempt + 1`
 *      または 1。`nextAttempt > maxRetryAttempts` のときは `handleFailureExhaustion` 経由で
 *      Failed safety-net (ADR-0010) を発火する
 *
 * spec: docs/specs/serve-daemon.md#active-run-watchdog-105 / docs/specs/retry-queue.md
 * adr: docs/adr/0008-in-memory-retry-queue.md / docs/adr/0010-retry-exhaustion-github-safety-net.md
 */

export type OrphanRecoveryDeps = {
  config: Config;
  repoRoot: string;
  tracker: RunTracker;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  /** retry queue。未注入なら `retry_disabled` で operator action required を立てる */
  retryQueue?: RetryQueue;
  /** `agent.max_retry_attempts` (config 値)。0 なら `retry_disabled` 扱い */
  maxRetryAttempts: number;
  /** `agent.max_retry_backoff_ms` */
  maxRetryBackoffMs: number;
  /** Failed safety-net (ADR-0010)。未注入なら exhaustion 時に warn ログのみ */
  notifyFailureExhausted?: NotifyFailureExhaustedFn;
  /** failure-summary.md の出力先 root */
  runnerLogsRoot: string;
  /** 現在時刻 (テスト用) */
  now?: () => Date;
  logger: Logger;
};

export type OrphanRecoveryOutcome =
  | { kind: 'recovered'; runId: string; issueNumber: number; attempt: number }
  | { kind: 'exhausted'; runId: string; issueNumber: number; attempt: number }
  | {
      kind: 'operator_action_required';
      runId: string;
      issueNumber: number;
      reasons: ReadonlyArray<OperatorActionReason>;
    }
  | { kind: 'skipped'; runId: string; issueNumber: number; reason: 'not_eligible' };

export type OrphanRecoveryResult = {
  outcomes: ReadonlyArray<OrphanRecoveryOutcome>;
};

/**
 * tracker から `orphaned + stale` 同時 marker の entry を列挙し、合格なら自動 recovery する。
 *
 * 例外を呼び出し側に投げない (= daemon の安定性優先)。entry 個別の失敗は marker に
 * `recover_error` を載せて operator に委ねる。
 */
export async function recoverOrphaned(deps: OrphanRecoveryDeps): Promise<OrphanRecoveryResult> {
  const clock = deps.now ?? ((): Date => new Date());
  const outcomes: OrphanRecoveryOutcome[] = [];

  for (const entry of deps.tracker.listRunning()) {
    if (!isOrphanedAndStale(entry.watchdog)) {
      outcomes.push({
        kind: 'skipped',
        runId: entry.runId,
        issueNumber: entry.issueNumber,
        reason: 'not_eligible',
      });
      continue;
    }

    try {
      const outcome = await recoverEntry(entry, deps, clock());
      outcomes.push(outcome);
    } catch (error) {
      // entry 単位の想定外 throw は marker に `recover_error` を残して operator に委ねる
      deps.logger.warn('orphan recovery error', {
        runId: entry.runId,
        issueNumber: entry.issueNumber,
        error: describeError(error),
      });
      addOperatorReason(deps.tracker, entry, 'recover_error');
      outcomes.push({
        kind: 'operator_action_required',
        runId: entry.runId,
        issueNumber: entry.issueNumber,
        reasons: ['recover_error'],
      });
    }
  }

  return { outcomes };
}

async function recoverEntry(
  entry: RunningEntry,
  deps: OrphanRecoveryDeps,
  now: Date,
): Promise<OrphanRecoveryOutcome> {
  // 1. retry queue / max attempts の出口が無ければ即 operator action
  if (deps.retryQueue === undefined || deps.maxRetryAttempts <= 0) {
    return markOperatorAction(deps, entry, ['retry_disabled']);
  }

  // 2. unsafe workspace path (workspaceRoot 配下でないなら絶対に削除しない)
  if (!isInsideWorkspaceRoot(entry.workspacePath, deps.repoRoot, deps.config.workspaceRoot)) {
    return markOperatorAction(deps, entry, ['unsafe_workspace_path']);
  }

  // 3. Project Items を 1 回だけ fetch して repository + itemId を同時に拾う
  let repository: Repository;
  let itemId: string;
  try {
    const candidates = await deps.projectsClient.fetchProjectCandidates({
      owner: deps.config.owner,
      projectNumber: deps.config.projectNumber,
      statusFieldName: deps.config.statusField,
    });
    const match = candidates.find((c) => c.issueNumber === entry.issueNumber);
    if (match === undefined) {
      throw new Error(`issue #${entry.issueNumber} not found in project candidates`);
    }
    repository = parseRepositoryNameWithOwner(match.repositoryNameWithOwner);
    itemId = match.itemId;
  } catch (error) {
    deps.logger.warn('orphan recovery error', {
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      stage: 'fetch_candidates',
      error: describeError(error),
    });
    return markOperatorAction(deps, entry, ['recover_error']);
  }

  // 4. open PR を持っているなら touch しない (agent が PR 作って Status flip 前死亡の稀ケース保護)
  try {
    const openPrs = await deps.githubClient.listOpenPullRequests({
      owner: repository.owner,
      repo: repository.name,
      headBranchPrefix: `feature/${entry.issueNumber}-`,
    });
    if (openPrs.length > 0) {
      return markOperatorAction(deps, entry, ['open_pr']);
    }
  } catch (error) {
    deps.logger.warn('orphan recovery error', {
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      stage: 'list_open_prs',
      error: describeError(error),
    });
    // open PR を確認できないケースは安全側に倒し operator に委ねる (= 自動 retry しない)
    return markOperatorAction(deps, entry, ['recover_error']);
  }

  // 5. attempt counter 決定 (永続化された entry が同 Issue にあれば +1、なければ 1)
  const existing = deps.retryQueue.list().find((e) => e.issueNumber === entry.issueNumber);
  const nextAttempt =
    existing !== undefined && existing.kind === 'failure' ? existing.attempt + 1 : 1;

  // 6. 上限到達なら Failed safety-net へ
  if (nextAttempt > deps.maxRetryAttempts) {
    // tracker.runFinished を先に呼んで in-flight set から外す (double-dispatch 防止)
    deps.tracker.runFinished({
      kind: 'failed',
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      reason: 'stalled',
      totalCostUsd: null,
    });
    await handleFailureExhaustion({
      retryQueue: deps.retryQueue,
      issueNumber: entry.issueNumber,
      repository,
      itemId,
      branch: entry.branch,
      workspacePath: entry.workspacePath,
      attempt: existing?.attempt ?? 0,
      maxAttempts: deps.maxRetryAttempts,
      failureReason: 'stalled',
      runId: entry.runId,
      errorSummary: buildErrorSummary(entry, now),
      runnerLogsRoot: deps.runnerLogsRoot,
      config: deps.config,
      notifyFailureExhausted: deps.notifyFailureExhausted,
      logger: deps.logger,
      clock: clockToFn(now),
      via: 'watchdog',
    });
    return {
      kind: 'exhausted',
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      attempt: existing?.attempt ?? 0,
    };
  }

  // 7. 通常 recovery: tracker.runFinished → retryQueue.schedule の順
  deps.tracker.runFinished({
    kind: 'failed',
    runId: entry.runId,
    issueNumber: entry.issueNumber,
    reason: 'stalled',
    totalCostUsd: null,
  });

  const scheduled = deps.retryQueue.schedule({
    kind: 'failure',
    issueNumber: entry.issueNumber,
    repository: { owner: repository.owner, name: repository.name },
    branch: entry.branch,
    workspacePath: entry.workspacePath,
    attempt: nextAttempt,
    failureReason: 'stalled',
    lastRunId: entry.runId,
    lastErrorSummary: buildErrorSummary(entry, now),
    now,
    maxBackoffMs: deps.maxRetryBackoffMs,
  });
  deps.logger.warn('orphan recovered', {
    runId: entry.runId,
    issueNumber: entry.issueNumber,
    attempt: scheduled.attempt,
    dueAt: scheduled.dueAt.toISOString(),
    delayMs: scheduled.dueAt.getTime() - now.getTime(),
    branch: scheduled.branch,
    workspacePath: scheduled.workspacePath,
    via: 'watchdog',
  });

  return {
    kind: 'recovered',
    runId: entry.runId,
    issueNumber: entry.issueNumber,
    attempt: scheduled.attempt,
  };
}

function isOrphanedAndStale(watchdog: RunningWatchdog | null): boolean {
  if (watchdog === null) return false;
  return watchdog.reasons.includes('orphaned') && watchdog.reasons.includes('stale');
}

function markOperatorAction(
  deps: OrphanRecoveryDeps,
  entry: RunningEntry,
  newReasons: ReadonlyArray<OperatorActionReason>,
): OrphanRecoveryOutcome {
  const merged = replaceRecoveryReasons(deps.tracker, entry, newReasons);
  if (merged.changed) {
    deps.logger.warn('orphan recovery operator action required', {
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      reasons: merged.reasons,
      branch: entry.branch,
      workspacePath: entry.workspacePath,
    });
  }
  return {
    kind: 'operator_action_required',
    runId: entry.runId,
    issueNumber: entry.issueNumber,
    reasons: merged.reasons,
  };
}

function addOperatorReason(
  tracker: RunTracker,
  entry: RunningEntry,
  reason: OperatorActionReason,
): void {
  replaceRecoveryReasons(tracker, entry, [reason]);
}

/**
 * orphan-recovery 経路で `recoverEntry` が出す reason (`open_pr` / `retry_disabled` /
 * `unsafe_workspace_path` / `recover_error`) を最新の評価で置き換える。
 *
 * watchdog 由来の `orphaned_only` / `stale_only` は本関数では触らない (= `runWatchdog`
 * 内で管理されるため、open PR が後で閉じても `orphaned_only` の有無は影響を受けない)。
 *
 * これにより「過去 tick で立てた open_pr が PR 閉鎖後も残る」rot を回避する。
 */
function replaceRecoveryReasons(
  tracker: RunTracker,
  entry: RunningEntry,
  recoveryReasons: ReadonlyArray<OperatorActionReason>,
): { changed: boolean; reasons: ReadonlyArray<OperatorActionReason> } {
  if (entry.watchdog === null) {
    return { changed: false, reasons: [] };
  }
  const watchdogManaged = entry.watchdog.operatorActionReasons.filter((r) =>
    WATCHDOG_MANAGED_REASONS.has(r),
  );
  const merged = new Set<OperatorActionReason>([...watchdogManaged, ...recoveryReasons]);
  const ordered: OperatorActionReason[] = [];
  for (const r of OPERATOR_ACTION_REASON_ORDER) {
    if (merged.has(r)) ordered.push(r);
  }
  const before = entry.watchdog.operatorActionReasons;
  const sameLength = before.length === ordered.length;
  const sameOrder = sameLength && before.every((r, i) => r === ordered[i]);
  if (sameOrder) {
    return { changed: false, reasons: before };
  }
  tracker.setWatchdog(entry.runId, {
    reasons: entry.watchdog.reasons,
    orphanedSince: entry.watchdog.orphanedSince,
    staleSince: entry.watchdog.staleSince,
    operatorActionRequired: ordered.length > 0,
    operatorActionReasons: ordered,
  });
  return { changed: true, reasons: ordered };
}

/** `runWatchdog` 内で管理される reason (orphan-recovery の評価では触らない) */
const WATCHDOG_MANAGED_REASONS = new Set<OperatorActionReason>(['orphaned_only', 'stale_only']);

const OPERATOR_ACTION_REASON_ORDER: ReadonlyArray<OperatorActionReason> = [
  'orphaned_only',
  'stale_only',
  'open_pr',
  'retry_disabled',
  'unsafe_workspace_path',
  'recover_error',
];

function isInsideWorkspaceRoot(
  workspacePath: string,
  repoRoot: string,
  workspaceRoot: string,
): boolean {
  if (workspacePath.length === 0) return false;
  const absoluteRoot = path.resolve(repoRoot, workspaceRoot);
  const absolutePath = path.resolve(workspacePath);
  if (absolutePath === absoluteRoot) return false;
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative.length === 0) return false;
  if (relative.startsWith('..')) return false;
  if (path.isAbsolute(relative)) return false;
  return true;
}

function buildErrorSummary(entry: RunningEntry, now: Date): string {
  const orphanedSince = entry.watchdog?.orphanedSince ?? null;
  const staleSince = entry.watchdog?.staleSince ?? null;
  const idleMs = Math.max(0, now.getTime() - Date.parse(entry.lastActivityAt));
  return `watchdog auto-recovery: orphaned+stale detected (orphanedSince=${orphanedSince}, staleSince=${staleSince}, idleMs=${idleMs})`;
}

function clockToFn(fixed: Date): () => Date {
  return () => fixed;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
