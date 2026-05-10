import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { GitHubClient, OpenPullRequest } from '../../src/github/index.js';
import { parseRepositoryNameWithOwner } from '../../src/orchestrator/index.js';
import type { Candidate } from '../../src/projects/index.js';
import {
  executeStaleCleanup,
  planStaleWorktreeCleanup,
  type IssueWorktree,
  type StaleCleanupPlan,
  type WorkspaceManager,
} from '../../src/workspace/index.js';

const REPO_ROOT = '/tmp/repo';

function fakeWorktree(taskKey: string, branch: string | null): IssueWorktree {
  return {
    taskKey,
    path: path.join(REPO_ROOT, '.philharmonic/worktrees', taskKey),
    branch,
    mtimeMs: Date.now(),
  };
}

function fakeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_x',
    issueNumber: 1,
    issueTitle: 'foo',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/1',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'Done',
    ...overrides,
  };
}

function fakeGitHubClient(
  listOpenPullRequests: GitHubClient['listOpenPullRequests'] = vi.fn(async () => []),
): Pick<GitHubClient, 'listOpenPullRequests'> {
  return { listOpenPullRequests };
}

describe('planStaleWorktreeCleanup', () => {
  it('Project Status が terminal_statuses に含まれる worktree を cleanup 対象として返す', async () => {
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-1', 'feature/1-foo')],
      candidates: [fakeCandidate({ issueNumber: 1, status: 'Done' })],
      terminalStatuses: ['Done'],
      githubClient: fakeGitHubClient(),
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(1);
    expect(plan.cleanups[0]!.reason).toBe('terminal_status');
    expect(plan.cleanups[0]!.branchDeletable).toBe(true);
    expect(plan.skips).toHaveLength(0);
  });

  it('Issue が CLOSED なら Status を問わず cleanup する (issue_closed)', async () => {
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-2', 'feature/2-bar')],
      candidates: [fakeCandidate({ issueNumber: 2, status: 'In Progress', issueState: 'CLOSED' })],
      terminalStatuses: ['Done'],
      githubClient: fakeGitHubClient(),
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(1);
    expect(plan.cleanups[0]!.reason).toBe('issue_closed');
  });

  it('Open PR が存在する worktree は open_pr_exists で skip する', async () => {
    const pr: OpenPullRequest = {
      number: 99,
      headRef: 'feature/3-baz',
      htmlUrl: 'https://github.com/hexylab/philharmonic/pull/99',
    };
    const listOpenPullRequests = vi.fn(async () => [pr]);
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-3', 'feature/3-baz')],
      candidates: [fakeCandidate({ issueNumber: 3, status: 'Done' })],
      terminalStatuses: ['Done'],
      githubClient: { listOpenPullRequests },
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]!.reason).toBe('open_pr_exists');
    expect(plan.skips[0]!.openPullRequests).toHaveLength(1);
  });

  it.each([['Todo'], ['In Progress'], ['In Review'], ['Failed']])(
    'Open Issue の Status=%s は cleanup 対象外 (issue_open_non_terminal で skip)',
    async (status) => {
      const plan = await planStaleWorktreeCleanup({
        worktrees: [fakeWorktree('issue-4', 'feature/4-x')],
        candidates: [fakeCandidate({ issueNumber: 4, status })],
        terminalStatuses: ['Done'],
        githubClient: fakeGitHubClient(),
        parseRepository: parseRepositoryNameWithOwner,
      });
      expect(plan.cleanups).toHaveLength(0);
      expect(plan.skips).toHaveLength(1);
      expect(plan.skips[0]!.reason).toBe('issue_open_non_terminal');
    },
  );

  it('Project Item に該当しない worktree は no_project_item で skip する', async () => {
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-5', 'feature/5-foo')],
      candidates: [],
      terminalStatuses: ['Done'],
      githubClient: fakeGitHubClient(),
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]!.reason).toBe('no_project_item');
  });

  it('isRunning が true を返す worktree は active_run で skip する (PR fetch も行わない)', async () => {
    const listOpenPullRequests = vi.fn(async () => []);
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-6', 'feature/6-foo')],
      candidates: [fakeCandidate({ issueNumber: 6, status: 'Done' })],
      terminalStatuses: ['Done'],
      githubClient: { listOpenPullRequests },
      parseRepository: parseRepositoryNameWithOwner,
      isRunning: (n) => n === 6,
    });
    expect(plan.cleanups).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]!.reason).toBe('active_run');
    expect(listOpenPullRequests).not.toHaveBeenCalled();
  });

  it('main branch を checkout している worktree は cleanup 対象になっても branch を削除しない', async () => {
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-7', 'main')],
      candidates: [fakeCandidate({ issueNumber: 7, status: 'Done' })],
      terminalStatuses: ['Done'],
      githubClient: fakeGitHubClient(),
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(1);
    expect(plan.cleanups[0]!.branchDeletable).toBe(false);
  });

  it('detached HEAD の worktree は branch 削除なしで cleanup 対象になる', async () => {
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-8', null)],
      candidates: [fakeCandidate({ issueNumber: 8, status: 'Done' })],
      terminalStatuses: ['Done'],
      githubClient: fakeGitHubClient(),
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(1);
    expect(plan.cleanups[0]!.branchDeletable).toBe(false);
  });

  it('listOpenPullRequests が失敗したら open_pr_exists 扱いで skip する (安全側)', async () => {
    const listOpenPullRequests = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-9', 'feature/9-foo')],
      candidates: [fakeCandidate({ issueNumber: 9, status: 'Done' })],
      terminalStatuses: ['Done'],
      githubClient: { listOpenPullRequests },
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]!.reason).toBe('open_pr_exists');
  });

  it('terminal_statuses のカスタム値を解釈する (Done 以外も使える)', async () => {
    const plan = await planStaleWorktreeCleanup({
      worktrees: [fakeWorktree('issue-10', 'feature/10-foo')],
      candidates: [fakeCandidate({ issueNumber: 10, status: 'Archived' })],
      terminalStatuses: ['Archived'],
      githubClient: fakeGitHubClient(),
      parseRepository: parseRepositoryNameWithOwner,
    });
    expect(plan.cleanups).toHaveLength(1);
  });
});

describe('executeStaleCleanup', () => {
  function fakeWorkspaceManager(): Pick<WorkspaceManager, 'cleanupWorkspace'> {
    return { cleanupWorkspace: vi.fn(async () => undefined) };
  }

  it('cleanups 各件で workspaceManager.cleanupWorkspace を呼ぶ', async () => {
    const manager = fakeWorkspaceManager();
    const cleanups = [
      {
        worktree: fakeWorktree('issue-1', 'feature/1-foo'),
        issueNumber: 1,
        status: 'Done',
        reason: 'terminal_status' as const,
        branchDeletable: true,
        openPullRequests: [],
      },
    ];
    const result = await executeStaleCleanup({
      plan: { cleanups, skips: [] },
      workspaceManager: manager,
    });
    expect(result).toEqual({ removed: 1, failed: 0, skipped: 0 });
    expect(manager.cleanupWorkspace).toHaveBeenCalledWith({
      taskKey: 'issue-1',
      branch: 'feature/1-foo',
      deleteBranch: true,
    });
  });

  it('branchDeletable=false なら deleteBranch も false で渡す (main 等の保護)', async () => {
    const manager = fakeWorkspaceManager();
    const cleanups = [
      {
        worktree: fakeWorktree('issue-1', 'main'),
        issueNumber: 1,
        status: 'Done',
        reason: 'terminal_status' as const,
        branchDeletable: false,
        openPullRequests: [],
      },
    ];
    await executeStaleCleanup({
      plan: { cleanups, skips: [] },
      workspaceManager: manager,
    });
    expect(manager.cleanupWorkspace).toHaveBeenCalledWith({
      taskKey: 'issue-1',
      branch: undefined,
      deleteBranch: false,
    });
  });

  it('1 件失敗しても残りは続行し、failed 数を報告する', async () => {
    const manager = {
      cleanupWorkspace: vi.fn(async (input: { taskKey: string }) => {
        if (input.taskKey === 'issue-1') throw new Error('boom');
      }),
    };
    const plan: StaleCleanupPlan = {
      cleanups: [
        {
          worktree: fakeWorktree('issue-1', 'feature/1-foo'),
          issueNumber: 1,
          status: 'Done',
          reason: 'terminal_status',
          branchDeletable: true,
          openPullRequests: [],
        },
        {
          worktree: fakeWorktree('issue-2', 'feature/2-bar'),
          issueNumber: 2,
          status: 'Done',
          reason: 'terminal_status',
          branchDeletable: true,
          openPullRequests: [],
        },
      ],
      skips: [],
    };
    const result = await executeStaleCleanup({
      plan,
      workspaceManager: manager,
    });
    expect(result).toEqual({ removed: 1, failed: 1, skipped: 0 });
    expect(manager.cleanupWorkspace).toHaveBeenCalledTimes(2);
  });
});
