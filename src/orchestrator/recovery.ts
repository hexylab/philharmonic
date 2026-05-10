import { stat } from 'node:fs/promises';

import type { Config } from '../config/index.js';
import type { GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import type { runClaude } from '../runner/index.js';
import type { RunTracker } from '../server/index.js';
import type { WorkflowSource } from '../workflow/index.js';
import type { GitRunner, WorkspaceManager } from '../workspace/index.js';

import { type FailureReason } from './errors.js';
import { parseRepositoryNameWithOwner } from './repository.js';
import {
  dispatchSelected,
  evaluateContinuationDecision,
  handleFailureExhaustion,
  isRetryEligibleReason,
  type NotifyFailureExhaustedFn,
  type RunOnceClock,
  type RunOnceResult,
} from './run.js';
import { type RetryQueue } from './retry-queue.js';
import { isAcceptableIssue } from './select.js';
import { buildIssueSlug } from './slug.js';
import type { GhRunner } from '../projects/index.js';
import { notifyFailureExhausted as defaultNotifyFailureExhausted } from './exhaustion-notify.js';

const RECOVERY_STATUS = 'In Progress';

export type RecoveryDeps = {
  config: Config;
  repoRoot: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  workflowSource: WorkflowSource;
  runnerLogsRoot: string;
  signal: AbortSignal;
  runClaude?: typeof runClaude;
  /** workspace 作成前に `git fetch <remote> <baseBranch>` を実行する git runner */
  gitRunner?: GitRunner;
  /** fetch 先 remote 名 (default: `origin`) */
  remote?: string;
  logger: Logger;
  clock?: RunOnceClock;
  generateRunId?: () => string;
  /** worktree ディレクトリの存在確認を差し替えるためのフック (テスト用) */
  pathExists?: (target: string) => Promise<boolean>;
  /** snapshot HTTP API (#30) 用の in-memory tracker。recovery 経路の dispatch も tracker に乗せる */
  runTracker?: RunTracker;
  /**
   * 失敗時に retry queue に schedule するための queue (#84 / ADR-0008)。未指定なら schedule しない。
   */
  retryQueue?: RetryQueue;
  /** retry 上限 (1 つの Issue が retry queue に積み直される最大回数)。default 0 (= 機能 off) */
  maxRetryAttempts?: number;
  /** retry backoff の clamp 上限 (ms)。default 0 (= computeRetryDelayMs が 0 を返すため retry 0s) */
  maxRetryBackoffMs?: number;
  /**
   * recovery 経路で `kind=failure` の retry が exhausted した瞬間に GitHub Projects Status を
   * `Failed` に倒し、Issue にコメントを残す safety-net (ADR-0010 / #103)。永続化 (ADR-0011 / #104)
   * で `attempt` が max 直前のまま再起動した場合、recovery 内 dispatch の失敗で即 exhausted に
   * 到達するケースを通常 tick と同じ取り扱いにするため。`runGh` 未注入なら no-op。
   */
  runGh?: GhRunner;
  /** テストで差し替え可能な exhaustion notify 関数 */
  notifyFailureExhausted?: NotifyFailureExhaustedFn;
};

export type RecoverySummary = {
  inProgressCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

/**
 * `philharmonic serve` 起動時の Tracker-driven Recovery フェーズ。
 *
 * Project Item で Status が `In Progress` のまま残っているものを引き取り、
 * - 対応する open PR が既にあるなら skip
 * - worktree が残っていれば force reset (cleanup → 再作成)
 * - 残っていなければ新規 worktree
 * してから {@link dispatchSelected} を呼ぶ。
 *
 * ADR-0005 で Status 遷移は agent 側に移ったため、recovery 経路でも orchestrator は
 * Status を書き換えない。同 Item は agent が再度 prompt 受領時に flip 判断する。
 *
 * ADR-0007 の dependency filter は **recovery では適用しない**。
 * recovery は既に着手済み (mid-execution) の Issue を救済するフェーズであり、依存先が後から open に
 * 戻ったケースまで含めて元の作業状態を維持する。フィルタを掛けると、依存先が再度 open になった
 * Issue の worktree が永遠に dispatch されなくなるため。
 *
 * spec: docs/specs/orchestration-mvp.md#tracker-driven-recovery-serve-起動時
 */
export async function recoverInProgress(deps: RecoveryDeps): Promise<RecoverySummary> {
  const { logger, signal } = deps;
  const exists = deps.pathExists ?? defaultPathExists;

  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const inProgress = candidates.filter(
    (c) => c.status === RECOVERY_STATUS && c.issueState === 'OPEN',
  );

  logger.info('recovery started', { inProgressCount: inProgress.length });

  const summary: RecoverySummary = {
    inProgressCount: inProgress.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  if (inProgress.length === 0) {
    logger.info('recovery completed', summary);
    return summary;
  }

  for (const candidate of inProgress) {
    if (signal.aborted) break;

    let repository: ReturnType<typeof parseRepositoryNameWithOwner>;
    try {
      repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }

    // 1. open PR 判定 (head.ref prefix で照合)
    const branchPrefix = `feature/${candidate.issueNumber}-`;
    let openPrs;
    try {
      openPrs = await deps.githubClient.listOpenPullRequests({
        owner: repository.owner,
        repo: repository.name,
        headBranchPrefix: branchPrefix,
      });
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }
    if (openPrs.length > 0) {
      const pr = openPrs[0]!;
      logger.info('recovery skip (open PR exists)', {
        issueNumber: candidate.issueNumber,
        headRef: pr.headRef,
        prNumber: pr.number,
      });
      summary.skipped += 1;
      continue;
    }

    // 2. Issue 取得
    let issue;
    try {
      issue = await deps.githubClient.getIssue({
        owner: repository.owner,
        repo: repository.name,
        issueNumber: candidate.issueNumber,
      });
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }

    if (issue.state !== 'open') {
      logger.info('recovery skip (issue closed)', { issueNumber: candidate.issueNumber });
      summary.skipped += 1;
      continue;
    }

    const acceptable = isAcceptableIssue({
      labels: issue.labels,
      assignees: issue.assignees,
      agentUserLogin: deps.config.agentUserLogin,
    });
    if (!acceptable.ok) {
      logger.info(`recovery: agent acceptance check failed (${acceptable.reason})`, {
        issueNumber: candidate.issueNumber,
      });
    }

    // 3. worktree が残っていれば force reset
    const taskKey = `issue-${candidate.issueNumber}`;
    const workspacePath = deps.workspaceManager.resolveWorkspacePath(taskKey);
    let workspaceExisted = false;
    try {
      workspaceExisted = await exists(workspacePath);
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }

    if (workspaceExisted) {
      const recoveryBranch = `feature/${candidate.issueNumber}-${buildIssueSlug(candidate.issueTitle)}`;
      logger.info('recovery worktree force reset', {
        issueNumber: candidate.issueNumber,
        workspacePath,
        branch: recoveryBranch,
      });
      try {
        await deps.workspaceManager.cleanupWorkspace({
          taskKey,
          branch: recoveryBranch,
          deleteBranch: true,
        });
      } catch (error) {
        logger.warn('recovery dispatch error', {
          issueNumber: candidate.issueNumber,
          error: describeError(error),
        });
        summary.skipped += 1;
        continue;
      }
    }

    // 4. dispatchSelected 経由で再実行
    try {
      const result = await dispatchSelected({
        config: deps.config,
        repoRoot: deps.repoRoot,
        candidate,
        issue,
        repository,
        workspaceManager: deps.workspaceManager,
        workflowSource: deps.workflowSource,
        runnerLogsRoot: deps.runnerLogsRoot,
        runClaude: deps.runClaude,
        gitRunner: deps.gitRunner,
        remote: deps.remote,
        baseLogger: logger,
        clock: deps.clock,
        generateRunId: deps.generateRunId,
        runTracker: deps.runTracker,
      });
      summary.processed += 1;
      logRunResult(logger, candidate, result);
      if (result.kind === 'success') {
        summary.succeeded += 1;
        await scheduleContinuationAfterRecovery({
          retryQueue: deps.retryQueue,
          maxRetryAttempts: deps.maxRetryAttempts ?? 0,
          projectsClient: deps.projectsClient,
          config: deps.config,
          dispatchStatuses: deps.config.dispatchStatuses,
          issueNumber: candidate.issueNumber,
          repository,
          branch: result.branch,
          workspacePath,
          runId: result.runId,
          logger,
          clock: deps.clock ?? (() => new Date()),
        });
      } else {
        summary.failed += 1;
        await scheduleRetryAfterRecovery({
          retryQueue: deps.retryQueue,
          maxRetryAttempts: deps.maxRetryAttempts ?? 0,
          maxRetryBackoffMs: deps.maxRetryBackoffMs ?? 0,
          issueNumber: candidate.issueNumber,
          itemId: candidate.itemId,
          repository,
          branch: result.branch ?? '(unknown)',
          workspacePath,
          reason: result.reason,
          runId: result.runId,
          errorSummary: result.errorSummary,
          runnerLogsRoot: deps.runnerLogsRoot,
          config: deps.config,
          notifyFailureExhausted: resolveNotifyFailureExhausted(deps),
          logger,
          clock: deps.clock ?? (() => new Date()),
        });
      }
    } catch (error) {
      summary.processed += 1;
      summary.failed += 1;
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
    }
  }

  logger.info('recovery completed', summary);
  return summary;
}

function logRunResult(
  logger: Logger,
  candidate: Candidate,
  result: Extract<RunOnceResult, { kind: 'success' | 'failed' }>,
): void {
  if (result.kind === 'success') {
    logger.info('recovery dispatch success', {
      issueNumber: candidate.issueNumber,
      runId: result.runId,
    });
    return;
  }
  logger.warn('recovery dispatch failed', {
    issueNumber: candidate.issueNumber,
    runId: result.runId,
    reason: result.reason,
  });
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * recovery 経路用に `notifyFailureExhausted` の関数を組み立てる。
 *
 * - `notifyFailureExhausted` を直接渡されたらそれを使う (テスト用)
 * - そうでなくて `runGh` だけ渡されたら module の default を `runGh` / `projectsClient` で bind
 * - どちらも未指定なら undefined を返す (= 配線無し)
 */
function resolveNotifyFailureExhausted(deps: RecoveryDeps): NotifyFailureExhaustedFn | undefined {
  if (deps.notifyFailureExhausted !== undefined) return deps.notifyFailureExhausted;
  if (deps.runGh === undefined) return undefined;
  const runGh = deps.runGh;
  const projectsClient = deps.projectsClient;
  const logger = deps.logger;
  return (input) =>
    defaultNotifyFailureExhausted(input, {
      runGh,
      projectsClient,
      logger,
    });
}

type ScheduleRetryAfterRecoveryDeps = {
  retryQueue?: RetryQueue;
  maxRetryAttempts: number;
  maxRetryBackoffMs: number;
  issueNumber: number;
  itemId: string;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  reason: FailureReason;
  runId: string;
  errorSummary: string | null;
  runnerLogsRoot: string;
  config: Config;
  notifyFailureExhausted?: NotifyFailureExhaustedFn;
  logger: Logger;
  clock: () => Date;
};

/**
 * recovery 経路で `dispatchSelected` が failed を返した場合の retry queue 連携。
 *
 * 永続化された retry entry が同 Issue で残っている場合は `kind=failure` の `attempt + 1` を継続する。
 * 既存 entry が無い (新規 failure) ときは `attempt = 1` から始める。
 *
 * 上限到達時は通常 tick と同じ {@link handleFailureExhaustion} を呼び、failure-summary 書き出し
 * + `retry exhausted` warn + (DI されていれば) ADR-0010 の Failed safety-net を 1 セットで実行する。
 *
 * spec: docs/specs/retry-queue.md §永続化 §復元後の release pass
 */
async function scheduleRetryAfterRecovery(deps: ScheduleRetryAfterRecoveryDeps): Promise<void> {
  if (deps.retryQueue === undefined) return;
  if (deps.maxRetryAttempts <= 0) return;
  if (!isRetryEligibleReason(deps.reason)) return;

  // 永続化された entry が残っているなら attempt counter を継続する (ADR-0011)。
  // kind が failure と一致するときのみ +1、それ以外 (continuation など) は 1 から始める。
  const existing = deps.retryQueue.list().find((e) => e.issueNumber === deps.issueNumber);
  const nextAttempt =
    existing !== undefined && existing.kind === 'failure' ? existing.attempt + 1 : 1;
  if (nextAttempt > deps.maxRetryAttempts) {
    await handleFailureExhaustion({
      retryQueue: deps.retryQueue,
      issueNumber: deps.issueNumber,
      repository: deps.repository,
      itemId: deps.itemId,
      branch: deps.branch,
      workspacePath: deps.workspacePath,
      attempt: existing?.attempt ?? 0,
      maxAttempts: deps.maxRetryAttempts,
      failureReason: deps.reason,
      runId: deps.runId,
      errorSummary: deps.errorSummary,
      runnerLogsRoot: deps.runnerLogsRoot,
      config: deps.config,
      notifyFailureExhausted: deps.notifyFailureExhausted,
      logger: deps.logger,
      clock: deps.clock,
      via: 'recovery',
    });
    return;
  }
  const now = deps.clock();
  const entry = deps.retryQueue.schedule({
    kind: 'failure',
    issueNumber: deps.issueNumber,
    repository: deps.repository,
    branch: deps.branch,
    workspacePath: deps.workspacePath,
    attempt: nextAttempt,
    failureReason: deps.reason,
    lastRunId: deps.runId,
    lastErrorSummary: deps.errorSummary,
    now,
    maxBackoffMs: deps.maxRetryBackoffMs,
  });
  deps.logger.info('retry scheduled', {
    kind: entry.kind,
    issueNumber: entry.issueNumber,
    attempt: entry.attempt,
    delayMs: entry.dueAt.getTime() - now.getTime(),
    dueAt: entry.dueAt.toISOString(),
    failureReason: entry.failureReason,
    lastRunId: entry.lastRunId,
    via: 'recovery',
  });
}

type ScheduleContinuationAfterRecoveryDeps = {
  retryQueue?: RetryQueue;
  maxRetryAttempts: number;
  projectsClient: ProjectsClient;
  config: Config;
  dispatchStatuses: readonly string[];
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  runId: string;
  logger: Logger;
  clock: () => Date;
};

/**
 * recovery 経路で `dispatchSelected` が success を返した場合の continuation retry 連携 (ADR-0009)。
 *
 * 通常 tick の `processDispatchSuccessForContinuation` と同じ規則で動かす。serve 起動直後の
 * recovery 後に start する `serveLoop` でこの continuation entry が消化される。
 */
async function scheduleContinuationAfterRecovery(
  deps: ScheduleContinuationAfterRecoveryDeps,
): Promise<void> {
  if (deps.retryQueue === undefined) return;
  if (deps.maxRetryAttempts <= 0) {
    deps.retryQueue.remove(deps.issueNumber);
    return;
  }

  let candidates: readonly Candidate[];
  try {
    candidates = await deps.projectsClient.fetchProjectCandidates({
      owner: deps.config.owner,
      projectNumber: deps.config.projectNumber,
      statusFieldName: deps.config.statusField,
    });
  } catch (error) {
    deps.retryQueue.remove(deps.issueNumber);
    deps.logger.info('continuation released', {
      issueNumber: deps.issueNumber,
      reason: 'fetch_error',
      lastRunId: deps.runId,
      via: 'recovery',
      error: describeError(error),
    });
    return;
  }

  const candidate = candidates.find((c) => c.issueNumber === deps.issueNumber);
  const decision = evaluateContinuationDecision({
    candidate,
    config: deps.config,
    dispatchStatuses: deps.dispatchStatuses,
  });

  if (decision.kind === 'release') {
    deps.retryQueue.remove(deps.issueNumber);
    deps.logger.info('continuation released', {
      issueNumber: deps.issueNumber,
      reason: decision.reason,
      status: candidate?.status ?? null,
      lastRunId: deps.runId,
      via: 'recovery',
    });
    return;
  }

  const nextAttempt = 1;
  const now = deps.clock();
  const entry = deps.retryQueue.schedule({
    kind: 'continuation',
    issueNumber: deps.issueNumber,
    repository: deps.repository,
    branch: deps.branch,
    workspacePath: deps.workspacePath,
    attempt: nextAttempt,
    failureReason: null,
    lastRunId: deps.runId,
    lastErrorSummary: null,
    now,
    maxBackoffMs: 0,
  });
  deps.logger.info('retry scheduled', {
    kind: entry.kind,
    issueNumber: entry.issueNumber,
    attempt: entry.attempt,
    delayMs: entry.dueAt.getTime() - now.getTime(),
    dueAt: entry.dueAt.toISOString(),
    failureReason: entry.failureReason,
    lastRunId: entry.lastRunId,
    activeStatus: decision.status,
    via: 'recovery',
  });
}
