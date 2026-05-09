import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeRetryBackoffMs,
  createEmptyRetryState,
  createFileRetryStorage,
  createRetryScheduler,
  RETRY_BASE_INTERVAL_MS,
  RETRY_STATE_VERSION,
  type RetryState,
  type RetryStorage,
} from '../../src/serve/index.js';

function makeMemoryStorage(initial?: RetryState): RetryStorage {
  let state: RetryState = initial ?? createEmptyRetryState();
  return {
    async load() {
      return JSON.parse(JSON.stringify(state)) as RetryState;
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next)) as RetryState;
    },
  };
}

describe('computeRetryBackoffMs', () => {
  it('attempt = 1 で 10 秒を返す', () => {
    expect(computeRetryBackoffMs(1, 600_000)).toBe(10_000);
  });

  it('attempt 増加で指数的に増えていく (10s → 20s → 40s → 80s)', () => {
    expect(computeRetryBackoffMs(1, 600_000)).toBe(10_000);
    expect(computeRetryBackoffMs(2, 600_000)).toBe(20_000);
    expect(computeRetryBackoffMs(3, 600_000)).toBe(40_000);
    expect(computeRetryBackoffMs(4, 600_000)).toBe(80_000);
  });

  it('maxBackoffMs を超えるとクリップされる', () => {
    // 10s * 2^6 = 640s = 640_000ms > 600_000ms (10 分)
    expect(computeRetryBackoffMs(7, 600_000)).toBe(600_000);
    // attempt が極端に大きくても max を超えない
    expect(computeRetryBackoffMs(20, 600_000)).toBe(600_000);
  });

  it('maxBackoffMs が小さいときは初回から既にクリップされる', () => {
    // attempt 1 の base = 10_000ms > 5_000ms
    expect(computeRetryBackoffMs(1, 5_000)).toBe(5_000);
  });

  it('attempt が極端に大きくても Infinity / NaN にならない (オーバーフロー耐性)', () => {
    const result = computeRetryBackoffMs(1_000, 600_000);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(600_000);
  });

  it('attempt が 1 未満だと throw する', () => {
    expect(() => computeRetryBackoffMs(0, 600_000)).toThrow();
    expect(() => computeRetryBackoffMs(-1, 600_000)).toThrow();
    expect(() => computeRetryBackoffMs(1.5, 600_000)).toThrow();
  });

  it('maxBackoffMs が 0 以下だと throw する', () => {
    expect(() => computeRetryBackoffMs(1, 0)).toThrow();
    expect(() => computeRetryBackoffMs(1, -1)).toThrow();
  });

  it('RETRY_BASE_INTERVAL_MS が 10s であることを確認', () => {
    expect(RETRY_BASE_INTERVAL_MS).toBe(10_000);
  });
});

describe('createRetryScheduler', () => {
  const NOW = new Date('2026-05-09T00:00:00.000Z');

  it('初回失敗で attempts: 1 / nextAttemptAt = now + 10s で scheduled を返す', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });

    const decision = await scheduler.recordFailure({
      issueNumber: 42,
      reason: 'runner_error',
      now: NOW,
    });

    expect(decision).toEqual({
      kind: 'scheduled',
      attempts: 1,
      backoffMs: 10_000,
      nextAttemptAt: new Date(NOW.getTime() + 10_000),
    });

    const state = await storage.load();
    expect(state.issues['42']).toEqual({
      attempts: 1,
      lastFailedAt: NOW.toISOString(),
      nextAttemptAt: new Date(NOW.getTime() + 10_000).toISOString(),
      lastReason: 'runner_error',
    });
  });

  it('再失敗で attempts がインクリメントされ backoff が伸びる', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });

    await scheduler.recordFailure({ issueNumber: 7, reason: 'runner_error', now: NOW });
    const second = await scheduler.recordFailure({
      issueNumber: 7,
      reason: 'no_changes',
      now: new Date(NOW.getTime() + 10_000),
    });

    expect(second).toEqual({
      kind: 'scheduled',
      attempts: 2,
      backoffMs: 20_000,
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    const state = await storage.load();
    expect(state.issues['7']?.attempts).toBe(2);
    expect(state.issues['7']?.lastReason).toBe('no_changes');
  });

  it('上限超過 (attempts > maxAttempts) で gave_up を返し state から削除する', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 2, maxBackoffMs: 600_000 });

    await scheduler.recordFailure({ issueNumber: 1, reason: 'runner_error', now: NOW });
    await scheduler.recordFailure({ issueNumber: 1, reason: 'runner_error', now: NOW });
    const third = await scheduler.recordFailure({
      issueNumber: 1,
      reason: 'runner_error',
      now: NOW,
    });

    expect(third).toEqual({ kind: 'gave_up', attempts: 2 });
    const state = await storage.load();
    expect(state.issues['1']).toBeUndefined();
  });

  it('maxAttempts: 0 だと disabled を返し state を変更しない (retry 無効化)', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 0, maxBackoffMs: 600_000 });

    const decision = await scheduler.recordFailure({
      issueNumber: 5,
      reason: 'runner_error',
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'disabled' });
    const state = await storage.load();
    expect(state.issues).toEqual({});
  });

  it('recordSuccess で対応 issue の state が削除される', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });

    await scheduler.recordFailure({ issueNumber: 9, reason: 'runner_error', now: NOW });
    expect((await storage.load()).issues['9']).toBeDefined();
    await scheduler.recordSuccess(9);
    expect((await storage.load()).issues['9']).toBeUndefined();
  });

  it('recordSuccess は state に存在しない issue でも失敗しない (no-op)', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });

    await expect(scheduler.recordSuccess(123)).resolves.toBeUndefined();
  });

  it('pickReady は nextAttemptAt 到達済みのみ返す', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });

    // issue 10: 既に 1 回失敗 (nextAttemptAt = now + 10s)
    await scheduler.recordFailure({ issueNumber: 10, reason: 'runner_error', now: NOW });
    // issue 20: 既に 2 回失敗 (nextAttemptAt = NOW + 5s + 20s = NOW + 25s)
    await scheduler.recordFailure({
      issueNumber: 20,
      reason: 'runner_error',
      now: new Date(NOW.getTime() - 30_000),
    });
    await scheduler.recordFailure({
      issueNumber: 20,
      reason: 'runner_error',
      now: new Date(NOW.getTime() - 20_000),
    });

    // NOW 時点で issue 10 は未到達 (NOW + 10s が next), issue 20 は到達済み (NOW + 0s が next)
    const ready = await scheduler.pickReady(NOW);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toEqual({ issueNumber: 20, attempts: 2 });

    // NOW + 11s なら 2 件とも到達
    const ready2 = await scheduler.pickReady(new Date(NOW.getTime() + 11_000));
    const issueNumbers = ready2.map((r) => r.issueNumber).sort();
    expect(issueNumbers).toEqual([10, 20]);
  });

  it('pickReady は state を変更しない', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });
    await scheduler.recordFailure({ issueNumber: 10, reason: 'runner_error', now: NOW });
    const before = await storage.load();
    await scheduler.pickReady(new Date(NOW.getTime() + 1_000_000));
    const after = await storage.load();
    expect(after).toEqual(before);
  });
});

describe('createFileRetryStorage', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'phil-retry-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ファイル不在時は空 state を返す', async () => {
    const storage = createFileRetryStorage({ filePath: path.join(tmp, 'retry-state.json') });
    const state = await storage.load();
    expect(state).toEqual({ version: RETRY_STATE_VERSION, issues: {} });
  });

  it('save → load で state が往復できる', async () => {
    const filePath = path.join(tmp, 'sub', 'retry-state.json');
    const storage = createFileRetryStorage({ filePath });

    const next: RetryState = {
      version: RETRY_STATE_VERSION,
      issues: {
        '7': {
          attempts: 1,
          lastFailedAt: '2026-05-09T00:00:00.000Z',
          nextAttemptAt: '2026-05-09T00:00:10.000Z',
          lastReason: 'runner_error',
        },
      },
    };
    await storage.save(next);
    const loaded = await storage.load();
    expect(loaded).toEqual(next);
  });

  it('JSON parse 不能なファイルは warn ログを出して空 state を返す', async () => {
    const filePath = path.join(tmp, 'retry-state.json');
    writeFileSync(filePath, 'not-json{{{', 'utf8');
    const warn = vi.fn();
    const logger = {
      level: 'debug' as const,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: () => logger,
    };
    const storage = createFileRetryStorage({ filePath, logger });

    const state = await storage.load();
    expect(state).toEqual({ version: RETRY_STATE_VERSION, issues: {} });
    expect(warn).toHaveBeenCalled();
  });

  it('schema version が異なるファイルも空 state にリセットする', async () => {
    const filePath = path.join(tmp, 'retry-state.json');
    writeFileSync(filePath, JSON.stringify({ version: 999, issues: {} }), 'utf8');
    const warn = vi.fn();
    const logger = {
      level: 'debug' as const,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: () => logger,
    };
    const storage = createFileRetryStorage({ filePath, logger });

    const state = await storage.load();
    expect(state).toEqual({ version: RETRY_STATE_VERSION, issues: {} });
    expect(warn).toHaveBeenCalled();
  });

  it('save は atomic write (rename 経由) を使う — tmp ファイルを残さない', async () => {
    const filePath = path.join(tmp, 'retry-state.json');
    const storage = createFileRetryStorage({ filePath });
    await storage.save(createEmptyRetryState());
    const written = readFileSync(filePath, 'utf8');
    expect(JSON.parse(written)).toEqual({ version: RETRY_STATE_VERSION, issues: {} });
    // tmp ファイルが残っていないこと
    expect(() => readFileSync(`${filePath}.tmp`, 'utf8')).toThrow();
  });
});
