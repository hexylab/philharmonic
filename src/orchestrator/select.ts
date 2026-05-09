import type { Candidate } from '../projects/index.js';

export const DEFAULT_DISPATCH_STATUSES = ['Todo'] as const;
export const DEFAULT_SKIP_LABEL = 'agent:skip';

export type SelectCandidateInput = {
  candidates: readonly Candidate[];
  dispatchStatuses?: readonly string[];
};

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
