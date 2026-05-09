import { describe, expect, it } from 'vitest';

import { dispatchPool } from '../../src/orchestrator/index.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('dispatchPool', () => {
  it('tasks が空なら空配列を返す (worker は呼ばれない)', async () => {
    let called = 0;
    const result = await dispatchPool({
      tasks: [],
      maxConcurrent: 4,
      worker: async () => {
        called += 1;
        return 'x';
      },
    });
    expect(result).toEqual([]);
    expect(called).toBe(0);
  });

  it('maxConcurrent < 1 は throw する', async () => {
    await expect(
      dispatchPool({
        tasks: [1],
        maxConcurrent: 0,
        worker: async () => 'x',
      }),
    ).rejects.toThrow(/maxConcurrent/);
  });

  it('結果配列は task の入力順で揃う (slot 完了順ではない)', async () => {
    const tasks = [10, 20, 30] as const;
    const result = await dispatchPool({
      tasks,
      maxConcurrent: 3,
      worker: async (task) => {
        // task=10 を最後に完了させる
        if (task === 10) await new Promise((r) => setTimeout(r, 30));
        if (task === 20) await new Promise((r) => setTimeout(r, 5));
        return task * 2;
      },
    });
    expect(result).toEqual([20, 40, 60]);
  });

  it('maxConcurrent <= tasks.length のとき N 並列で動き、超過分は wait queue として slot が空くまで待つ', async () => {
    const tasks = [1, 2, 3, 4, 5];
    const maxConcurrent = 2;
    const releases = tasks.map(() => deferred<void>());
    const startedOrder: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const poolPromise = dispatchPool({
      tasks,
      maxConcurrent,
      worker: async (task) => {
        startedOrder.push(task);
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await releases[task - 1]!.promise;
        inFlight -= 1;
        return task * 10;
      },
    });

    // 起動直後は最大 N=2 個まで開始されている
    await new Promise((r) => setTimeout(r, 10));
    expect(startedOrder).toEqual([1, 2]);
    expect(maxInFlight).toBe(2);

    // task 1 を完了 → queue から 3 が引かれる
    releases[0]!.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(startedOrder).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(2);

    // task 2 を完了 → queue から 4 が引かれる
    releases[1]!.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(startedOrder).toEqual([1, 2, 3, 4]);
    expect(maxInFlight).toBe(2);

    // 残りを順次解放
    releases[2]!.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(startedOrder).toEqual([1, 2, 3, 4, 5]);

    releases[3]!.resolve();
    releases[4]!.resolve();
    const results = await poolPromise;
    expect(results).toEqual([10, 20, 30, 40, 50]);
    // 全期間を通して同時実行は 2 を超えない
    expect(maxInFlight).toBe(2);
  });

  it('slotIndex は 0..maxConcurrent-1 の範囲で worker に渡される', async () => {
    const seenSlots = new Set<number>();
    await dispatchPool({
      tasks: [1, 2, 3, 4],
      maxConcurrent: 2,
      worker: async (_task, slotIndex) => {
        seenSlots.add(slotIndex);
        await new Promise((r) => setTimeout(r, 5));
        return slotIndex;
      },
    });
    expect(Array.from(seenSlots).sort()).toEqual([0, 1]);
  });

  it('maxConcurrent > tasks.length のとき slot は tasks.length で打ち切られる', async () => {
    const usedSlots = new Set<number>();
    await dispatchPool({
      tasks: [1, 2],
      maxConcurrent: 10,
      worker: async (_task, slotIndex) => {
        usedSlots.add(slotIndex);
        return slotIndex;
      },
    });
    expect(Array.from(usedSlots).sort()).toEqual([0, 1]);
  });

  it('worker が throw すると Promise.all で reject される (例外は呼び出し元の責務)', async () => {
    await expect(
      dispatchPool({
        tasks: [1, 2],
        maxConcurrent: 2,
        worker: async (task) => {
          if (task === 1) throw new Error('boom');
          return task;
        },
      }),
    ).rejects.toThrow('boom');
  });
});
