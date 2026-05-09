import { describe, expect, it } from 'vitest';

import { isAcceptableIssue, selectFirstByStatus } from '../../src/orchestrator/select.js';
import type { Candidate } from '../../src/projects/index.js';

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_x',
    issueNumber: 1,
    issueTitle: 't',
    issueUrl: 'u',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'o/r',
    status: 'Todo',
    ...overrides,
  };
}

describe('selectFirstByStatus', () => {
  it('Status が dispatchStatuses に一致する最初の OPEN candidate を返す', () => {
    const a = makeCandidate({ itemId: 'a', status: 'In Progress' });
    const b = makeCandidate({ itemId: 'b', status: 'Todo' });
    const c = makeCandidate({ itemId: 'c', status: 'Todo' });
    expect(selectFirstByStatus({ candidates: [a, b, c] })?.itemId).toBe('b');
  });

  it('OPEN でない candidate はスキップする', () => {
    const a = makeCandidate({ itemId: 'a', status: 'Todo', issueState: 'CLOSED' });
    const b = makeCandidate({ itemId: 'b', status: 'Todo' });
    expect(selectFirstByStatus({ candidates: [a, b] })?.itemId).toBe('b');
  });

  it('該当なしのとき null を返す', () => {
    const a = makeCandidate({ status: 'In Progress' });
    expect(selectFirstByStatus({ candidates: [a] })).toBeNull();
  });

  it('dispatchStatuses を変えると別の Status が対象になる (#38 forward-compat)', () => {
    const a = makeCandidate({ itemId: 'a', status: 'Todo' });
    const b = makeCandidate({ itemId: 'b', status: 'Ready for Agent' });
    expect(
      selectFirstByStatus({ candidates: [a, b], dispatchStatuses: ['Ready for Agent'] })?.itemId,
    ).toBe('b');
  });

  it('dispatchStatuses 外の Status (In Progress / Done 等) は dispatch されない (#38)', () => {
    const inProgress = makeCandidate({ itemId: 'a', status: 'In Progress' });
    const done = makeCandidate({ itemId: 'b', status: 'Done' });
    const todo = makeCandidate({ itemId: 'c', status: 'Todo' });
    expect(
      selectFirstByStatus({
        candidates: [inProgress, done, todo],
        dispatchStatuses: ['Ready for Agent'],
      }),
    ).toBeNull();
  });
});

describe('isAcceptableIssue', () => {
  it('agent:skip ラベル付きは reject', () => {
    const result = isAcceptableIssue({
      labels: [{ name: 'agent:skip' }],
      assignees: [],
      agentUserLogin: null,
    });
    expect(result).toEqual({ ok: false, reason: 'skip_label' });
  });

  it('assignee 未指定は accept', () => {
    expect(
      isAcceptableIssue({ labels: [], assignees: [], agentUserLogin: 'philharmonic-bot' }),
    ).toEqual({ ok: true });
  });

  it('agent_user_login と一致する assignee があれば accept', () => {
    expect(
      isAcceptableIssue({
        labels: [],
        assignees: [{ login: 'human' }, { login: 'philharmonic-bot' }],
        agentUserLogin: 'philharmonic-bot',
      }),
    ).toEqual({ ok: true });
  });

  it('agent_user_login が null で assignee がいる場合は assignee_mismatch', () => {
    const result = isAcceptableIssue({
      labels: [],
      assignees: [{ login: 'human' }],
      agentUserLogin: null,
    });
    expect(result).toEqual({ ok: false, reason: 'assignee_mismatch' });
  });

  it('agent_user_login と一致しない assignee のみは assignee_mismatch', () => {
    const result = isAcceptableIssue({
      labels: [],
      assignees: [{ login: 'human' }],
      agentUserLogin: 'philharmonic-bot',
    });
    expect(result).toEqual({ ok: false, reason: 'assignee_mismatch' });
  });
});
