import type { FailureReason } from '../orchestrator/errors.js';

/**
 * `philharmonic serve` の in-memory run tracker。
 *
 * - `runStarted` で in-flight に積み、`runFinished` で外す & totals を更新する
 * - daemon プロセス起動以降の累計のみを保持する (再起動で消える)
 * - HTTP API (#30) 専用。ログや永続化には関与しない
 *
 * spec: docs/specs/snapshot-api.md
 */

export type RunningEntry = {
  runId: string;
  issueNumber: number;
  branch: string;
  startedAt: string;
  slot: number | null;
};

export type Totals = {
  runsCompleted: number;
  runsSucceeded: number;
  runsFailed: number;
  totalCostUsd: number;
};

export type RunStartedInput = {
  runId: string;
  issueNumber: number;
  branch: string;
  startedAt: Date;
  slot?: number | null;
};

export type RunFinishedSuccess = {
  kind: 'success';
  runId: string;
  issueNumber: number;
  totalCostUsd: number | null;
};

export type RunFinishedFailed = {
  kind: 'failed';
  runId: string;
  issueNumber: number;
  reason: FailureReason;
  totalCostUsd: number | null;
};

export type RunFinishedInput = RunFinishedSuccess | RunFinishedFailed;

export type RunTracker = {
  runStarted(input: RunStartedInput): void;
  runFinished(input: RunFinishedInput): void;
  listRunning(): RunningEntry[];
  getRunningByIssue(issueNumber: number): RunningEntry | null;
  getTotals(): Totals;
  recordPollTick(at: Date): void;
  getLastPollTickAt(): string | null;
  getStartedAt(): string;
};

export type CreateRunTrackerOptions = {
  startedAt?: Date;
};

export function createRunTracker(options: CreateRunTrackerOptions = {}): RunTracker {
  const startedAt = (options.startedAt ?? new Date()).toISOString();
  const running = new Map<string, RunningEntry>();
  const totals: Totals = {
    runsCompleted: 0,
    runsSucceeded: 0,
    runsFailed: 0,
    totalCostUsd: 0,
  };
  let lastPollTickAt: string | null = null;

  return {
    runStarted(input) {
      running.set(input.runId, {
        runId: input.runId,
        issueNumber: input.issueNumber,
        branch: input.branch,
        startedAt: input.startedAt.toISOString(),
        slot: input.slot ?? null,
      });
    },
    runFinished(input) {
      if (!running.has(input.runId)) {
        // 防御的: 既に runFinished 済み (markFailed 経路 + finally の二重発火等) は no-op
        return;
      }
      running.delete(input.runId);
      totals.runsCompleted += 1;
      if (input.kind === 'success') totals.runsSucceeded += 1;
      else totals.runsFailed += 1;
      if (typeof input.totalCostUsd === 'number' && Number.isFinite(input.totalCostUsd)) {
        totals.totalCostUsd += input.totalCostUsd;
      }
    },
    listRunning() {
      return Array.from(running.values()).sort((a, b) => a.issueNumber - b.issueNumber);
    },
    getRunningByIssue(issueNumber) {
      for (const entry of running.values()) {
        if (entry.issueNumber === issueNumber) return entry;
      }
      return null;
    },
    getTotals() {
      return { ...totals };
    },
    recordPollTick(at) {
      lastPollTickAt = at.toISOString();
    },
    getLastPollTickAt() {
      return lastPollTickAt;
    },
    getStartedAt() {
      return startedAt;
    },
  };
}

export const noopRunTracker: RunTracker = {
  runStarted: () => {},
  runFinished: () => {},
  listRunning: () => [],
  getRunningByIssue: () => null,
  getTotals: () => ({
    runsCompleted: 0,
    runsSucceeded: 0,
    runsFailed: 0,
    totalCostUsd: 0,
  }),
  recordPollTick: () => {},
  getLastPollTickAt: () => null,
  getStartedAt: () => new Date(0).toISOString(),
};
