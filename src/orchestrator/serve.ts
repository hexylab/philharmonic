import type { Logger } from '../logger/index.js';

import type { RunOnceResult } from './run.js';

export type ServeLoopRunOnce = () => Promise<RunOnceResult>;

export type ServeLoopSleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type ServeLoopDeps = {
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
  runOnce: ServeLoopRunOnce;
  sleep?: ServeLoopSleep;
};

/**
 * `philharmonic serve` の本体ループ。
 *
 * - 即時 1 回 poll → tick ログ → runOnce → 結果ログ → sleep → 繰り返し
 * - signal が aborted のとき、in-flight runOnce は中断せず完了を待ってから break
 * - sleep 中の abort は即時 resolve して次イテレーションの while 条件で break する
 * - runOnce が throw した場合は warn ログを出して次の tick に進む (daemon の安定性優先)
 * - finally で `serve stopped` を 1 行出して終了経路を運用上わかるようにする
 */
export async function serveLoop(deps: ServeLoopDeps): Promise<void> {
  const sleep = deps.sleep ?? abortableSleep;
  const { intervalMs, signal, logger, runOnce } = deps;

  logger.info('serve started', { intervalMs });

  try {
    while (!signal.aborted) {
      logger.info('poll tick', { intervalMs });

      try {
        const result = await runOnce();
        logRunResult(logger, result);
      } catch (error) {
        logger.warn('dispatch error', { error: describeError(error) });
      }

      if (signal.aborted) break;
      await sleep(intervalMs, signal);
    }
  } finally {
    logger.info('serve stopped');
  }
}

function logRunResult(logger: Logger, result: RunOnceResult): void {
  switch (result.kind) {
    case 'no_candidate':
      logger.info('no candidate');
      return;
    case 'success':
      logger.info('dispatch success', {
        runId: result.runId,
        issueNumber: result.issueNumber,
        prNumber: result.prNumber,
        branch: result.branch,
      });
      return;
    case 'failed':
      logger.warn('dispatch failed', {
        runId: result.runId,
        issueNumber: result.issueNumber,
        reason: result.reason,
      });
      return;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
