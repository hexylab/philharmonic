import type { FailureReason } from './errors.js';

/**
 * `philharmonic serve` の in-memory retry queue。
 *
 * - daemon プロセス起動以降の retry 待機状態のみを保持する (再起動で消える)
 * - 同一 `issueNumber` は 1 件しか保持しない (Map で dedup)
 * - 永続化 / Status 書き戻しは行わない (ADR-0008 §3)
 *
 * spec: docs/specs/retry-queue.md
 * adr: docs/adr/0008-in-memory-retry-queue.md
 */

const BASE_DELAY_MS = 10_000;
const ERROR_SUMMARY_MAX_LEN = 500;

export type RetryEntry = {
  readonly issueNumber: number;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly branch: string;
  readonly workspacePath: string;
  /** 1-indexed retry attempt 番号 (= 直前に失敗した attempt) */
  readonly attempt: number;
  readonly dueAt: Date;
  readonly scheduledAt: Date;
  readonly failureReason: FailureReason;
  readonly lastRunId: string;
  readonly lastErrorSummary: string | null;
};

export type ScheduleInput = {
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  /** schedule する attempt 番号 (1-indexed)。1 未満は 1 に clamp する */
  attempt: number;
  failureReason: FailureReason;
  lastRunId: string;
  lastErrorSummary: string | null;
  now: Date;
  maxBackoffMs: number;
};

export type RescheduleInput = {
  issueNumber: number;
  delayMs: number;
  now: Date;
};

export type RetryQueue = {
  schedule(input: ScheduleInput): RetryEntry;
  drainDue(now: Date): RetryEntry[];
  remove(issueNumber: number): boolean;
  reschedule(input: RescheduleInput): RetryEntry | null;
  /** dueAt 昇順 (同時刻なら issueNumber 昇順) */
  list(): readonly RetryEntry[];
  size(): number;
};

/**
 * `attempt = 1, 2, 3...` に対する backoff (ms) を計算する純粋関数。
 *
 * `min(10_000 * 2^(attempt - 1), maxBackoffMs)`。Symphony と同じ式。
 */
export function computeRetryDelayMs(attempt: number, maxBackoffMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = BASE_DELAY_MS * Math.pow(2, safeAttempt - 1);
  return Math.min(base, maxBackoffMs);
}

export function createRetryQueue(): RetryQueue {
  const entries = new Map<number, RetryEntry>();

  return {
    schedule(input) {
      const attempt = Math.max(1, Math.floor(input.attempt));
      const delayMs = computeRetryDelayMs(attempt, input.maxBackoffMs);
      const dueAt = new Date(input.now.getTime() + delayMs);
      const entry: RetryEntry = {
        issueNumber: input.issueNumber,
        repository: { owner: input.repository.owner, name: input.repository.name },
        branch: input.branch,
        workspacePath: input.workspacePath,
        attempt,
        dueAt,
        scheduledAt: input.now,
        failureReason: input.failureReason,
        lastRunId: input.lastRunId,
        lastErrorSummary: truncateSummary(input.lastErrorSummary),
      };
      entries.set(input.issueNumber, entry);
      return entry;
    },
    drainDue(now) {
      const due: RetryEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.dueAt.getTime() <= now.getTime()) due.push(entry);
      }
      due.sort(compareEntries);
      for (const entry of due) entries.delete(entry.issueNumber);
      return due;
    },
    remove(issueNumber) {
      return entries.delete(issueNumber);
    },
    reschedule(input) {
      const existing = entries.get(input.issueNumber);
      if (existing === undefined) return null;
      const dueAt = new Date(input.now.getTime() + Math.max(0, input.delayMs));
      const updated: RetryEntry = { ...existing, dueAt };
      entries.set(input.issueNumber, updated);
      return updated;
    },
    list() {
      return Array.from(entries.values()).sort(compareEntries);
    },
    size() {
      return entries.size;
    },
  };
}

function compareEntries(a: RetryEntry, b: RetryEntry): number {
  const ta = a.dueAt.getTime();
  const tb = b.dueAt.getTime();
  if (ta !== tb) return ta - tb;
  return a.issueNumber - b.issueNumber;
}

function truncateSummary(summary: string | null): string | null {
  if (summary === null) return null;
  if (summary.length <= ERROR_SUMMARY_MAX_LEN) return summary;
  return summary.slice(0, ERROR_SUMMARY_MAX_LEN);
}
