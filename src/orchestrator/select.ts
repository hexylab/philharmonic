import type { Candidate } from '../projects/index.js';

export const DEFAULT_DISPATCH_STATUSES = ['Todo'] as const;
export const DEFAULT_SKIP_LABEL = 'agent:skip';

export type SelectCandidateInput = {
  candidates: readonly Candidate[];
  dispatchStatuses?: readonly string[];
};

/**
 * Status / OPEN フィルタの第 1 段階を判定する utility predicate。
 *
 * `runOnce` / `runConcurrent` 本体は ADR-0007 の dependency filter と組み合わせるため
 * 直接利用しないが、Status fallback 等の一発判定が必要な caller (テスト含む) のために公開を維持する。
 */
export function selectFirstByStatus(input: SelectCandidateInput): Candidate | null {
  const statuses = input.dispatchStatuses ?? DEFAULT_DISPATCH_STATUSES;
  for (const c of input.candidates) {
    if (c.issueState !== 'OPEN') continue;
    if (c.status === null) continue;
    if (!statuses.includes(c.status)) continue;
    return c;
  }
  return null;
}

export type IssueAssigneeView = { login: string };
export type IssueLabelView = { name: string };

export type IsAcceptableIssueInput = {
  labels: readonly IssueLabelView[];
  assignees: readonly IssueAssigneeView[];
  agentUserLogin: string | null;
  skipLabel?: string;
};

export type IsAcceptableIssueResult =
  | { ok: true }
  | { ok: false; reason: 'skip_label' | 'assignee_mismatch' };

export function isAcceptableIssue(input: IsAcceptableIssueInput): IsAcceptableIssueResult {
  const skipLabel = input.skipLabel ?? DEFAULT_SKIP_LABEL;
  if (input.labels.some((l) => l.name === skipLabel)) {
    return { ok: false, reason: 'skip_label' };
  }
  if (input.assignees.length === 0) return { ok: true };
  if (input.agentUserLogin === null) {
    return { ok: false, reason: 'assignee_mismatch' };
  }
  if (input.assignees.some((a) => a.login === input.agentUserLogin)) {
    return { ok: true };
  }
  return { ok: false, reason: 'assignee_mismatch' };
}

/**
 * 二重 dispatch ガード (ADR-0005)。
 *
 * agent が `Todo → In Progress` flip を行うようになったため、orchestrator が同 Issue を
 * 次 tick で再 pick するリスクがある。candidate selection の最終フィルタとして以下二段で skip する。
 *
 * - (a) worktree 既存: `<workspace_root>/issue-<番号>` が存在する場合 skip
 * - (b) in-flight tracker: 同 daemon の他 dispatch が走っている場合 skip
 *
 * いずれかにヒットすれば skip。両方とも false なら dispatch 可能。
 */
export type DispatchGuard = {
  workspaceExists(issueNumber: number): Promise<boolean>;
  isRunning(issueNumber: number): boolean;
};

export type DispatchGuardSkipReason = 'workspace_exists' | 'tracker_in_flight';

export type CheckDispatchGuardResult =
  | { ok: true }
  | { ok: false; reason: DispatchGuardSkipReason };

export async function checkDispatchGuard(
  guard: DispatchGuard,
  issueNumber: number,
): Promise<CheckDispatchGuardResult> {
  if (guard.isRunning(issueNumber)) {
    return { ok: false, reason: 'tracker_in_flight' };
  }
  if (await guard.workspaceExists(issueNumber)) {
    return { ok: false, reason: 'workspace_exists' };
  }
  return { ok: true };
}
