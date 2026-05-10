import type { FailureReason } from './errors.js';
import type { RetryQueueStore } from './retry-queue-store.js';

/**
 * `philharmonic serve` の retry queue。
 *
 * - daemon プロセス内の in-memory state を SoT としつつ、`store` 注入時は mutation のたびに
 *   local state file へ永続化する (ADR-0011 / Issue #104)
 * - 同一 `issueNumber` は 1 件しか保持しない (Map で dedup; kind 違いも上書き)
 * - kind=`failure` (ADR-0008) と kind=`continuation` (ADR-0009) を 1 本の queue で扱う
 *
 * spec: docs/specs/retry-queue.md
 * adr: docs/adr/0008-in-memory-retry-queue.md, docs/adr/0009-continuation-retry-after-success.md, docs/adr/0011-persist-retry-queue-across-restart.md
 */

const BASE_DELAY_MS = 10_000;
const ERROR_SUMMARY_MAX_LEN = 500;

/** continuation retry の固定 delay (ADR-0009 §3)。指数バックオフは使わない。 */
export const CONTINUATION_RETRY_DELAY_MS = 10_000;

export type RetryKind = 'failure' | 'continuation';

export type RetryEntry = {
  readonly kind: RetryKind;
  readonly issueNumber: number;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly branch: string;
  readonly workspacePath: string;
  /** 1-indexed retry attempt 番号 (kind 内で独立にカウント) */
  readonly attempt: number;
  readonly dueAt: Date;
  readonly scheduledAt: Date;
  /** kind=`continuation` のとき null */
  readonly failureReason: FailureReason | null;
  readonly lastRunId: string;
  /** kind=`continuation` のとき null */
  readonly lastErrorSummary: string | null;
};

export type ScheduleInput = {
  kind: RetryKind;
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  /** schedule する attempt 番号 (1-indexed)。1 未満は 1 に clamp する */
  attempt: number;
  /** kind=`continuation` のときは null を渡す */
  failureReason: FailureReason | null;
  lastRunId: string;
  lastErrorSummary: string | null;
  now: Date;
  /** kind=`failure` の backoff clamp 上限。kind=`continuation` では無視 (固定 delay) */
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
  /** dispatch ガード用: 該当 Issue が queue に居るかどうか (kind 問わず)。 */
  has(issueNumber: number): boolean;
  reschedule(input: RescheduleInput): RetryEntry | null;
  /** dueAt 昇順 (同時刻なら issueNumber 昇順) */
  list(): readonly RetryEntry[];
  size(): number;
};

/**
 * `attempt = 1, 2, 3...` に対する failure retry の backoff (ms) を計算する純粋関数。
 *
 * `min(10_000 * 2^(attempt - 1), maxBackoffMs)`。Symphony と同じ式。
 */
export function computeRetryDelayMs(attempt: number, maxBackoffMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = BASE_DELAY_MS * Math.pow(2, safeAttempt - 1);
  return Math.min(base, maxBackoffMs);
}

export type CreateRetryQueueOptions = {
  /**
   * 永続化 store。`schedule` / `remove` / `drainDue` / `reschedule` が成功するたび、現 in-memory
   * snapshot を `store.save()` で書き出す。並列 save は store 側で直列化されるため呼び出し側は
   * 同期的に mutation を続けてよい。未指定なら in-memory only (= ADR-0008 の旧挙動互換)。
   */
  store?: RetryQueueStore;
  /**
   * 起動時に store から復元した entry。`createRetryQueue` 内で Map に投入し、初期 save は走らない
   * (= ファイルとメモリは既に一致している前提)。
   */
  initialEntries?: readonly RetryEntry[];
};

export function createRetryQueue(options: CreateRetryQueueOptions = {}): RetryQueue {
  const entries = new Map<number, RetryEntry>();
  if (options.initialEntries !== undefined) {
    for (const entry of options.initialEntries) {
      entries.set(entry.issueNumber, entry);
    }
  }

  const persist = (): void => {
    if (options.store === undefined) return;
    // 戻り値は捨てる: save は store 側で直列化済み、失敗時は store 内部で warn ログを出す
    void options.store.save(Array.from(entries.values()).sort(compareEntries));
  };

  return {
    schedule(input) {
      const attempt = Math.max(1, Math.floor(input.attempt));
      const delayMs =
        input.kind === 'continuation'
          ? CONTINUATION_RETRY_DELAY_MS
          : computeRetryDelayMs(attempt, input.maxBackoffMs);
      const dueAt = new Date(input.now.getTime() + delayMs);
      const failureReason = input.kind === 'continuation' ? null : input.failureReason;
      const lastErrorSummary =
        input.kind === 'continuation' ? null : truncateSummary(input.lastErrorSummary);
      const entry: RetryEntry = {
        kind: input.kind,
        issueNumber: input.issueNumber,
        repository: { owner: input.repository.owner, name: input.repository.name },
        branch: input.branch,
        workspacePath: input.workspacePath,
        attempt,
        dueAt,
        scheduledAt: input.now,
        failureReason,
        lastRunId: input.lastRunId,
        lastErrorSummary,
      };
      entries.set(input.issueNumber, entry);
      persist();
      return entry;
    },
    drainDue(now) {
      const due: RetryEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.dueAt.getTime() <= now.getTime()) due.push(entry);
      }
      due.sort(compareEntries);
      for (const entry of due) entries.delete(entry.issueNumber);
      if (due.length > 0) persist();
      return due;
    },
    remove(issueNumber) {
      const removed = entries.delete(issueNumber);
      if (removed) persist();
      return removed;
    },
    has(issueNumber) {
      return entries.has(issueNumber);
    },
    reschedule(input) {
      const existing = entries.get(input.issueNumber);
      if (existing === undefined) return null;
      const dueAt = new Date(input.now.getTime() + Math.max(0, input.delayMs));
      const updated: RetryEntry = { ...existing, dueAt };
      entries.set(input.issueNumber, updated);
      persist();
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
