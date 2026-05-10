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
  running: Array<{
    run_id: string;
    issue_number: number;
    branch: string;
    started_at: string;
    slot: number | null;
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
  now?: Date;
  /** ADR-0007 の DependencyTracker。未指定なら `scheduler: null` を返す */
  dependencyTracker?: DependencyTracker;
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

  return {
    started_at: startedAt,
    uptime_ms: uptimeMs,
    polling: {
      interval_ms: deps.intervalMs,
      last_tick_at: deps.tracker.getLastPollTickAt(),
    },
    running,
    totals,
    scheduler,
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
