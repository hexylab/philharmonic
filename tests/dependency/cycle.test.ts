import { describe, expect, it } from 'vitest';

import { isInCycle, tarjanScc } from '../../src/dependency/cycle.js';

function asEdges(map: Record<number, number[]>): Map<number, number[]> {
  return new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

function sortInner(sccs: number[][]): number[][] {
  return sccs
    .map((scc) => [...scc].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

function sccByNode(sccs: number[][]): Map<number, ReadonlySet<number>> {
  const map = new Map<number, ReadonlySet<number>>();
  for (const scc of sccs) {
    const set = new Set(scc);
    for (const n of scc) map.set(n, set);
  }
  return map;
}

describe('tarjanScc', () => {
  it('辺の無いグラフは各ノードが size 1 SCC になる', () => {
    const edges = asEdges({ 1: [], 2: [], 3: [] });
    expect(sortInner(tarjanScc([1, 2, 3], edges))).toEqual([[1], [2], [3]]);
  });

  it('A -> B -> C の DAG は 3 つの size 1 SCC を返す', () => {
    const edges = asEdges({ 1: [2], 2: [3], 3: [] });
    expect(sortInner(tarjanScc([1, 2, 3], edges))).toEqual([[1], [2], [3]]);
  });

  it('A -> B, B -> A の 2 ノード循環は 1 つの size 2 SCC を返す', () => {
    const edges = asEdges({ 1: [2], 2: [1] });
    expect(sortInner(tarjanScc([1, 2], edges))).toEqual([[1, 2]]);
  });

  it('A -> B -> C -> A の 3 ノード循環は 1 つの size 3 SCC を返す', () => {
    const edges = asEdges({ 1: [2], 2: [3], 3: [1] });
    expect(sortInner(tarjanScc([1, 2, 3], edges))).toEqual([[1, 2, 3]]);
  });

  it('self-loop (A -> A) でも標準 Tarjan は size 1 SCC を返す (cycle 判定は isInCycle 側)', () => {
    const edges = asEdges({ 1: [1] });
    expect(sortInner(tarjanScc([1], edges))).toEqual([[1]]);
  });

  it('循環と非循環が混在する複合グラフを正しく分割する', () => {
    // 1 -> 2 -> 3 -> 2, 4 -> 5
    const edges = asEdges({ 1: [2], 2: [3], 3: [2], 4: [5], 5: [] });
    expect(sortInner(tarjanScc([1, 2, 3, 4, 5], edges))).toEqual([[1], [2, 3], [4], [5]]);
  });

  it('参照されているが nodes に渡されていないノードも edge を辿って訪問する', () => {
    const edges = asEdges({ 1: [2], 2: [1] });
    expect(sortInner(tarjanScc([1], edges))).toEqual([[1, 2]]);
  });
});

describe('isInCycle', () => {
  it('size 2 以上の SCC に属するノードは cycle と判定される', () => {
    const edges = asEdges({ 1: [2], 2: [1] });
    const sccs = tarjanScc([1, 2], edges);
    const map = sccByNode(sccs);
    expect(isInCycle(1, edges, map)).toBe(true);
    expect(isInCycle(2, edges, map)).toBe(true);
  });

  it('self-loop (A -> A) は size 1 SCC でも cycle と判定される', () => {
    const edges = asEdges({ 1: [1] });
    const sccs = tarjanScc([1], edges);
    const map = sccByNode(sccs);
    expect(isInCycle(1, edges, map)).toBe(true);
  });

  it('辺の無いノードは cycle ではない', () => {
    const edges = asEdges({ 1: [] });
    const sccs = tarjanScc([1], edges);
    const map = sccByNode(sccs);
    expect(isInCycle(1, edges, map)).toBe(false);
  });

  it('SCC map に存在しないノードは cycle ではない', () => {
    const edges = asEdges({ 1: [] });
    const sccs = tarjanScc([1], edges);
    const map = sccByNode(sccs);
    expect(isInCycle(99, edges, map)).toBe(false);
  });
});
