import type { RetryScheduler, RetryStateEntry } from '../serve/index.js';

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
  running: Array<{
    run_id: string;
    issue_number: number;
    branch: string;
    started_at: string;
    slot: number | null;
  }>;
  retrying: Array<{
    issue_number: number;
    attempts: number;
    last_failed_at: string;
    next_attempt_at: string;
    last_reason: string;
  }>;
  totals: {
    runs_completed: number;
    runs_succeeded: number;
    runs_failed: number;
    total_cost_usd: number;
  };
};

export type IssueSnapshot = {
  issue_number: number;
  running: StateSnapshot['running'][number] | null;
  retrying: StateSnapshot['retrying'][number] | null;
};

export type BuildStateSnapshotDeps = {
  tracker: RunTracker;
  scheduler: RetryScheduler;
  intervalMs: number;
  now?: Date;
};

export async function buildStateSnapshot(deps: BuildStateSnapshotDeps): Promise<StateSnapshot> {
  const now = deps.now ?? new Date();
  const startedAt = deps.tracker.getStartedAt();
  const startedAtMs = Date.parse(startedAt);
  const uptimeMs = Number.isFinite(startedAtMs) ? Math.max(0, now.getTime() - startedAtMs) : 0;

  const running = deps.tracker.listRunning().map(toRunningJson);
  const retryEntries = await deps.scheduler.listEntries();
  const retrying = retryEntries
    .slice()
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .map(toRetryingJson);
  const totals = totalsToJson(deps.tracker.getTotals());

  return {
    started_at: startedAt,
    uptime_ms: uptimeMs,
    polling: {
      interval_ms: deps.intervalMs,
      last_tick_at: deps.tracker.getLastPollTickAt(),
    },
    running,
    retrying,
    totals,
  };
}

export type BuildIssueSnapshotDeps = {
  issueNumber: number;
  tracker: RunTracker;
  scheduler: RetryScheduler;
};

export async function buildIssueSnapshot(deps: BuildIssueSnapshotDeps): Promise<IssueSnapshot> {
  const running = deps.tracker.getRunningByIssue(deps.issueNumber);
  const retry = await deps.scheduler.getEntry(deps.issueNumber);
  return {
    issue_number: deps.issueNumber,
    running: running === null ? null : toRunningJson(running),
    retrying: retry === null ? null : toRetryingJson(retry),
  };
}

function toRunningJson(entry: RunningEntry): StateSnapshot['running'][number] {
  return {
    run_id: entry.runId,
    issue_number: entry.issueNumber,
    branch: entry.branch,
    started_at: entry.startedAt,
    slot: entry.slot,
  };
}

function toRetryingJson(entry: RetryStateEntry): StateSnapshot['retrying'][number] {
  return {
    issue_number: entry.issueNumber,
    attempts: entry.attempts,
    last_failed_at: entry.lastFailedAt,
    next_attempt_at: entry.nextAttemptAt,
    last_reason: entry.lastReason,
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
