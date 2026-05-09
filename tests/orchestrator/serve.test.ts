import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logger/index.js';
import { abortableSleep, serveLoop, type RunOnceResult } from '../../src/orchestrator/index.js';

type LogCall = { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; fields?: object };

function createCapturingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const logger: Logger = {
    level: 'debug',
    debug: (msg, fields) => calls.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => calls.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => calls.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => calls.push({ level: 'error', msg, fields }),
    child: () => logger,
  };
  return { logger, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('serveLoop', () => {
  it('serve started → poll tick → no candidate → serve stopped を順に出す (シングルイテレーション)', async () => {
    const controller = new AbortController();
    const { logger, calls } = createCapturingLogger();
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      // 1 イテレーションで終わるよう sleep に入る瞬間に abort
      controller.abort();
      await abortableSleep(0, signal);
    });
    const runOnce = vi.fn(async (): Promise<RunOnceResult> => ({ kind: 'no_candidate' }));

    await serveLoop({
      intervalMs: 1000,
      signal: controller.signal,
      logger,
      runOnce,
      sleep,
    });

    expect(runOnce).toHaveBeenCalledTimes(1);
    const messages = calls.map((c) => c.msg);
    expect(messages).toEqual(['serve started', 'poll tick', 'no candidate', 'serve stopped']);
    expect(calls[0]?.fields).toMatchObject({ intervalMs: 1000 });
  });

  it('複数イテレーション回せる (interval ごとに poll tick が出る)', async () => {
    const controller = new AbortController();
    const { logger, calls } = createCapturingLogger();
    let iteration = 0;
    const runOnce = vi.fn(async (): Promise<RunOnceResult> => ({ kind: 'no_candidate' }));
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      iteration += 1;
      if (iteration >= 3) controller.abort();
      await abortableSleep(0, signal);
    });

    await serveLoop({
      intervalMs: 100,
      signal: controller.signal,
      logger,
      runOnce,
      sleep,
    });

    expect(runOnce).toHaveBeenCalledTimes(3);
    const tickCount = calls.filter((c) => c.msg === 'poll tick').length;
    expect(tickCount).toBe(3);
  });

  it('SIGTERM (abort) を in-flight run の途中で受け取っても run の完了を待ってから exit する', async () => {
    const controller = new AbortController();
    const { logger, calls } = createCapturingLogger();
    const runStarted = deferred<void>();
    const finishRun = deferred<RunOnceResult>();
    const sleep = vi.fn(async () => {
      // 2 イテレーション目には入らない (1 回目の run 完了直後に abort 済みで break する想定)
      throw new Error('sleep should not be called when aborted before sleep');
    });
    let runFinishedAt: number | null = null;
    const runOnce = vi.fn(async (): Promise<RunOnceResult> => {
      runStarted.resolve();
      const r = await finishRun.promise;
      runFinishedAt = Date.now();
      return r;
    });

    const loopPromise = serveLoop({
      intervalMs: 1000,
      signal: controller.signal,
      logger,
      runOnce,
      sleep,
    });

    // run が起動するまで待つ
    await runStarted.promise;
    // 走行中に abort
    controller.abort();
    const abortedAt = Date.now();
    // すぐに run が終わらないことを確認 (loopPromise はまだ pending)
    let resolved = false;
    void loopPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    // run を完了させる
    finishRun.resolve({
      kind: 'success',
      runId: 'rid',
      issueNumber: 1,
      prNumber: 99,
      branch: 'feature/1-x',
    });
    await loopPromise;

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(runFinishedAt).not.toBeNull();
    expect(runFinishedAt!).toBeGreaterThanOrEqual(abortedAt);
    const messages = calls.map((c) => c.msg);
    expect(messages).toContain('dispatch success');
    expect(messages[messages.length - 1]).toBe('serve stopped');
  });

  it('runOnce が throw しても warn ログを出して次 tick に進む', async () => {
    const controller = new AbortController();
    const { logger, calls } = createCapturingLogger();
    let count = 0;
    const runOnce = vi.fn(async (): Promise<RunOnceResult> => {
      count += 1;
      if (count === 1) throw new Error('boom');
      return { kind: 'no_candidate' };
    });
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      if (count >= 2) controller.abort();
      await abortableSleep(0, signal);
    });

    await serveLoop({
      intervalMs: 100,
      signal: controller.signal,
      logger,
      runOnce,
      sleep,
    });

    expect(runOnce).toHaveBeenCalledTimes(2);
    const dispatchError = calls.find((c) => c.msg === 'dispatch error');
    expect(dispatchError).toBeDefined();
    expect(dispatchError?.level).toBe('warn');
    expect(dispatchError?.fields).toMatchObject({ error: 'boom' });
  });

  it('failed の result を warn として記録する (reason を含む)', async () => {
    const controller = new AbortController();
    const { logger, calls } = createCapturingLogger();
    const runOnce = vi.fn(
      async (): Promise<RunOnceResult> => ({
        kind: 'failed',
        runId: 'rid-2',
        issueNumber: 7,
        reason: 'runner_error',
        branch: 'feature/7-x',
      }),
    );
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      controller.abort();
      await abortableSleep(0, signal);
    });

    await serveLoop({
      intervalMs: 100,
      signal: controller.signal,
      logger,
      runOnce,
      sleep,
    });

    const dispatchFailed = calls.find((c) => c.msg === 'dispatch failed');
    expect(dispatchFailed?.level).toBe('warn');
    expect(dispatchFailed?.fields).toMatchObject({
      runId: 'rid-2',
      issueNumber: 7,
      reason: 'runner_error',
    });
  });

  it('signal が事前に aborted ならループに入らずに serve stopped で終わる', async () => {
    const controller = new AbortController();
    controller.abort();
    const { logger, calls } = createCapturingLogger();
    const runOnce = vi.fn();
    const sleep = vi.fn();

    await serveLoop({
      intervalMs: 100,
      signal: controller.signal,
      logger,
      runOnce: runOnce as never,
      sleep,
    });

    expect(runOnce).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    const messages = calls.map((c) => c.msg);
    expect(messages).toEqual(['serve started', 'serve stopped']);
  });
});

describe('abortableSleep', () => {
  it('指定時間が経過したら resolve する', async () => {
    const ac = new AbortController();
    const start = Date.now();
    await abortableSleep(20, ac.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('signal を中で abort したら即時 resolve する', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 5);
    await abortableSleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('既に aborted なら即時 resolve する', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await abortableSleep(1000, ac.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
