import { describe, expect, it } from 'vitest';

import type { EvaluatedCandidate } from '../../src/dependency/index.js';
import type { Candidate } from '../../src/projects/index.js';
import { createDependencyTracker } from '../../src/server/dependency-tracker.js';

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

describe('createDependencyTracker', () => {
  it('初期状態では getSnapshot は null を返す', () => {
    const tracker = createDependencyTracker();
    expect(tracker.getSnapshot()).toBeNull();
  });

  it('recordEvaluation は ready / blocked / cycle / invalid_dependency を分類する', () => {
    const tracker = createDependencyTracker();
    const ready = makeCandidate({ issueNumber: 104, issueTitle: 'ready a' });
    const blocked = makeCandidate({ issueNumber: 102, issueTitle: 'blocked b' });
    const invalid = makeCandidate({ issueNumber: 103, issueTitle: 'invalid c' });
    const cycle = makeCandidate({ issueNumber: 201, issueTitle: 'cycle d' });

    const evaluations: EvaluatedCandidate[] = [
      { state: 'ready', candidate: ready },
      { state: 'blocked', candidate: blocked, blockingIssueNumbers: [101] },
      {
        state: 'invalid_dependency',
        candidate: invalid,
        invalidEntries: [{ raw: 'owner/repo#1', issueNumber: null, reason: 'parse_invalid' }],
      },
      { state: 'cycle', candidate: cycle, cycleIssueNumbers: [201, 202] },
    ];

    tracker.recordEvaluation({
      evaluations,
      at: new Date('2026-05-09T00:00:30Z'),
    });

    expect(tracker.getSnapshot()).toEqual({
      lastEvaluatedAt: '2026-05-09T00:00:30.000Z',
      ready: [{ issueNumber: 104, title: 'ready a' }],
      blocked: [
        {
          issueNumber: 102,
          title: 'blocked b',
          blockedBy: [101],
        },
      ],
      cycles: [{ issueNumbers: [201, 202] }],
      invalidDependencies: [
        {
          issueNumber: 103,
          title: 'invalid c',
          entries: [{ raw: 'owner/repo#1', issueNumber: null, reason: 'parse_invalid' }],
        },
      ],
    });
  });

  it('cycles は SCC member を sorted set で dedup する', () => {
    const tracker = createDependencyTracker();
    const c1 = makeCandidate({ issueNumber: 201 });
    const c2 = makeCandidate({ issueNumber: 202 });

    tracker.recordEvaluation({
      evaluations: [
        { state: 'cycle', candidate: c1, cycleIssueNumbers: [202, 201] },
        { state: 'cycle', candidate: c2, cycleIssueNumbers: [201, 202] },
      ],
      at: new Date('2026-05-09T00:00:00Z'),
    });

    const snap = tracker.getSnapshot();
    expect(snap?.cycles).toEqual([{ issueNumbers: [201, 202] }]);
  });

  it('複数 SCC は別 entry として残る', () => {
    const tracker = createDependencyTracker();
    const a = makeCandidate({ issueNumber: 301 });
    const b = makeCandidate({ issueNumber: 401 });

    tracker.recordEvaluation({
      evaluations: [
        { state: 'cycle', candidate: a, cycleIssueNumbers: [301, 302] },
        { state: 'cycle', candidate: b, cycleIssueNumbers: [401, 402] },
      ],
      at: new Date('2026-05-09T00:00:00Z'),
    });

    expect(tracker.getSnapshot()?.cycles).toEqual([
      { issueNumbers: [301, 302] },
      { issueNumbers: [401, 402] },
    ]);
  });

  it('invalid entries の message は fetch_error のときだけ含まれる', () => {
    const tracker = createDependencyTracker();
    const c = makeCandidate({ issueNumber: 50 });

    tracker.recordEvaluation({
      evaluations: [
        {
          state: 'invalid_dependency',
          candidate: c,
          invalidEntries: [
            { raw: '#51', issueNumber: 51, reason: 'not_found' },
            { raw: '#52', issueNumber: 52, reason: 'fetch_error', message: 'boom' },
          ],
        },
      ],
      at: new Date(),
    });

    const snap = tracker.getSnapshot();
    expect(snap?.invalidDependencies[0]?.entries).toEqual([
      { raw: '#51', issueNumber: 51, reason: 'not_found' },
      { raw: '#52', issueNumber: 52, reason: 'fetch_error', message: 'boom' },
    ]);
  });

  it('recordEvaluation は per-tick で全置換 (古い tick の情報は残らない)', () => {
    const tracker = createDependencyTracker();
    const a = makeCandidate({ issueNumber: 1, issueTitle: 'a' });
    const b = makeCandidate({ issueNumber: 2, issueTitle: 'b' });

    tracker.recordEvaluation({
      evaluations: [
        { state: 'ready', candidate: a },
        { state: 'blocked', candidate: b, blockingIssueNumbers: [99] },
      ],
      at: new Date('2026-05-09T00:00:00Z'),
    });

    tracker.recordEvaluation({
      evaluations: [{ state: 'ready', candidate: b }],
      at: new Date('2026-05-09T00:00:30Z'),
    });

    expect(tracker.getSnapshot()).toEqual({
      lastEvaluatedAt: '2026-05-09T00:00:30.000Z',
      ready: [{ issueNumber: 2, title: 'b' }],
      blocked: [],
      cycles: [],
      invalidDependencies: [],
    });
  });

  it('入力順 (board 順) を保持する', () => {
    const tracker = createDependencyTracker();
    const a = makeCandidate({ issueNumber: 9, issueTitle: 'a' });
    const b = makeCandidate({ issueNumber: 5, issueTitle: 'b' });
    const c = makeCandidate({ issueNumber: 7, issueTitle: 'c' });

    tracker.recordEvaluation({
      evaluations: [
        { state: 'ready', candidate: a },
        { state: 'ready', candidate: b },
        { state: 'ready', candidate: c },
      ],
      at: new Date(),
    });

    expect(tracker.getSnapshot()?.ready.map((r) => r.issueNumber)).toEqual([9, 5, 7]);
  });
});
