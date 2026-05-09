import type { Logger } from '../logger/index.js';

import type { RunOnceResult } from './run.js';

/**
 * 1 tick の dispatch を実行する関数。
 *
 * - `RunOnceResult` を返した場合: serveLoop が結果に応じて `dispatch success` / `dispatch failed`
 *   / `no candidate` をログに出す (max_concurrent_agents == 1 の互換挙動)
 * - `undefined` を返した場合: serveLoop は結果ログを抑制する。並列 dispatch (#24) では
 *   呼び出し元が個別に slot 付きでログを出すため undefined を返す
 */
export type ServeLoopRunOnce = () => Promise<RunOnceResult | undefined>;

export type ServeLoopSleep = (
  ms: number,
  signal: AbortSignal,
  wakeSignal?: AbortSignal,
) => Promise<void>;

export type ServeLoopDeps = {
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
  runOnce: ServeLoopRunOnce;
  sleep?: ServeLoopSleep;
  /**
   * 各 tick の sleep 直前に呼び、外部 (HTTP API `/api/v1/refresh`) から
   * sleep を起こせるようにするための AbortSignal を返す。未指定なら通常の
   * abortable sleep のみを行う。
   */
  acquireWakeSignal?: () => AbortSignal | undefined;
  /** poll tick 開始時に呼ばれるフック (snapshot tracker への通知用) */
  onPollTick?: () => void;
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
  const { intervalMs, signal, logger, runOnce, acquireWakeSignal, onPollTick } = deps;

  logger.info('serve started', { intervalMs });

  try {
    while (!signal.aborted) {
      logger.info('poll tick', { intervalMs });
      onPollTick?.();

      try {
        const result = await runOnce();
        if (result !== undefined) logRunResult(logger, result);
      } catch (error) {
        logger.warn('dispatch error', { error: describeError(error) });
      }

      if (signal.aborted) break;
      const wakeSignal = acquireWakeSignal?.();
      await sleep(intervalMs, signal, wakeSignal);
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

export function abortableSleep(
  ms: number,
  signal: AbortSignal,
  wakeSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || wakeSignal?.aborted === true) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      wakeSignal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    wakeSignal?.addEventListener('abort', onAbort, { once: true });
  });
}
