import { describe, expect, it } from 'vitest';

import type { EvaluatedCandidate } from '../../src/dependency/index.js';
import type { Candidate } from '../../src/projects/index.js';
import { createDependencyTracker } from '../../src/server/dependency-tracker.js';
import { buildIssueSnapshot, buildStateSnapshot } from '../../src/server/snapshot.js';
import { createRunTracker } from '../../src/server/tracker.js';

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_x',
    issueNumber: 100,
    issueTitle: 'sample title',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/100',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'Todo',
    ...overrides,
  };
}

describe('buildStateSnapshot', () => {
  it('running / totals を組み合わせて snake_case payload を返す', async () => {
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

    const snapshot = await buildStateSnapshot({
      tracker,
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
      totals: {
        runs_completed: 0,
        runs_succeeded: 0,
        runs_failed: 0,
        total_cost_usd: 0,
      },
      scheduler: null,
      retry_queue: null,
    });
  });

  it('dependencyTracker が未指定なら scheduler は null', async () => {
    const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    const snapshot = await buildStateSnapshot({
      tracker,
      intervalMs: 30_000,
      now: new Date('2026-05-09T00:00:01Z'),
    });
    expect(snapshot.scheduler).toBeNull();
  });

  it('dependencyTracker の評価結果を snake_case で scheduler フィールドに乗せる', async () => {
    const runTracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    const dependencyTracker = createDependencyTracker();

    const ready = makeCandidate({ issueNumber: 104, issueTitle: 'Add foo handler' });
    const blocked = makeCandidate({ issueNumber: 102, issueTitle: 'Switch to async API' });
    const invalid = makeCandidate({ issueNumber: 103, issueTitle: 'Migrate legacy endpoint' });
    const cycle = makeCandidate({ issueNumber: 201, issueTitle: 'Cycle a' });
    const evaluations: EvaluatedCandidate[] = [
      { state: 'ready', candidate: ready },
      { state: 'blocked', candidate: blocked, blockingIssueNumbers: [101] },
      {
        state: 'invalid_dependency',
        candidate: invalid,
        invalidEntries: [
          { raw: 'owner/repo#1', issueNumber: null, reason: 'parse_invalid' },
          { raw: '#999', issueNumber: 999, reason: 'fetch_error', message: 'boom' },
        ],
      },
      { state: 'cycle', candidate: cycle, cycleIssueNumbers: [201, 202] },
    ];
    dependencyTracker.recordEvaluation({
      evaluations,
      at: new Date('2026-05-09T00:00:30Z'),
    });

    const snapshot = await buildStateSnapshot({
      tracker: runTracker,
      intervalMs: 30_000,
      now: new Date('2026-05-09T00:01:00Z'),
      dependencyTracker,
    });

    expect(snapshot.scheduler).toEqual({
      last_evaluated_at: '2026-05-09T00:00:30.000Z',
      ready: [{ issue_number: 104, title: 'Add foo handler' }],
      blocked: [
        {
          issue_number: 102,
          title: 'Switch to async API',
          blocked_by: [101],
        },
      ],
      cycles: [{ issue_numbers: [201, 202] }],
      invalid_dependencies: [
        {
          issue_number: 103,
          title: 'Migrate legacy endpoint',
          entries: [
            { raw: 'owner/repo#1', issue_number: null, reason: 'parse_invalid' },
            { raw: '#999', issue_number: 999, reason: 'fetch_error', message: 'boom' },
          ],
        },
      ],
    });
  });

  it('retryQueue が渡されると retry_queue field を返す (#84 / ADR-0008)', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();
    queue.schedule({
      issueNumber: 42,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/42-foo',
      workspacePath: '/tmp/issue-42',
      attempt: 2,
      failureReason: 'runner_error',
      lastRunId: 'last-run',
      lastErrorSummary: 'claude exited with code 1',
      now: new Date('2026-05-09T00:00:30Z'),
      maxBackoffMs: 300_000,
    });

    const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    const snapshot = await buildStateSnapshot({
      tracker,
      intervalMs: 30_000,
      now: new Date('2026-05-09T00:01:00Z'),
      retryQueue: queue,
      retryConfig: { maxAttempts: 5, maxBackoffMs: 300_000 },
    });

    expect(snapshot.retry_queue).toEqual({
      size: 1,
      max_attempts: 5,
      max_backoff_ms: 300_000,
      entries: [
        {
          issue_number: 42,
          attempt: 2,
          due_at: '2026-05-09T00:00:50.000Z',
          scheduled_at: '2026-05-09T00:00:30.000Z',
          failure_reason: 'runner_error',
          last_run_id: 'last-run',
          last_error_summary: 'claude exited with code 1',
        },
      ],
    });
  });

  it('retry_queue は max_attempts == 0 のとき null', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    const snapshot = await buildStateSnapshot({
      tracker,
      intervalMs: 30_000,
      now: new Date('2026-05-09T00:01:00Z'),
      retryQueue: queue,
      retryConfig: { maxAttempts: 0, maxBackoffMs: 300_000 },
    });

    expect(snapshot.retry_queue).toBeNull();
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

    const snapshot = await buildStateSnapshot({
      tracker,
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
  it('running entry を返す', async () => {
    const tracker = createRunTracker();
    tracker.runStarted({
      runId: 'r',
      issueNumber: 42,
      branch: 'b',
      startedAt: new Date('2026-05-09T00:00:00Z'),
      slot: 0,
    });

    const snapshot = await buildIssueSnapshot({ issueNumber: 42, tracker });
    expect(snapshot).toEqual({
      issue_number: 42,
      running: {
        run_id: 'r',
        issue_number: 42,
        branch: 'b',
        started_at: '2026-05-09T00:00:00.000Z',
        slot: 0,
      },
    });
  });

  it('該当が無い Issue は running が null', async () => {
    const tracker = createRunTracker();
    const snapshot = await buildIssueSnapshot({ issueNumber: 999, tracker });
    expect(snapshot).toEqual({ issue_number: 999, running: null });
  });
});
