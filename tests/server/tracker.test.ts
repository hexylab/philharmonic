import { describe, expect, it } from 'vitest';

import { createRunTracker, type RunStartedInput } from '../../src/server/tracker.js';

/**
 * 必須フィールドを補完したヘルパー。テスト中の `runStarted` 呼び出しでは
 * runId / issueNumber / branch / startedAt 以外を補える。
 */
function makeStartedInput(
  overrides: Partial<RunStartedInput> & {
    runId: string;
    issueNumber: number;
    branch: string;
    startedAt: Date;
  },
): RunStartedInput {
  return {
    workspacePath: `/tmp/issue-${overrides.issueNumber}`,
    runLogPath: `/tmp/runs/${overrides.runId}`,
    ...overrides,
  };
}

describe('createRunTracker', () => {
  it('runStarted で in-flight に積まれ listRunning から取れる', () => {
    const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
    tracker.runStarted(
      makeStartedInput({
        runId: 'run-1',
        issueNumber: 42,
        branch: 'feature/42-foo',
        startedAt: new Date('2026-05-09T00:00:01Z'),
        slot: 0,
        workspacePath: '/tmp/issue-42',
        runLogPath: '/tmp/runs/run-1',
      }),
    );

    expect(tracker.listRunning()).toEqual([
      {
        runId: 'run-1',
        issueNumber: 42,
        branch: 'feature/42-foo',
        startedAt: '2026-05-09T00:00:01.000Z',
        slot: 0,
        lastActivityAt: '2026-05-09T00:00:01.000Z',
        retryAttempt: null,
        workspacePath: '/tmp/issue-42',
        runLogPath: '/tmp/runs/run-1',
        runnerPid: null,
        watchdog: null,
      },
    ]);
    expect(tracker.getRunningByIssue(42)).not.toBeNull();
    expect(tracker.getRunningByIssue(43)).toBeNull();
  });

  it('recordActivity で lastActivityAt が更新される (#87)', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({
        runId: 'r',
        issueNumber: 1,
        branch: 'b',
        startedAt: new Date('2026-05-09T00:00:00Z'),
      }),
    );
    tracker.recordActivity('r', new Date('2026-05-09T00:01:00Z'));

    expect(tracker.getRunningByIssue(1)?.lastActivityAt).toBe('2026-05-09T00:01:00.000Z');
  });

  it('recordActivity は in-flight でない runId を no-op にする (#87)', () => {
    const tracker = createRunTracker();
    expect(() => tracker.recordActivity('unknown', new Date())).not.toThrow();
  });

  it('runStarted で retryAttempt を渡すと running entry に保持される (#87)', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({
        runId: 'r',
        issueNumber: 1,
        branch: 'b',
        startedAt: new Date('2026-05-09T00:00:00Z'),
        retryAttempt: { kind: 'failure', attempt: 2 },
      }),
    );

    expect(tracker.getRunningByIssue(1)?.retryAttempt).toEqual({ kind: 'failure', attempt: 2 });
  });

  it('recordRunnerProcess で runnerPid が更新される (#105)', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({
        runId: 'r',
        issueNumber: 1,
        branch: 'b',
        startedAt: new Date('2026-05-09T00:00:00Z'),
      }),
    );
    expect(tracker.getRunningByIssue(1)?.runnerPid).toBeNull();
    tracker.recordRunnerProcess('r', 12345);
    expect(tracker.getRunningByIssue(1)?.runnerPid).toBe(12345);
    // multi-turn で 2 ターン目に新 pid に切り替わるケースを許容する
    tracker.recordRunnerProcess('r', 67890);
    expect(tracker.getRunningByIssue(1)?.runnerPid).toBe(67890);
  });

  it('recordRunnerProcess は in-flight でない runId を no-op にする (#105)', () => {
    const tracker = createRunTracker();
    expect(() => tracker.recordRunnerProcess('unknown', 1)).not.toThrow();
  });

  it('setWatchdog で watchdog 状態が保持され、reasons 空配列なら null に倒れる (#105)', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({
        runId: 'r',
        issueNumber: 1,
        branch: 'b',
        startedAt: new Date('2026-05-09T00:00:00Z'),
      }),
    );
    tracker.setWatchdog('r', {
      reasons: ['orphaned'],
      orphanedSince: '2026-05-09T00:01:00.000Z',
      staleSince: null,
    });
    expect(tracker.getRunningByIssue(1)?.watchdog).toEqual({
      reasons: ['orphaned'],
      orphanedSince: '2026-05-09T00:01:00.000Z',
      staleSince: null,
    });
    tracker.setWatchdog('r', { reasons: [], orphanedSince: null, staleSince: null });
    expect(tracker.getRunningByIssue(1)?.watchdog).toBeNull();
    tracker.setWatchdog('r', null);
    expect(tracker.getRunningByIssue(1)?.watchdog).toBeNull();
  });

  it('setWatchdog は in-flight でない runId を no-op にする (#105)', () => {
    const tracker = createRunTracker();
    expect(() =>
      tracker.setWatchdog('unknown', {
        reasons: ['stale'],
        orphanedSince: null,
        staleSince: '2026-05-09T00:01:00.000Z',
      }),
    ).not.toThrow();
  });

  it('runFinished で running から消え、totals が更新される (success)', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({
        runId: 'r',
        issueNumber: 1,
        branch: 'b',
        startedAt: new Date(),
      }),
    );
    tracker.runFinished({ kind: 'success', runId: 'r', issueNumber: 1, totalCostUsd: 1.25 });

    expect(tracker.listRunning()).toEqual([]);
    expect(tracker.getTotals()).toEqual({
      runsCompleted: 1,
      runsSucceeded: 1,
      runsFailed: 0,
      totalCostUsd: 1.25,
    });
  });

  it('runFinished (failed) は runsFailed をインクリメントする', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({ runId: 'r', issueNumber: 1, branch: 'b', startedAt: new Date() }),
    );
    tracker.runFinished({
      kind: 'failed',
      runId: 'r',
      issueNumber: 1,
      reason: 'runner_error',
      totalCostUsd: null,
    });

    expect(tracker.getTotals()).toMatchObject({
      runsCompleted: 1,
      runsSucceeded: 0,
      runsFailed: 1,
      totalCostUsd: 0,
    });
  });

  it('runFinished はべき等 (二重発火しても totals は 1 回分しか進まない)', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({ runId: 'r', issueNumber: 1, branch: 'b', startedAt: new Date() }),
    );
    tracker.runFinished({ kind: 'success', runId: 'r', issueNumber: 1, totalCostUsd: 0.5 });
    tracker.runFinished({ kind: 'success', runId: 'r', issueNumber: 1, totalCostUsd: 0.5 });

    expect(tracker.getTotals()).toMatchObject({ runsCompleted: 1, totalCostUsd: 0.5 });
  });

  it('runFinished で未知 runId は no-op (not found だが throw もしない)', () => {
    const tracker = createRunTracker();
    expect(() =>
      tracker.runFinished({
        kind: 'failed',
        runId: 'unknown',
        issueNumber: 1,
        reason: 'runner_error',
        totalCostUsd: null,
      }),
    ).not.toThrow();
    expect(tracker.getTotals().runsCompleted).toBe(0);
  });

  it('totalCostUsd が null / NaN の場合は加算されない', () => {
    const tracker = createRunTracker();
    tracker.runStarted(
      makeStartedInput({ runId: 'a', issueNumber: 1, branch: 'b', startedAt: new Date() }),
    );
    tracker.runStarted(
      makeStartedInput({ runId: 'b', issueNumber: 2, branch: 'b', startedAt: new Date() }),
    );
    tracker.runFinished({ kind: 'success', runId: 'a', issueNumber: 1, totalCostUsd: null });
    tracker.runFinished({ kind: 'success', runId: 'b', issueNumber: 2, totalCostUsd: Number.NaN });

    expect(tracker.getTotals().totalCostUsd).toBe(0);
    expect(tracker.getTotals().runsCompleted).toBe(2);
  });

  it('listRunning は issueNumber 昇順で返す (snapshot の安定性)', () => {
    const tracker = createRunTracker();
    const startedAt = new Date('2026-05-09T00:00:00Z');
    tracker.runStarted(makeStartedInput({ runId: 'a', issueNumber: 7, branch: 'b', startedAt }));
    tracker.runStarted(makeStartedInput({ runId: 'b', issueNumber: 3, branch: 'b', startedAt }));
    tracker.runStarted(makeStartedInput({ runId: 'c', issueNumber: 5, branch: 'b', startedAt }));

    expect(tracker.listRunning().map((r) => r.issueNumber)).toEqual([3, 5, 7]);
  });

  it('recordPollTick / getLastPollTickAt が ISO 文字列を保持する', () => {
    const tracker = createRunTracker();
    expect(tracker.getLastPollTickAt()).toBeNull();
    tracker.recordPollTick(new Date('2026-05-09T01:00:00Z'));
    expect(tracker.getLastPollTickAt()).toBe('2026-05-09T01:00:00.000Z');
  });
});
