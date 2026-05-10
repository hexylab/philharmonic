/**
 * 強連結成分 (SCC) を検出する Tarjan の iterative 実装 (ADR-0007 §5 split 2)。
 *
 * 入力は `nodes` (ノード集合) と `edges` (各ノードの後続リスト)。
 * 戻り値は SCC のリストで、各 SCC は同じ強連結成分に属するノード番号の配列。
 *
 * 標準の Tarjan は **単一ノードの self-loop を size=1 SCC として報告する**。
 * cycle 判定 (size > 1 OR self-loop edge) は caller (`resolve.ts`) 側で行う。
 *
 * 実装は再帰呼び出しを使わない explicit stack 形式。Issue 依存グラフは実用上小さい
 * (< 数十ノード) が、外部入力 (Issue body) で深い chain が作られるリスクを避ける。
 */
export function tarjanScc(
  nodes: Iterable<number>,
  edges: ReadonlyMap<number, readonly number[]>,
): number[][] {
  const indices = new Map<number, number>();
  const lowlinks = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];
  let nextIndex = 0;

  type Frame = { node: number; cursor: number };

  const visit = (root: number): void => {
    const callStack: Frame[] = [];
    enter(root, callStack);
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1] as Frame;
      const succs = edges.get(frame.node) ?? [];
      if (frame.cursor < succs.length) {
        const w = succs[frame.cursor] as number;
        frame.cursor += 1;
        if (!indices.has(w)) {
          enter(w, callStack);
        } else if (onStack.has(w)) {
          const vLow = lowlinks.get(frame.node) as number;
          const wIdx = indices.get(w) as number;
          if (wIdx < vLow) {
            lowlinks.set(frame.node, wIdx);
          }
        }
      } else {
        const v = frame.node;
        callStack.pop();
        const vLow = lowlinks.get(v) as number;
        const vIdx = indices.get(v) as number;
        if (vLow === vIdx) {
          const component: number[] = [];
          while (true) {
            const w = stack.pop() as number;
            onStack.delete(w);
            component.push(w);
            if (w === v) break;
          }
          sccs.push(component);
        }
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1] as Frame;
          const parentLow = lowlinks.get(parent.node) as number;
          if (vLow < parentLow) {
            lowlinks.set(parent.node, vLow);
          }
        }
      }
    }
  };

  const enter = (v: number, callStack: Frame[]): void => {
    indices.set(v, nextIndex);
    lowlinks.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);
    callStack.push({ node: v, cursor: 0 });
  };

  for (const v of nodes) {
    if (!indices.has(v)) {
      visit(v);
    }
  }

  return sccs;
}

/**
 * `node` がグラフの cycle に属するかを判定する。
 *
 * - self-loop (`n -> n` edge を持つ単一ノード SCC) は cycle として扱う
 * - size > 1 の SCC に属するノードも cycle として扱う
 *
 * `sccByNode` は Tarjan SCC の結果から構築した node -> 同 SCC ノード集合の map。
 */
export function isInCycle(
  node: number,
  edges: ReadonlyMap<number, readonly number[]>,
  sccByNode: ReadonlyMap<number, ReadonlySet<number>>,
): boolean {
  const scc = sccByNode.get(node);
  if (scc === undefined) return false;
  if (scc.size > 1) return true;
  const out = edges.get(node) ?? [];
  return out.includes(node);
}
