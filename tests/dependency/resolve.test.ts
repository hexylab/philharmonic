import { describe, expect, it, vi } from 'vitest';

import {
  evaluateDependencyDag,
  pickReadyCandidates,
  type CandidateWithBody,
  type DependencyIssueLookupResult,
  type FetchDependencyIssue,
} from '../../src/dependency/resolve.js';
import type { Candidate } from '../../src/projects/index.js';

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: `PVTI_${overrides.issueNumber ?? 1}`,
    issueNumber: 1,
    issueTitle: 'title',
    issueUrl: 'https://example.com',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'o/r',
    status: 'Todo',
    ...overrides,
  };
}

function withBody(candidate: Candidate, body: string | null): CandidateWithBody {
  return { candidate, body };
}

function fetcherFromMap(map: Map<number, DependencyIssueLookupResult>): FetchDependencyIssue {
  return async (issueNumber) => {
    const result = map.get(issueNumber);
    if (result === undefined) return { kind: 'not_found' };
    return result;
  };
}

const NEVER_FETCH: FetchDependencyIssue = async (issueNumber) => {
  throw new Error(`unexpected fetch for #${issueNumber}`);
};

describe('evaluateDependencyDag', () => {
  it('Depends-On 行の無い candidate は ready', async () => {
    const c = makeCandidate({ issueNumber: 1 });
    const result = await evaluateDependencyDag({
      candidates: [withBody(c, '# Goal\n')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ state: 'ready', candidate: c });
  });

  it('依存先がすべて closed の candidate は ready (REST fetch あり)', async () => {
    const c = makeCandidate({ issueNumber: 10 });
    const fetcher = fetcherFromMap(
      new Map([
        [20, { kind: 'found', state: 'closed', body: null }],
        [21, { kind: 'found', state: 'closed', body: '' }],
      ]),
    );

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #20, #21')],
      fetchIssue: fetcher,
    });

    expect(result[0]).toEqual({ state: 'ready', candidate: c });
  });

  it('依存先が同じ candidate に既に含まれる場合は fetch せずに candidate.issueState を使う', async () => {
    const a = makeCandidate({ issueNumber: 1 });
    const b = makeCandidate({ issueNumber: 2 });
    const fetcher = vi.fn<FetchDependencyIssue>(async () => {
      throw new Error('should not be called');
    });

    // a depends on b, b is in the candidates list and OPEN -> a is blocked
    const result = await evaluateDependencyDag({
      candidates: [withBody(a, 'Depends-On: #2'), withBody(b, '')],
      fetchIssue: fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ state: 'blocked', candidate: a, blockingIssueNumbers: [2] });
    expect(result[1]).toMatchObject({ state: 'ready', candidate: b });
  });

  it('candidate の依存先に open Issue が 1 件でもあれば blocked (blockingIssueNumbers を返す)', async () => {
    const c = makeCandidate({ issueNumber: 1 });
    const fetcher = fetcherFromMap(
      new Map([
        [10, { kind: 'found', state: 'closed', body: null }],
        [11, { kind: 'found', state: 'open', body: null }],
        [12, { kind: 'found', state: 'open', body: null }],
      ]),
    );

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #10, #11, #12')],
      fetchIssue: fetcher,
    });

    expect(result[0]).toEqual({
      state: 'blocked',
      candidate: c,
      blockingIssueNumbers: [11, 12],
    });
  });

  it('parse-invalid な entry (cross-repo / 数値以外) は invalid_dependency', async () => {
    const c = makeCandidate({ issueNumber: 1 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: hexylab/philharmonic#42, foo')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result[0]).toMatchObject({
      state: 'invalid_dependency',
      candidate: c,
      invalidEntries: [
        { raw: 'hexylab/philharmonic#42', issueNumber: null, reason: 'parse_invalid' },
        { raw: 'foo', issueNumber: null, reason: 'parse_invalid' },
      ],
    });
  });

  it('依存先が 404 (not_found) なら invalid_dependency (`reason: not_found`)', async () => {
    const c = makeCandidate({ issueNumber: 1 });
    const fetcher = fetcherFromMap(new Map([[99, { kind: 'not_found' }]]));

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #99')],
      fetchIssue: fetcher,
    });

    expect(result[0]).toMatchObject({
      state: 'invalid_dependency',
      candidate: c,
      invalidEntries: [{ raw: '#99', issueNumber: 99, reason: 'not_found' }],
    });
  });

  it('依存先が 403 (forbidden) なら invalid_dependency (`reason: forbidden`)', async () => {
    const c = makeCandidate({ issueNumber: 1 });
    const fetcher = fetcherFromMap(new Map([[55, { kind: 'forbidden' }]]));

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #55')],
      fetchIssue: fetcher,
    });

    expect(result[0]).toMatchObject({
      state: 'invalid_dependency',
      invalidEntries: [{ raw: '#55', issueNumber: 55, reason: 'forbidden' }],
    });
  });

  it('依存先 fetch が network error なら invalid_dependency (`reason: fetch_error`, message を保持)', async () => {
    const c = makeCandidate({ issueNumber: 1 });
    const fetcher = fetcherFromMap(
      new Map([[7, { kind: 'error', message: 'ECONNRESET while fetching #7' }]]),
    );

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #7')],
      fetchIssue: fetcher,
    });

    expect(result[0]).toMatchObject({
      state: 'invalid_dependency',
      invalidEntries: [
        {
          raw: '#7',
          issueNumber: 7,
          reason: 'fetch_error',
          message: 'ECONNRESET while fetching #7',
        },
      ],
    });
  });

  it('self-dependency (`#self`) は cycle として扱う (cycleIssueNumbers = [self])', async () => {
    const c = makeCandidate({ issueNumber: 77 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #77')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result[0]).toEqual({
      state: 'cycle',
      candidate: c,
      cycleIssueNumbers: [77],
    });
  });

  it('candidate 同士の 2 ノード循環 (A -> B, B -> A) は両方 cycle で SCC を共有する', async () => {
    const a = makeCandidate({ issueNumber: 1 });
    const b = makeCandidate({ issueNumber: 2 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(a, 'Depends-On: #2'), withBody(b, 'Depends-On: #1')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result[0]).toEqual({ state: 'cycle', candidate: a, cycleIssueNumbers: [1, 2] });
    expect(result[1]).toEqual({ state: 'cycle', candidate: b, cycleIssueNumbers: [1, 2] });
  });

  it('間接 cycle (A -> B -> C -> A) も candidate 全員を cycle として扱う', async () => {
    const a = makeCandidate({ issueNumber: 1 });
    const b = makeCandidate({ issueNumber: 2 });
    const cc = makeCandidate({ issueNumber: 3 });

    const result = await evaluateDependencyDag({
      candidates: [
        withBody(a, 'Depends-On: #2'),
        withBody(b, 'Depends-On: #3'),
        withBody(cc, 'Depends-On: #1'),
      ],
      fetchIssue: NEVER_FETCH,
    });

    expect(result.map((r) => r.state)).toEqual(['cycle', 'cycle', 'cycle']);
    expect(
      (result[0] as Extract<(typeof result)[number], { state: 'cycle' }>).cycleIssueNumbers,
    ).toEqual([1, 2, 3]);
  });

  it('cycle と invalid_dependency が同時に該当する候補は cycle が優先される', async () => {
    const c = makeCandidate({ issueNumber: 5 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #5, foo')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result[0]?.state).toBe('cycle');
  });

  it('invalid_dependency と blocked が同時に該当する候補は invalid_dependency が優先される', async () => {
    const c = makeCandidate({ issueNumber: 1 });
    const fetcher = fetcherFromMap(
      new Map([
        [10, { kind: 'found', state: 'open', body: null }],
        [99, { kind: 'not_found' }],
      ]),
    );

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, 'Depends-On: #10, #99')],
      fetchIssue: fetcher,
    });

    expect(result[0]?.state).toBe('invalid_dependency');
  });

  it('cycle 外の candidate が cycle 内 Issue を依存先にしている場合は blocked (cycle として伝播しない)', async () => {
    const outside = makeCandidate({ issueNumber: 1 });
    // Issue #2 と #3 は外側の循環。outside は #2 を Depends-On する
    const fetcher = fetcherFromMap(
      new Map<number, DependencyIssueLookupResult>([
        [2, { kind: 'found', state: 'open', body: 'Depends-On: #3' }],
        [3, { kind: 'found', state: 'open', body: 'Depends-On: #2' }],
      ]),
    );

    const result = await evaluateDependencyDag({
      candidates: [withBody(outside, 'Depends-On: #2')],
      fetchIssue: fetcher,
    });

    expect(result[0]).toMatchObject({
      state: 'blocked',
      candidate: outside,
      blockingIssueNumbers: [2],
    });
  });

  it('1 evaluation 内で同じ依存先 Issue を重複 fetch しない (cache が効く)', async () => {
    const a = makeCandidate({ issueNumber: 1 });
    const b = makeCandidate({ issueNumber: 2 });
    const fetcher = vi.fn(async (n: number): Promise<DependencyIssueLookupResult> => {
      if (n === 99) return { kind: 'found', state: 'closed', body: null };
      throw new Error(`unexpected fetch for #${n}`);
    });

    await evaluateDependencyDag({
      candidates: [withBody(a, 'Depends-On: #99'), withBody(b, 'Depends-On: #99')],
      fetchIssue: fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(99);
  });

  it('入力 candidate の順序 (= board 順) を出力順としてそのまま維持する', async () => {
    const a = makeCandidate({ issueNumber: 30 });
    const b = makeCandidate({ issueNumber: 10 });
    const cc = makeCandidate({ issueNumber: 20 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(a, ''), withBody(b, ''), withBody(cc, '')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result.map((r) => r.candidate.issueNumber)).toEqual([30, 10, 20]);
  });

  it('candidate.body が null でも throw せず ready として扱う', async () => {
    const c = makeCandidate({ issueNumber: 1 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(c, null)],
      fetchIssue: NEVER_FETCH,
    });

    expect(result[0]).toEqual({ state: 'ready', candidate: c });
  });

  it('CLOSED candidate は依存先が無ければ ready (issueState を resolution に反映)', async () => {
    // candidate selection は通常 OPEN を渡すが、本モジュールは state を見てそのまま
    // resolution map に積む。CLOSED 候補は他者にとって resolved として扱われる。
    const closedDep = makeCandidate({ issueNumber: 50, issueState: 'CLOSED' });
    const blockedByClosedDep = makeCandidate({ issueNumber: 51 });

    const result = await evaluateDependencyDag({
      candidates: [withBody(closedDep, ''), withBody(blockedByClosedDep, 'Depends-On: #50')],
      fetchIssue: NEVER_FETCH,
    });

    expect(result[1]).toMatchObject({ state: 'ready', candidate: blockedByClosedDep });
  });
});

describe('pickReadyCandidates', () => {
  it('ready 状態のものだけを入力順で抽出する', () => {
    const a = makeCandidate({ issueNumber: 1 });
    const b = makeCandidate({ issueNumber: 2 });
    const cc = makeCandidate({ issueNumber: 3 });

    const ready = pickReadyCandidates([
      { state: 'ready', candidate: a },
      { state: 'blocked', candidate: b, blockingIssueNumbers: [99] },
      { state: 'ready', candidate: cc },
    ]);

    expect(ready.map((c) => c.issueNumber)).toEqual([1, 3]);
  });

  it('該当なしのとき空配列を返す', () => {
    expect(
      pickReadyCandidates([
        {
          state: 'cycle',
          candidate: makeCandidate({ issueNumber: 1 }),
          cycleIssueNumbers: [1],
        },
      ]),
    ).toEqual([]);
  });
});
