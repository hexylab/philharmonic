/**
 * 汎用 worker pool。`tasks` を最大 `maxConcurrent` 並列で処理する。
 *
 * - tasks 数が `maxConcurrent` を超える場合、超過分は wait queue として slot が空くまで待機する
 * - 結果配列は `tasks` の入力順で返す (slot 完了順ではない)
 * - 個別 worker の例外は呼び出し元の責務 (本関数では握らない)。catch 必要なら `worker` 内で処理する
 *
 * Issue #24 の `agent.max_concurrent_agents` による並列 dispatch の核となるユーティリティ。
 */
export async function dispatchPool<T, R>({
  tasks,
  maxConcurrent,
  worker,
}: {
  tasks: readonly T[];
  maxConcurrent: number;
  worker: (task: T, slotIndex: number) => Promise<R>;
}): Promise<R[]> {
  if (maxConcurrent < 1) {
    throw new Error(`dispatchPool: maxConcurrent must be >= 1 (got ${maxConcurrent})`);
  }
  if (tasks.length === 0) return [];

  const results: R[] = new Array<R>(tasks.length);
  let nextIndex = 0;

  const slotCount = Math.min(maxConcurrent, tasks.length);
  await Promise.all(Array.from({ length: slotCount }, (_, slotIndex) => runSlot(slotIndex)));
  return results;

  async function runSlot(slotIndex: number): Promise<void> {
    while (true) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      if (taskIndex >= tasks.length) return;
      const task = tasks[taskIndex] as T;
      results[taskIndex] = await worker(task, slotIndex);
    }
  }
}
