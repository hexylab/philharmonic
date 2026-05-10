/**
 * Project candidate を依存解決状態 (`ready` / `blocked` / `invalid_dependency` / `cycle`) に
 * 分類する evaluator (ADR-0007 §5 split 2)。
 *
 * 入力 candidate は **既に candidate selection (status / assignee / `agent:skip` / worktree /
 * in-flight) を通過済み** の前提。本モジュールは DAG 層のみを担当する。
 *
 * 依存先 Issue の state は次の優先順位で解決する。
 * 1. candidate 自身: 既に取得済みの `Candidate.issueState` / `body` を再利用 (追加 fetch なし)
 * 2. それ以外: caller が渡す `fetchIssue` を呼ぶ。同 evaluation 内では cache (1 issue 1 fetch)
 *
 * 出力順は `input.candidates` の順序を **そのまま維持** する (board 順 = ready issue 優先順位)。
 *
 * 分類の precedence: `cycle` > `invalid_dependency` > `blocked` > `ready`。
 * 1 candidate が複数条件に該当する場合も上位 1 つだけが報告される。
 */

import type { Candidate } from '../projects/index.js';

import { isInCycle, tarjanScc } from './cycle.js';
import { parseDependsOn, type DependencyEntry } from './parse.js';

export type DagCandidateState = 'ready' | 'blocked' | 'invalid_dependency' | 'cycle';

export type InvalidDependencyReason = 'parse_invalid' | 'not_found' | 'forbidden' | 'fetch_error';

export type InvalidDependencyDetail = {
  /** parse-invalid の場合は entry の原文、fetch 失敗の場合は `#<number>` */
  readonly raw: string;
  /** parse 成功かつ fetch 段で失敗した場合は Issue 番号、parse-invalid の場合は null */
  readonly issueNumber: number | null;
  readonly reason: InvalidDependencyReason;
  /** `fetch_error` のときの message。それ以外は undefined */
  readonly message?: string;
};

export type EvaluatedCandidate =
  | { state: 'ready'; candidate: Candidate }
  | { state: 'blocked'; candidate: Candidate; blockingIssueNumbers: readonly number[] }
  | {
      state: 'invalid_dependency';
      candidate: Candidate;
      invalidEntries: readonly InvalidDependencyDetail[];
    }
  | { state: 'cycle'; candidate: Candidate; cycleIssueNumbers: readonly number[] };

export type DependencyIssueState = 'open' | 'closed';

export type DependencyIssueLookupResult =
  | { kind: 'found'; state: DependencyIssueState; body: string | null }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

export type FetchDependencyIssue = (issueNumber: number) => Promise<DependencyIssueLookupResult>;

export type CandidateWithBody = {
  readonly candidate: Candidate;
  readonly body: string | null;
};

export type EvaluateDependencyDagInput = {
  readonly candidates: readonly CandidateWithBody[];
  readonly fetchIssue: FetchDependencyIssue;
};

export async function evaluateDependencyDag(
  input: EvaluateDependencyDagInput,
): Promise<EvaluatedCandidate[]> {
  const resolutions = new Map<number, DependencyIssueLookupResult>();

  for (const { candidate, body } of input.candidates) {
    resolutions.set(candidate.issueNumber, {
      kind: 'found',
      state: candidate.issueState === 'OPEN' ? 'open' : 'closed',
      body: body,
    });
  }

  const queue: number[] = [];
  const queued = new Set<number>(resolutions.keys());

  const enqueueFromBody = (body: string | null): void => {
    if (body === null) return;
    for (const entry of parseDependsOn(body)) {
      if (!entry.valid || entry.issueNumber === null) continue;
      if (queued.has(entry.issueNumber)) continue;
      queued.add(entry.issueNumber);
      queue.push(entry.issueNumber);
    }
  };

  for (const { body } of input.candidates) {
    enqueueFromBody(body);
  }

  while (queue.length > 0) {
    const next = queue.shift() as number;
    if (resolutions.has(next)) continue;
    const result = await input.fetchIssue(next);
    resolutions.set(next, result);
    if (result.kind === 'found') {
      enqueueFromBody(result.body);
    }
  }

  const allNodes = new Set<number>(resolutions.keys());
  const edges = new Map<number, number[]>();
  for (const [node, resolution] of resolutions) {
    const out: number[] = [];
    if (resolution.kind === 'found' && resolution.body !== null) {
      for (const entry of parseDependsOn(resolution.body)) {
        if (entry.valid && entry.issueNumber !== null) {
          out.push(entry.issueNumber);
          allNodes.add(entry.issueNumber);
        }
      }
    }
    edges.set(node, out);
  }
  for (const node of allNodes) {
    if (!edges.has(node)) edges.set(node, []);
  }

  const sccs = tarjanScc(allNodes, edges);
  const sccByNode = new Map<number, ReadonlySet<number>>();
  for (const scc of sccs) {
    const set = new Set(scc);
    for (const member of scc) sccByNode.set(member, set);
  }

  const results: EvaluatedCandidate[] = [];
  for (const { candidate, body } of input.candidates) {
    const parsed = parseDependsOn(body ?? '');

    if (isInCycle(candidate.issueNumber, edges, sccByNode)) {
      const sccSet = sccByNode.get(candidate.issueNumber) as ReadonlySet<number>;
      const cycleIssueNumbers = [...sccSet].sort((a, b) => a - b);
      results.push({ state: 'cycle', candidate, cycleIssueNumbers });
      continue;
    }

    const invalidEntries = collectInvalidEntries(parsed, resolutions);
    if (invalidEntries.length > 0) {
      results.push({ state: 'invalid_dependency', candidate, invalidEntries });
      continue;
    }

    const blocking: number[] = [];
    for (const entry of parsed) {
      if (!entry.valid || entry.issueNumber === null) continue;
      const r = resolutions.get(entry.issueNumber);
      if (r !== undefined && r.kind === 'found' && r.state === 'open') {
        blocking.push(entry.issueNumber);
      }
    }
    if (blocking.length > 0) {
      results.push({ state: 'blocked', candidate, blockingIssueNumbers: blocking });
      continue;
    }

    results.push({ state: 'ready', candidate });
  }

  return results;
}

function collectInvalidEntries(
  parsed: readonly DependencyEntry[],
  resolutions: ReadonlyMap<number, DependencyIssueLookupResult>,
): InvalidDependencyDetail[] {
  const out: InvalidDependencyDetail[] = [];
  for (const entry of parsed) {
    if (!entry.valid) {
      out.push({ raw: entry.raw, issueNumber: null, reason: 'parse_invalid' });
      continue;
    }
    if (entry.issueNumber === null) continue;
    const r = resolutions.get(entry.issueNumber);
    if (r === undefined) continue;
    if (r.kind === 'not_found') {
      out.push({
        raw: `#${entry.issueNumber}`,
        issueNumber: entry.issueNumber,
        reason: 'not_found',
      });
    } else if (r.kind === 'forbidden') {
      out.push({
        raw: `#${entry.issueNumber}`,
        issueNumber: entry.issueNumber,
        reason: 'forbidden',
      });
    } else if (r.kind === 'error') {
      out.push({
        raw: `#${entry.issueNumber}`,
        issueNumber: entry.issueNumber,
        reason: 'fetch_error',
        message: r.message,
      });
    }
  }
  return out;
}

/**
 * `evaluateDependencyDag` の結果から `ready` だけを抽出する thin helper。
 *
 * 入力順を維持するため `Array.filter` で 1 段絞るだけ。
 */
export function pickReadyCandidates(evaluations: readonly EvaluatedCandidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const e of evaluations) {
    if (e.state === 'ready') out.push(e.candidate);
  }
  return out;
}
