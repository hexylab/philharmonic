import { describe, expect, it } from 'vitest';

import { createWakeController } from '../../src/server/wake.js';

describe('createWakeController', () => {
  it('acquire 後に wake() で signal が abort される', () => {
    const controller = createWakeController();
    const signal = controller.acquire();
    expect(signal.aborted).toBe(false);
    const woke = controller.wake();
    expect(woke).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('acquire 前の wake() は false を返す (起こせる相手がいない)', () => {
    const controller = createWakeController();
    expect(controller.wake()).toBe(false);
  });

  it('連続 wake() の 2 回目は false (1 回目で signal は consumed)', () => {
    const controller = createWakeController();
    controller.acquire();
    expect(controller.wake()).toBe(true);
    expect(controller.wake()).toBe(false);
  });

  it('wake 後に再 acquire するとフレッシュな (未 abort) signal が返る', () => {
    const controller = createWakeController();
    const first = controller.acquire();
    controller.wake();
    expect(first.aborted).toBe(true);

    const second = controller.acquire();
    expect(second.aborted).toBe(false);
    expect(second).not.toBe(first);
  });
});
