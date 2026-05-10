import type { GitHubClient, OpenPullRequest } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate } from '../projects/index.js';

import type { IssueWorktree } from './clean.js';
import type { WorkspaceManager } from './manager.js';

/**
 * worktree を cleanup してよいかの判定理由。
 *
 * - `terminal_status` — Project Status が terminal_statuses に含まれる
 * - `issue_closed` — GitHub Issue が close 済み (Project Status は不問)
 */
export type StaleCleanupReason = 'terminal_status' | 'issue_closed';

/**
 * cleanup を skip した理由。安全条件違反 / 未確定なケースを表す。
 */
export type StaleCleanupSkipReason =
  | 'no_project_item'
  | 'non_terminal_status'
  | 'issue_open_non_terminal'
  | 'open_pr_exists'
  | 'active_run';

export type StaleCleanupCandidate = {
  worktree: IssueWorktree;
  issueNumber: number;
  status: string | null;
  reason: StaleCleanupReason;
  branchDeletable: boolean;
  openPullRequests: readonly OpenPullRequest[];
};

export type StaleCleanupSkip = {
  worktree: IssueWorktree;
  issueNumber: number;
  status: string | null;
  reason: StaleCleanupSkipReason;
  openPullRequests: readonly OpenPullRequest[];
};

export type StaleCleanupPlan = {
  cleanups: readonly StaleCleanupCandidate[];
  skips: readonly StaleCleanupSkip[];
};

const TASK_KEY_PATTERN = /^issue-([1-9][0-9]*)$/;

function shouldDeleteBranch(taskKey: string, branch: string | null): boolean {
  if (branch === null) return false;
  const match = TASK_KEY_PATTERN.exec(taskKey);
  if (match === null) return false;
  return branch.startsWith(`feature/${match[1]}-`);
}

function parseIssueNumber(taskKey: string): number | null {
  const match = TASK_KEY_PATTERN.exec(taskKey);
  if (match === null) return null;
  return Number(match[1]);
}

export type IsRunningFn = (issueNumber: number) => boolean;

export type RepositoryRef = { owner: string; name: string };

export type ParseRepositoryFn = (nameWithOwner: string) => RepositoryRef;

export type PlanStaleWorktreeCleanupInput = {
  worktrees: readonly IssueWorktree[];
  candidates: readonly Candidate[];
  terminalStatuses: readonly string[];
  githubClient: Pick<GitHubClient, 'listOpenPullRequests'>;
  parseRepository: ParseRepositoryFn;
  isRunning?: IsRunningFn;
  logger?: Logger;
};

/**
 * `<workspace_root>/issue-<N>` worktree を Project candidates / open PR / runTracker と
 * 突き合わせて、安全に cleanup できる worktree と、skip した理由を返す。
 *
 * 安全条件:
 * - Issue が CLOSED, または Project Status ∈ terminal_statuses
 * - Active run (tracker) に積まれていない
 * - feature/<issue>- prefix の open PR が無い
 */
export async function planStaleWorktreeCleanup(
  input: PlanStaleWorktreeCleanupInput,
): Promise<StaleCleanupPlan> {
  const cleanups: StaleCleanupCandidate[] = [];
  const skips: StaleCleanupSkip[] = [];
  const candidateByIssue = new Map<number, Candidate>();
  for (const c of input.candidates) {
    candidateByIssue.set(c.issueNumber, c);
  }

  const terminalSet = new Set(input.terminalStatuses);
  const isRunning = input.isRunning ?? ((): boolean => false);

  for (const wt of input.worktrees) {
    const issueNumber = parseIssueNumber(wt.taskKey);
    if (issueNumber === null) continue;

    const candidate = candidateByIssue.get(issueNumber);
    if (candidate === undefined) {
      skips.push({
        worktree: wt,
        issueNumber,
        status: null,
        reason: 'no_project_item',
        openPullRequests: [],
      });
      continue;
    }

    if (isRunning(issueNumber)) {
      skips.push({
        worktree: wt,
        issueNumber,
        status: candidate.status,
        reason: 'active_run',
        openPullRequests: [],
      });
      continue;
    }

    const cleanupReason = pickCleanupReason(candidate, terminalSet);
    if (cleanupReason === null) {
      skips.push({
        worktree: wt,
        issueNumber,
        status: candidate.status,
        reason:
          candidate.issueState === 'OPEN' && candidate.status !== null
            ? 'issue_open_non_terminal'
            : 'non_terminal_status',
        openPullRequests: [],
      });
      continue;
    }

    const repository = input.parseRepository(candidate.repositoryNameWithOwner);
    const branchPrefix = `feature/${issueNumber}-`;
    let openPRs: readonly OpenPullRequest[] = [];
    try {
      openPRs = await input.githubClient.listOpenPullRequests({
        owner: repository.owner,
        repo: repository.name,
        headBranchPrefix: branchPrefix,
      });
    } catch (error) {
      input.logger?.warn('stale cleanup: listOpenPullRequests failed; skipping for safety', {
        issueNumber,
        error: describeError(error),
      });
      skips.push({
        worktree: wt,
        issueNumber,
        status: candidate.status,
        reason: 'open_pr_exists',
        openPullRequests: [],
      });
      continue;
    }

    if (openPRs.length > 0) {
      skips.push({
        worktree: wt,
        issueNumber,
        status: candidate.status,
        reason: 'open_pr_exists',
        openPullRequests: openPRs,
      });
      continue;
    }

    cleanups.push({
      worktree: wt,
      issueNumber,
      status: candidate.status,
      reason: cleanupReason,
      branchDeletable: shouldDeleteBranch(wt.taskKey, wt.branch),
      openPullRequests: [],
    });
  }

  return { cleanups, skips };
}

function pickCleanupReason(
  candidate: Candidate,
  terminalSet: ReadonlySet<string>,
): StaleCleanupReason | null {
  if (candidate.issueState === 'CLOSED') return 'issue_closed';
  if (candidate.status !== null && terminalSet.has(candidate.status)) return 'terminal_status';
  return null;
}

export type ExecuteStaleCleanupInput = {
  plan: StaleCleanupPlan;
  workspaceManager: Pick<WorkspaceManager, 'cleanupWorkspace'>;
  logger?: Logger;
};

export type StaleCleanupOutcome =
  | { kind: 'removed'; candidate: StaleCleanupCandidate }
  | { kind: 'failed'; candidate: StaleCleanupCandidate; error: string };

export type ExecuteStaleCleanupResult = {
  outcomes: readonly StaleCleanupOutcome[];
  removed: number;
  failed: number;
  skipped: number;
};

/**
 * `planStaleWorktreeCleanup` の plan を実行する。skip は plan の skips をそのまま log に流す。
 * 各 cleanup は個別に失敗してもループを止めない (運用上、孤児 worktree を一括処理する性質)。
 */
export async function executeStaleCleanup(
  input: ExecuteStaleCleanupInput,
): Promise<ExecuteStaleCleanupResult> {
  let removed = 0;
  let failed = 0;
  const skipped = input.plan.skips.length;
  const outcomes: StaleCleanupOutcome[] = [];

  for (const skip of input.plan.skips) {
    input.logger?.info('stale cleanup skip', {
      issueNumber: skip.issueNumber,
      status: skip.status,
      reason: skip.reason,
      workspacePath: skip.worktree.path,
      openPrCount: skip.openPullRequests.length,
    });
  }

  for (const c of input.plan.cleanups) {
    try {
      await input.workspaceManager.cleanupWorkspace({
        taskKey: c.worktree.taskKey,
        branch: c.branchDeletable ? (c.worktree.branch ?? undefined) : undefined,
        deleteBranch: c.branchDeletable,
      });
      input.logger?.info('stale cleanup removed', {
        issueNumber: c.issueNumber,
        status: c.status,
        reason: c.reason,
        workspacePath: c.worktree.path,
        branch: c.worktree.branch,
        branchDeleted: c.branchDeletable,
      });
      removed += 1;
      outcomes.push({ kind: 'removed', candidate: c });
    } catch (error) {
      const message = describeError(error);
      input.logger?.warn('stale cleanup failed', {
        issueNumber: c.issueNumber,
        status: c.status,
        reason: c.reason,
        workspacePath: c.worktree.path,
        error: message,
      });
      failed += 1;
      outcomes.push({ kind: 'failed', candidate: c, error: message });
    }
  }

  return { outcomes, removed, failed, skipped };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
