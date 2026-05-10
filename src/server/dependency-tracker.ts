import type { EvaluatedCandidate, InvalidDependencyDetail } from '../dependency/index.js';

/**
 * `philharmonic serve` の in-memory dependency / scheduler tracker (ADR-0007 split 5)。
 *
 * - candidate selection (`selectAcceptableCandidates`) が `evaluateDependencyDag` を呼んだ
 *   直後に **per-tick で 1 度だけ** `recordEvaluation` でまるごと差し替える
 * - `getSnapshot()` は最新の評価結果のみを返す。1 度も評価していなければ `null`
 * - HTTP API (#80) 専用。GitHub API は叩かない / persistence もしない
 *
 * spec: docs/specs/snapshot-api.md
 */

export type SchedulerInvalidEntry = {
  readonly raw: string;
  readonly issueNumber: number | null;
  readonly reason: InvalidDependencyDetail['reason'];
  readonly message?: string;
};

export type SchedulerReadyEntry = {
  readonly issueNumber: number;
  readonly title: string;
};

export type SchedulerBlockedEntry = {
  readonly issueNumber: number;
  readonly title: string;
  readonly blockedBy: readonly number[];
};

export type SchedulerCycleEntry = {
  readonly issueNumbers: readonly number[];
};

export type SchedulerInvalidCandidate = {
  readonly issueNumber: number;
  readonly title: string;
  readonly entries: readonly SchedulerInvalidEntry[];
};

export type SchedulerSnapshot = {
  readonly lastEvaluatedAt: string;
  readonly ready: readonly SchedulerReadyEntry[];
  readonly blocked: readonly SchedulerBlockedEntry[];
  readonly cycles: readonly SchedulerCycleEntry[];
  readonly invalidDependencies: readonly SchedulerInvalidCandidate[];
};

export type RecordEvaluationInput = {
  readonly evaluations: readonly EvaluatedCandidate[];
  readonly at: Date;
};

export type DependencyTracker = {
  recordEvaluation(input: RecordEvaluationInput): void;
  getSnapshot(): SchedulerSnapshot | null;
};

export function createDependencyTracker(): DependencyTracker {
  let snapshot: SchedulerSnapshot | null = null;
  return {
    recordEvaluation(input) {
      snapshot = buildSnapshot(input);
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

export const noopDependencyTracker: DependencyTracker = {
  recordEvaluation: () => {},
  getSnapshot: () => null,
};

function buildSnapshot(input: RecordEvaluationInput): SchedulerSnapshot {
  const ready: SchedulerReadyEntry[] = [];
  const blocked: SchedulerBlockedEntry[] = [];
  const invalidDependencies: SchedulerInvalidCandidate[] = [];
  const cycleByKey = new Map<string, SchedulerCycleEntry>();

  for (const evaluation of input.evaluations) {
    const candidate = evaluation.candidate;
    switch (evaluation.state) {
      case 'ready':
        ready.push({
          issueNumber: candidate.issueNumber,
          title: candidate.issueTitle,
        });
        break;
      case 'blocked':
        blocked.push({
          issueNumber: candidate.issueNumber,
          title: candidate.issueTitle,
          blockedBy: [...evaluation.blockingIssueNumbers],
        });
        break;
      case 'invalid_dependency':
        invalidDependencies.push({
          issueNumber: candidate.issueNumber,
          title: candidate.issueTitle,
          entries: evaluation.invalidEntries.map((d) => ({
            raw: d.raw,
            issueNumber: d.issueNumber,
            reason: d.reason,
            ...(d.message !== undefined ? { message: d.message } : {}),
          })),
        });
        break;
      case 'cycle': {
        const sorted = [...evaluation.cycleIssueNumbers].sort((a, b) => a - b);
        const key = sorted.join(',');
        if (!cycleByKey.has(key)) {
          cycleByKey.set(key, { issueNumbers: sorted });
        }
        break;
      }
    }
  }

  return {
    lastEvaluatedAt: input.at.toISOString(),
    ready,
    blocked,
    cycles: [...cycleByKey.values()],
    invalidDependencies,
  };
}
