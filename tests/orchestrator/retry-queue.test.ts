import { describe, expect, it } from 'vitest';

import {
  computeRetryDelayMs,
  createRetryQueue,
  type RetryQueueScheduleInput,
} from '../../src/orchestrator/index.js';

const REPO = { owner: 'hexylab', name: 'philharmonic' };

function baseInput(overrides: Partial<RetryQueueScheduleInput> = {}): RetryQueueScheduleInput {
  return {
    issueNumber: 42,
    repository: REPO,
    branch: 'feature/42-foo',
    workspacePath: '/tmp/.philharmonic/worktrees/issue-42',
    attempt: 1,
    failureReason: 'runner_error',
    lastRunId: '0190ce80-0000-7000-8000-000000000001',
    lastErrorSummary: null,
    now: new Date('2026-05-09T00:00:00Z'),
    maxBackoffMs: 300_000,
    ...overrides,
  };
}

describe('computeRetryDelayMs', () => {
  it.each([
    [1, 10_000],
    [2, 20_000],
    [3, 40_000],
    [4, 80_000],
    [5, 160_000],
  ])('attempt=%i は backoff = %i ms (clamp 上限内)', (attempt, expected) => {
    expect(computeRetryDelayMs(attempt, 300_000)).toBe(expected);
  });

  it('clamp 上限を超える attempt は max_backoff_ms に張り付く', () => {
    expect(computeRetryDelayMs(6, 300_000)).toBe(300_000);
    expect(computeRetryDelayMs(7, 300_000)).toBe(300_000);
    expect(computeRetryDelayMs(20, 300_000)).toBe(300_000);
  });

  it('attempt < 1 は 1 として扱う (defensive)', () => {
    expect(computeRetryDelayMs(0, 300_000)).toBe(10_000);
    expect(computeRetryDelayMs(-3, 300_000)).toBe(10_000);
  });

  it('max_backoff_ms == 0 のときは delay も 0 (即時 due)', () => {
    expect(computeRetryDelayMs(1, 0)).toBe(0);
    expect(computeRetryDelayMs(5, 0)).toBe(0);
  });
});

describe('createRetryQueue', () => {
  it('schedule した entry が dueAt = now + delay で積まれる', () => {
    const queue = createRetryQueue();
    const now = new Date('2026-05-09T00:00:00Z');
    const entry = queue.schedule(baseInput({ attempt: 2, now }));

    expect(entry.attempt).toBe(2);
    expect(entry.dueAt.toISOString()).toBe('2026-05-09T00:00:20.000Z');
    expect(entry.scheduledAt).toEqual(now);
    expect(queue.size()).toBe(1);
  });

  it('同一 issueNumber を 2 回 schedule すると最新で上書きされる (size は 1)', () => {
    const queue = createRetryQueue();
    queue.schedule(baseInput({ attempt: 1 }));
    queue.schedule(baseInput({ attempt: 3, now: new Date('2026-05-09T00:01:00Z') }));

    expect(queue.size()).toBe(1);
    expect(queue.list()[0]!.attempt).toBe(3);
  });

  it('drainDue は dueAt <= now を pop し、未到来 entry は残す', () => {
    const queue = createRetryQueue();
    const now = new Date('2026-05-09T00:00:00Z');
    queue.schedule(baseInput({ issueNumber: 1, attempt: 1, now }));
    queue.schedule(baseInput({ issueNumber: 2, attempt: 5, now })); // delay = 160s
    queue.schedule(baseInput({ issueNumber: 3, attempt: 1, now })); // delay = 10s

    const at = new Date('2026-05-09T00:00:30Z');
    const drained = queue.drainDue(at);

    expect(drained.map((e) => e.issueNumber)).toEqual([1, 3]);
    expect(queue.size()).toBe(1);
    expect(queue.list()[0]!.issueNumber).toBe(2);
  });

  it('drainDue の戻り値は dueAt 昇順 (同時刻なら issueNumber 昇順)', () => {
    const queue = createRetryQueue();
    const now = new Date('2026-05-09T00:00:00Z');
    queue.schedule(baseInput({ issueNumber: 5, attempt: 1, now }));
    queue.schedule(baseInput({ issueNumber: 3, attempt: 1, now }));
    queue.schedule(baseInput({ issueNumber: 4, attempt: 2, now })); // delay 20s

    const drained = queue.drainDue(new Date('2026-05-09T00:01:00Z'));

    expect(drained.map((e) => e.issueNumber)).toEqual([3, 5, 4]);
  });

  it('remove は entry を削除し、true を返す。存在しない entry は false', () => {
    const queue = createRetryQueue();
    queue.schedule(baseInput({ issueNumber: 7 }));
    expect(queue.remove(7)).toBe(true);
    expect(queue.size()).toBe(0);
    expect(queue.remove(7)).toBe(false);
  });

  it('list は dueAt 昇順 (snapshot 表示用)', () => {
    const queue = createRetryQueue();
    const now = new Date('2026-05-09T00:00:00Z');
    queue.schedule(baseInput({ issueNumber: 10, attempt: 3, now })); // delay 40s
    queue.schedule(baseInput({ issueNumber: 11, attempt: 1, now })); // delay 10s

    const list = queue.list();
    expect(list.map((e) => e.issueNumber)).toEqual([11, 10]);
  });

  it('lastErrorSummary は 500 文字を超えると先頭で切り詰める', () => {
    const queue = createRetryQueue();
    const long = 'x'.repeat(1000);
    const entry = queue.schedule(baseInput({ lastErrorSummary: long }));
    expect(entry.lastErrorSummary).toHaveLength(500);
  });

  it('reschedule は既存 entry の dueAt のみ書き換える (attempt は据え置き)', () => {
    const queue = createRetryQueue();
    const now = new Date('2026-05-09T00:00:00Z');
    queue.schedule(baseInput({ attempt: 2, now }));

    const updated = queue.reschedule({
      issueNumber: 42,
      delayMs: 60_000,
      now: new Date('2026-05-09T00:00:30Z'),
    });

    expect(updated).not.toBeNull();
    expect(updated!.attempt).toBe(2); // 据え置き
    expect(updated!.dueAt.toISOString()).toBe('2026-05-09T00:01:30.000Z');
  });

  it('reschedule は存在しない issueNumber に対して null を返す', () => {
    const queue = createRetryQueue();
    expect(
      queue.reschedule({
        issueNumber: 99,
        delayMs: 1_000,
        now: new Date(),
      }),
    ).toBeNull();
  });
});
