/**
 * `serveLoop` の sleep を外部から起こすための wake controller。
 *
 * - 各 tick の sleep は `acquire()` で取得した AbortSignal を渡す
 * - 外部 (HTTP API `/api/v1/refresh` 等) は `wake()` を呼んで signal を abort する
 *   - sleep 中なら即座に sleep が解け、次 tick が始まる (woken: true)
 *   - sleep 中でない (= dispatch 実行中) なら何も起こらない (woken: false)
 *
 * `wake()` のたびに新しい AbortController に差し替えるので、次回 `acquire()` で
 * 新しい signal が取れる。
 *
 * spec: docs/specs/snapshot-api.md
 */

export type WakeController = {
  /** 現在の sleep wake signal。各 tick の sleep に渡す */
  acquire(): AbortSignal;
  /**
   * sleep を起こす。
   * 戻り値: 直前の signal が「acquire 済みかつ未 abort」なら true (= 実際に起こした)、
   *         それ以外 (acquire 前 / 既に abort 済み) は false。
   */
  wake(): boolean;
};

export function createWakeController(): WakeController {
  let controller = new AbortController();
  let acquired = false;
  return {
    acquire() {
      acquired = true;
      return controller.signal;
    },
    wake() {
      const wokeSomething = acquired && !controller.signal.aborted;
      controller.abort();
      controller = new AbortController();
      acquired = false;
      return wokeSomething;
    },
  };
}
