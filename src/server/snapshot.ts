import type { RetryEntry, RetryQueue } from '../orchestrator/retry-queue.js';

import {
  noopDependencyTracker,
  type DependencyTracker,
  type SchedulerSnapshot,
} from './dependency-tracker.js';
import type { RunningEntry, RunTracker, Totals } from './tracker.js';

/**
 * `/api/v1/state` のレスポンス body 形 (snake_case で公開)。
 *
 * spec: docs/specs/snapshot-api.md
 */
export type StateSnapshot = {
  started_at: string;
  uptime_ms: number;
  polling: {
    interval_ms: number;
    last_tick_at: string | null;
  };
  /**
   * stalled 残時間 (`stall_timeout_ms - (now - last_activity_at)`) を dashboard 等で
   * 算出するための運用パラメータ (#87)。`agent.stall_timeout_ms` の現値。0 で stall 判定 off。
   *
   * `scheduler` / `retry_queue` と同じく optional。古い (本フィールドを実装していない)
   * serve に対しても dashboard 側で安全に fall-back できるよう、現行 serve は常に key を返す。
   */
  agent?: {
    stall_timeout_ms: number;
  };
  running: Array<{
    run_id: string;
    issue_number: number;
    branch: string;
    started_at: string;
    slot: number | null;
    last_activity_at: string;
    retry_attempt: { kind: 'failure' | 'continuation'; attempt: number } | null;
    /** watchdog (#105) で再構築した worktree path。recovery / debug 用 */
    workspace_path: string;
    /** watchdog (#105) で metadata.json を読みに行く runlog dir */
    run_log_path: string;
    /** runner subprocess pid (process group leader)。spawn 前 / 取得失敗で null */
    runner_pid: number | null;
    /** active run watchdog (#105) の最新判定。1 度も判定が走っていなければ null */
    watchdog: {
      reasons: Array<'orphaned' | 'stale'>;
      orphaned_since: string | null;
      stale_since: string | null;
    } | null;
  }>;
  totals: {
    runs_completed: number;
    runs_succeeded: number;
    runs_failed: number;
    total_cost_usd: number;
  };
  /**
   * DAG-aware scheduler の最新 evaluation (ADR-0007 / Issue #80)。
   * 1 度も評価が走っていなければ null。
   *
   * 古い (本フィールドを実装していない) serve に対しても dashboard が安全に fall back
   * できるよう、TypeScript 上は optional として扱う。現行 serve は常に key を返す。
   */
  scheduler?: SchedulerStateJson | null;
  /**
   * In-memory retry queue の状態 (ADR-0008 / Issue #84)。
   * `agent.max_retry_attempts == 0` または queue 未注入なら null。
   *
   * 古い serve に対する dashboard / 外部 client の互換のため optional。
   */
  retry_queue?: RetryQueueStateJson | null;
};

export type RetryQueueStateJson = {
  size: number;
  max_attempts: number;
  max_backoff_ms: number;
  entries: Array<{
    kind: 'failure' | 'continuation';
    issue_number: number;
    attempt: number;
    due_at: string;
    scheduled_at: string;
    failure_reason: string | null;
    last_run_id: string;
    last_error_summary: string | null;
    branch: string;
    workspace_path: string;
  }>;
};

export type SchedulerStateJson = {
  last_evaluated_at: string;
  ready: Array<{ issue_number: number; title: string }>;
  blocked: Array<{
    issue_number: number;
    title: string;
    blocked_by: number[];
  }>;
  cycles: Array<{ issue_numbers: number[] }>;
  invalid_dependencies: Array<{
    issue_number: number;
    title: string;
    entries: Array<{
      raw: string;
      issue_number: number | null;
      reason: 'parse_invalid' | 'not_found' | 'forbidden' | 'fetch_error';
      message?: string;
    }>;
  }>;
};

export type IssueSnapshot = {
  issue_number: number;
  running: StateSnapshot['running'][number] | null;
};

export type BuildStateSnapshotDeps = {
  tracker: RunTracker;
  intervalMs: number;
  /**
   * `agent.stall_timeout_ms` の現値 (ms)。snapshot に乗せて dashboard 側で stalled 残時間を
   * 算出させる (#87)。0 / 負値 / 未指定は stall 判定無効として 0 を返す。
   */
  stallTimeoutMs?: number;
  now?: Date;
  /** ADR-0007 の DependencyTracker。未指定なら `scheduler: null` を返す */
  dependencyTracker?: DependencyTracker;
  /** ADR-0008 の RetryQueue。未指定なら `retry_queue: null` を返す */
  retryQueue?: RetryQueue;
  /** retry queue の運用パラメータ (snapshot 表示用) */
  retryConfig?: {
    maxAttempts: number;
    maxBackoffMs: number;
  };
};

export async function buildStateSnapshot(deps: BuildStateSnapshotDeps): Promise<StateSnapshot> {
  const now = deps.now ?? new Date();
  const startedAt = deps.tracker.getStartedAt();
  const startedAtMs = Date.parse(startedAt);
  const uptimeMs = Number.isFinite(startedAtMs) ? Math.max(0, now.getTime() - startedAtMs) : 0;

  const running = deps.tracker.listRunning().map(toRunningJson);
  const totals = totalsToJson(deps.tracker.getTotals());
  const dependencyTracker = deps.dependencyTracker ?? noopDependencyTracker;
  const scheduler = schedulerToJson(dependencyTracker.getSnapshot());
  const retryQueue = retryQueueToJson(deps.retryQueue, deps.retryConfig);

  const stallTimeoutMs =
    deps.stallTimeoutMs !== undefined &&
    Number.isFinite(deps.stallTimeoutMs) &&
    deps.stallTimeoutMs > 0
      ? deps.stallTimeoutMs
      : 0;

  return {
    started_at: startedAt,
    uptime_ms: uptimeMs,
    polling: {
      interval_ms: deps.intervalMs,
      last_tick_at: deps.tracker.getLastPollTickAt(),
    },
    agent: {
      stall_timeout_ms: stallTimeoutMs,
    },
    running,
    totals,
    scheduler,
    retry_queue: retryQueue,
  };
}

function retryQueueToJson(
  queue: RetryQueue | undefined,
  config: BuildStateSnapshotDeps['retryConfig'],
): RetryQueueStateJson | null {
  if (queue === undefined || config === undefined) return null;
  if (config.maxAttempts <= 0) return null;
  return {
    size: queue.size(),
    max_attempts: config.maxAttempts,
    max_backoff_ms: config.maxBackoffMs,
    entries: queue.list().map(toRetryEntryJson),
  };
}

function toRetryEntryJson(entry: RetryEntry): RetryQueueStateJson['entries'][number] {
  return {
    kind: entry.kind,
    issue_number: entry.issueNumber,
    attempt: entry.attempt,
    due_at: entry.dueAt.toISOString(),
    scheduled_at: entry.scheduledAt.toISOString(),
    failure_reason: entry.failureReason,
    last_run_id: entry.lastRunId,
    last_error_summary: entry.lastErrorSummary,
    branch: entry.branch,
    workspace_path: entry.workspacePath,
  };
}

function schedulerToJson(snapshot: SchedulerSnapshot | null): SchedulerStateJson | null {
  if (snapshot === null) return null;
  return {
    last_evaluated_at: snapshot.lastEvaluatedAt,
    ready: snapshot.ready.map((r) => ({ issue_number: r.issueNumber, title: r.title })),
    blocked: snapshot.blocked.map((b) => ({
      issue_number: b.issueNumber,
      title: b.title,
      blocked_by: [...b.blockedBy],
    })),
    cycles: snapshot.cycles.map((c) => ({ issue_numbers: [...c.issueNumbers] })),
    invalid_dependencies: snapshot.invalidDependencies.map((d) => ({
      issue_number: d.issueNumber,
      title: d.title,
      entries: d.entries.map((e) => ({
        raw: e.raw,
        issue_number: e.issueNumber,
        reason: e.reason,
        ...(e.message !== undefined ? { message: e.message } : {}),
      })),
    })),
  };
}

export type BuildIssueSnapshotDeps = {
  issueNumber: number;
  tracker: RunTracker;
};

export async function buildIssueSnapshot(deps: BuildIssueSnapshotDeps): Promise<IssueSnapshot> {
  const running = deps.tracker.getRunningByIssue(deps.issueNumber);
  return {
    issue_number: deps.issueNumber,
    running: running === null ? null : toRunningJson(running),
  };
}

function toRunningJson(entry: RunningEntry): StateSnapshot['running'][number] {
  return {
    run_id: entry.runId,
    issue_number: entry.issueNumber,
    branch: entry.branch,
    started_at: entry.startedAt,
    slot: entry.slot,
    last_activity_at: entry.lastActivityAt,
    retry_attempt: entry.retryAttempt === null ? null : { ...entry.retryAttempt },
    workspace_path: entry.workspacePath,
    run_log_path: entry.runLogPath,
    runner_pid: entry.runnerPid,
    watchdog:
      entry.watchdog === null
        ? null
        : {
            reasons: [...entry.watchdog.reasons],
            orphaned_since: entry.watchdog.orphanedSince,
            stale_since: entry.watchdog.staleSince,
          },
  };
}

function totalsToJson(totals: Totals): StateSnapshot['totals'] {
  return {
    runs_completed: totals.runsCompleted,
    runs_succeeded: totals.runsSucceeded,
    runs_failed: totals.runsFailed,
    total_cost_usd: totals.totalCostUsd,
  };
}
