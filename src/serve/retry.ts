import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger/index.js';
import type { FailureReason } from '../orchestrator/errors.js';

/**
 * `philharmonic serve` の自動 retry スケジューラ。
 *
 * - 失敗した Project Item の attempt 数と次回実行時刻 (`nextAttemptAt`) を保持する
 * - backoff は Symphony 準拠の `min(10s × 2^(attempt-1), max_retry_backoff_ms)`
 * - 上限超過時は state から削除し、Status は `Failed` のまま (人間判断に委ねる)
 *
 * spec: docs/specs/serve-daemon.md#自動-retry-22
 */

export const RETRY_STATE_VERSION = 1;
export const DEFAULT_RETRY_STATE_RELATIVE = '.philharmonic/retry-state.json';
export const RETRY_BASE_INTERVAL_MS = 10_000;

export type RetryEntry = {
  attempts: number;
  lastFailedAt: string;
  nextAttemptAt: string;
  lastReason: FailureReason;
};

export type RetryState = {
  version: typeof RETRY_STATE_VERSION;
  issues: Record<string, RetryEntry>;
};

export type RetryStorage = {
  load(): Promise<RetryState>;
  save(state: RetryState): Promise<void>;
};

export type RetryDecision =
  | {
      kind: 'scheduled';
      attempts: number;
      backoffMs: number;
      nextAttemptAt: Date;
    }
  | {
      kind: 'gave_up';
      attempts: number;
    }
  | {
      kind: 'disabled';
    };

export type RetryReadyEntry = {
  issueNumber: number;
  attempts: number;
};

export type RetryScheduler = {
  recordFailure(input: {
    issueNumber: number;
    reason: FailureReason;
    now: Date;
  }): Promise<RetryDecision>;
  recordSuccess(issueNumber: number): Promise<void>;
  pickReady(now: Date): Promise<RetryReadyEntry[]>;
  /**
   * 指定 Issue の過去 Failed 試行回数を返す (state にエントリが無ければ 0)。
   * テンプレート変数 `attempt` の解決 (#27) に利用する。
   */
  getAttempts(issueNumber: number): Promise<number>;
};

export type CreateRetrySchedulerOptions = {
  storage: RetryStorage;
  maxAttempts: number;
  maxBackoffMs: number;
};

export function createEmptyRetryState(): RetryState {
  return { version: RETRY_STATE_VERSION, issues: {} };
}

/**
 * Symphony 準拠の exponential backoff 計算。
 *
 * `attempt` は「これから走らせる retry の番号」であり 1 始まり。
 * - attempt = 1 → 10s
 * - attempt = 2 → 20s
 * - attempt = 3 → 40s
 * - ... `maxBackoffMs` でクリップ
 *
 * 大きな `attempt` で `2^(attempt-1)` がオーバーフローしないように、指数を 30 でクリップしてから
 * `Math.min(base, maxBackoffMs)` を適用する (どちらにせよ max でクリップされるため挙動は同等)。
 */
export function computeRetryBackoffMs(attempt: number, maxBackoffMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs <= 0) {
    throw new Error(`maxBackoffMs must be a positive integer, got ${maxBackoffMs}`);
  }
  const exponent = Math.min(attempt - 1, 30);
  const base = RETRY_BASE_INTERVAL_MS * 2 ** exponent;
  return Math.min(base, maxBackoffMs);
}

export function createRetryScheduler(options: CreateRetrySchedulerOptions): RetryScheduler {
  const { storage, maxAttempts, maxBackoffMs } = options;

  return {
    async recordFailure(input) {
      if (maxAttempts === 0) {
        // retry 無効化。state は触らず Failed のままにする。
        return { kind: 'disabled' };
      }
      const state = await storage.load();
      const key = String(input.issueNumber);
      const previous = state.issues[key]?.attempts ?? 0;
      const nextAttempts = previous + 1;

      if (nextAttempts > maxAttempts) {
        delete state.issues[key];
        await storage.save(state);
        return { kind: 'gave_up', attempts: previous };
      }

      const backoffMs = computeRetryBackoffMs(nextAttempts, maxBackoffMs);
      const nextAttemptAt = new Date(input.now.getTime() + backoffMs);
      state.issues[key] = {
        attempts: nextAttempts,
        lastFailedAt: input.now.toISOString(),
        nextAttemptAt: nextAttemptAt.toISOString(),
        lastReason: input.reason,
      };
      await storage.save(state);
      return {
        kind: 'scheduled',
        attempts: nextAttempts,
        backoffMs,
        nextAttemptAt,
      };
    },
    async recordSuccess(issueNumber) {
      const state = await storage.load();
      const key = String(issueNumber);
      if (!(key in state.issues)) return;
      delete state.issues[key];
      await storage.save(state);
    },
    async pickReady(now) {
      const state = await storage.load();
      const ready: RetryReadyEntry[] = [];
      for (const [key, entry] of Object.entries(state.issues)) {
        if (entry.attempts > maxAttempts) continue;
        const due = Date.parse(entry.nextAttemptAt);
        if (Number.isNaN(due)) continue;
        if (due <= now.getTime()) {
          ready.push({ issueNumber: Number(key), attempts: entry.attempts });
        }
      }
      return ready;
    },
    async getAttempts(issueNumber) {
      const state = await storage.load();
      return state.issues[String(issueNumber)]?.attempts ?? 0;
    },
  };
}

export type CreateFileRetryStorageOptions = {
  filePath: string;
  logger?: Logger;
};

/**
 * JSON ファイルを source of truth とする retry state storage。
 *
 * - load: 不在 / parse 不能 → warn ログを出して空 state を返す (lock の stale 判定と同じ哲学)
 * - save: tmp file に書いて rename で atomic 置換
 */
export function createFileRetryStorage(options: CreateFileRetryStorageOptions): RetryStorage {
  const { filePath, logger } = options;
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isErrno(error) && error.code === 'ENOENT') {
          return createEmptyRetryState();
        }
        throw error;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const validated = validateRetryState(parsed);
        if (validated !== null) return validated;
      } catch (error) {
        logger?.warn('retry-state file の JSON parse に失敗したため空 state にリセットします', {
          filePath,
          error: describeError(error),
        });
        return createEmptyRetryState();
      }
      logger?.warn('retry-state file の構造が不正なため空 state にリセットします', { filePath });
      return createEmptyRetryState();
    },
    async save(state) {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      const payload = `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(tmpPath, payload, 'utf8');
      await rename(tmpPath, filePath);
    },
  };
}

function validateRetryState(value: unknown): RetryState | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as { version?: unknown; issues?: unknown };
  if (obj.version !== RETRY_STATE_VERSION) return null;
  if (typeof obj.issues !== 'object' || obj.issues === null) return null;
  const issues: Record<string, RetryEntry> = {};
  for (const [key, raw] of Object.entries(obj.issues as Record<string, unknown>)) {
    const entry = validateRetryEntry(raw);
    if (entry === null) return null;
    issues[key] = entry;
  }
  return { version: RETRY_STATE_VERSION, issues };
}

function validateRetryEntry(value: unknown): RetryEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as {
    attempts?: unknown;
    lastFailedAt?: unknown;
    nextAttemptAt?: unknown;
    lastReason?: unknown;
  };
  if (
    typeof obj.attempts !== 'number' ||
    !Number.isInteger(obj.attempts) ||
    obj.attempts < 1 ||
    typeof obj.lastFailedAt !== 'string' ||
    typeof obj.nextAttemptAt !== 'string' ||
    typeof obj.lastReason !== 'string'
  ) {
    return null;
  }
  return {
    attempts: obj.attempts,
    lastFailedAt: obj.lastFailedAt,
    nextAttemptAt: obj.nextAttemptAt,
    lastReason: obj.lastReason as FailureReason,
  };
}

function isErrno(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
