import { describe, expect, it } from 'vitest';

import { createRetryScheduler, type RetryStorage } from '../../src/serve/index.js';
import { buildIssueSnapshot, buildStateSnapshot } from '../../src/server/snapshot.js';
import { createRunTracker } from '../../src/server/tracker.js';

function memoryStorage(): RetryStorage {
  let state = { version: 1 as const, issues: {} as Record<string, never> };
  return {
    async load() {
      return JSON.parse(JSON.stringify(state)) as typeof state;
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next)) as typeof state;
    },
  };
}

describe('buildStateSnapshot', () => {
  it('running / retrying / totals を組み合わせて snake_case payload を返す', async () => {
    const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    tracker.runStarted({
      runId: 'run-1',
      issueNumber: 42,
      branch: 'feature/42-foo',
      startedAt: new Date('2026-05-09T00:00:10Z'),
      slot: 1,
    });
    tracker.runStarted({
      runId: 'run-2',
      issueNumber: 7,
      branch: 'feature/7-bar',
      startedAt: new Date('2026-05-09T00:00:20Z'),
    });
    tracker.runFinished({ kind: 'success', runId: 'completed', issueNumber: 5, totalCostUsd: 1 });
    tracker.recordPollTick(new Date('2026-05-09T00:00:30Z'));

    const scheduler = createRetryScheduler({
      storage: memoryStorage(),
      maxAttempts: 3,
      maxBackoffMs: 600_000,
    });
    await scheduler.recordFailure({
      issueNumber: 99,
      reason: 'runner_error',
      now: new Date('2026-05-09T00:00:00Z'),
    });

    const snapshot = await buildStateSnapshot({
      tracker,
      scheduler,
      intervalMs: 30_000,
      now: new Date('2026-05-09T00:01:00Z'),
    });

    expect(snapshot).toEqual({
      started_at: '2026-05-09T00:00:00.000Z',
      uptime_ms: 60_000,
      polling: {
        interval_ms: 30_000,
        last_tick_at: '2026-05-09T00:00:30.000Z',
      },
      running: [
        {
          run_id: 'run-2',
          issue_number: 7,
          branch: 'feature/7-bar',
          started_at: '2026-05-09T00:00:20.000Z',
          slot: null,
        },
        {
          run_id: 'run-1',
          issue_number: 42,
          branch: 'feature/42-foo',
          started_at: '2026-05-09T00:00:10.000Z',
          slot: 1,
        },
      ],
      retrying: [
        {
          issue_number: 99,
          attempts: 1,
          last_failed_at: '2026-05-09T00:00:00.000Z',
          next_attempt_at: '2026-05-09T00:00:10.000Z',
          last_reason: 'runner_error',
        },
      ],
      totals: {
        runs_completed: 0, // tracker.runFinished は runStarted されていない runId に対しては no-op
        runs_succeeded: 0,
        runs_failed: 0,
        total_cost_usd: 0,
      },
    });
  });

  it('totals は runStarted → runFinished のペアでカウントされる', async () => {
    const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    tracker.runStarted({
      runId: 'r',
      issueNumber: 1,
      branch: 'b',
      startedAt: new Date('2026-05-09T00:00:01Z'),
    });
    tracker.runFinished({ kind: 'success', runId: 'r', issueNumber: 1, totalCostUsd: 0.42 });

    const scheduler = createRetryScheduler({
      storage: memoryStorage(),
      maxAttempts: 3,
      maxBackoffMs: 600_000,
    });

    const snapshot = await buildStateSnapshot({
      tracker,
      scheduler,
      intervalMs: 30_000,
      now: new Date('2026-05-09T00:01:00Z'),
    });
    expect(snapshot.totals).toEqual({
      runs_completed: 1,
      runs_succeeded: 1,
      runs_failed: 0,
      total_cost_usd: 0.42,
    });
    expect(snapshot.running).toEqual([]);
  });
});

describe('buildIssueSnapshot', () => {
  it('running と retrying をマージして 1 Issue を返す', async () => {
    const tracker = createRunTracker();
    tracker.runStarted({
      runId: 'r',
      issueNumber: 42,
      branch: 'b',
      startedAt: new Date('2026-05-09T00:00:00Z'),
      slot: 0,
    });

    const scheduler = createRetryScheduler({
      storage: memoryStorage(),
      maxAttempts: 3,
      maxBackoffMs: 600_000,
    });
    await scheduler.recordFailure({
      issueNumber: 42,
      reason: 'timeout',
      now: new Date('2026-05-09T00:00:00Z'),
    });

    const snapshot = await buildIssueSnapshot({ issueNumber: 42, tracker, scheduler });
    expect(snapshot).toEqual({
      issue_number: 42,
      running: {
        run_id: 'r',
        issue_number: 42,
        branch: 'b',
        started_at: '2026-05-09T00:00:00.000Z',
        slot: 0,
      },
      retrying: {
        issue_number: 42,
        attempts: 1,
        last_failed_at: '2026-05-09T00:00:00.000Z',
        next_attempt_at: '2026-05-09T00:00:10.000Z',
        last_reason: 'timeout',
      },
    });
  });

  it('該当が無い Issue は running / retrying ともに null', async () => {
    const tracker = createRunTracker();
    const scheduler = createRetryScheduler({
      storage: memoryStorage(),
      maxAttempts: 3,
      maxBackoffMs: 600_000,
    });
    const snapshot = await buildIssueSnapshot({ issueNumber: 999, tracker, scheduler });
    expect(snapshot).toEqual({ issue_number: 999, running: null, retrying: null });
  });
});
