import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { type Config } from '../../src/config/index.js';
import { type GitHubClient } from '../../src/github/index.js';
import { createLogger } from '../../src/logger/index.js';
import { cleanupStaleWorktreesAtStartup } from '../../src/orchestrator/index.js';
import { type Candidate, type ProjectsClient } from '../../src/projects/index.js';
import { createRunTracker } from '../../src/server/index.js';
import type {
  IssueWorktree,
  ListIssueWorktreesInput,
  WorkspaceManager,
} from '../../src/workspace/index.js';

const REPO_ROOT = '/tmp/repo';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'hexylab',
    projectNumber: 1,
    baseBranch: 'main',
    statusField: 'Status',
    workflowFile: '.philharmonic/WORKFLOW.md',
    agentUserLogin: null,
    permissionMode: 'auto',
    timeoutMs: 1_800_000,
    killGracePeriodMs: 5_000,
    workspaceRoot: '.philharmonic/worktrees',
    dispatchStatuses: ['Todo'],
    terminalStatuses: ['Done'],
    statusTransitions: { inProgress: 'In Progress', inReview: 'In Review', failed: 'Failed' },
    cleanRetentionDays: 7,
    logLevel: 'info',
    polling: { intervalMs: 30_000 },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      stallTimeoutMs: 300_000,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    },
    hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
    server: null,
    github: { tokenSource: 'auto' },
    safety: { allowBypassInServe: false },
    ...overrides,
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

function fakeWorkspaceManager(): WorkspaceManager {
  return {
    resolveWorkspacePath: vi.fn(),
    createWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(async () => undefined),
    runHooks: vi.fn(async () => undefined),
  };
}

const noopGitRunner = vi.fn(async () => ({ stdout: '', stderr: '' }));

function listWith(
  ...worktrees: IssueWorktree[]
): (input: ListIssueWorktreesInput) => Promise<IssueWorktree[]> {
  return async () => worktrees;
}

function fakeWorktree(taskKey: string, branch: string | null): IssueWorktree {
  return {
    taskKey,
    path: path.join(REPO_ROOT, '.philharmonic/worktrees', taskKey),
    branch,
    mtimeMs: Date.now(),
  };
}

function fakeGitHubClient(prByPrefix: ReadonlyMap<string, number> = new Map()): GitHubClient {
  return {
    getIssue: vi.fn(),
    listOpenPullRequests: vi.fn(async (input) => {
      const prefix = input.headBranchPrefix ?? '';
      const n = prByPrefix.get(prefix);
      if (n === undefined) return [];
      return [
        {
          number: n,
          headRef: prefix + 'foo',
          htmlUrl: `https://github.com/${input.owner}/${input.repo}/pull/${n}`,
        },
      ];
    }),
  } as unknown as GitHubClient;
}

function fakeProjectsClient(candidates: readonly Candidate[]): ProjectsClient {
  return {
    fetchProjectCandidates: vi.fn(async () => [...candidates]),
    fetchProjectContext: vi.fn(),
  } as unknown as ProjectsClient;
}

const SILENT_LOGGER = createLogger({
  level: 'error',
  destination: { write: () => true } as unknown as NodeJS.WritableStream,
});

describe('cleanupStaleWorktreesAtStartup', () => {
  it('issue-* worktree が無い場合は GitHub API を叩かず early-return する', async () => {
    const projectsClient = fakeProjectsClient([]);
    const githubClient = fakeGitHubClient();
    const summary = await cleanupStaleWorktreesAtStartup({
      config: fakeConfig(),
      repoRoot: REPO_ROOT,
      githubClient,
      projectsClient,
      workspaceManager: fakeWorkspaceManager(),
      gitRunner: noopGitRunner,
      listIssueWorktrees: listWith(),
      logger: SILENT_LOGGER,
    });
    expect(summary).toEqual({ scanned: 0, removed: 0, failed: 0, skipped: 0 });
    expect(projectsClient.fetchProjectCandidates).not.toHaveBeenCalled();
  });

  it('Done 状態の worktree を recovery 完了後に cleanup する', async () => {
    const manager = fakeWorkspaceManager();
    const summary = await cleanupStaleWorktreesAtStartup({
      config: fakeConfig(),
      repoRoot: REPO_ROOT,
      githubClient: fakeGitHubClient(),
      projectsClient: fakeProjectsClient([fakeCandidate({ issueNumber: 42, status: 'Done' })]),
      workspaceManager: manager,
      gitRunner: noopGitRunner,
      listIssueWorktrees: listWith(fakeWorktree('issue-42', 'feature/42-foo')),
      logger: SILENT_LOGGER,
    });
    expect(summary).toMatchObject({ scanned: 1, removed: 1, failed: 0 });
    expect(manager.cleanupWorkspace).toHaveBeenCalledWith({
      taskKey: 'issue-42',
      branch: 'feature/42-foo',
      deleteBranch: true,
    });
  });

  it('runTracker に在席している issue は active_run で skip する', async () => {
    const manager = fakeWorkspaceManager();
    const tracker = createRunTracker({ startedAt: new Date() });
    tracker.runStarted({
      runId: 'r1',
      issueNumber: 42,
      branch: 'feature/42-foo',
      startedAt: new Date(),
      workspacePath: '/tmp/ws/issue-42',
      runLogPath: '/tmp/runs/r1',
    });
    await cleanupStaleWorktreesAtStartup({
      config: fakeConfig(),
      repoRoot: REPO_ROOT,
      githubClient: fakeGitHubClient(),
      projectsClient: fakeProjectsClient([fakeCandidate({ issueNumber: 42, status: 'Done' })]),
      workspaceManager: manager,
      gitRunner: noopGitRunner,
      listIssueWorktrees: listWith(fakeWorktree('issue-42', 'feature/42-foo')),
      runTracker: tracker,
      logger: SILENT_LOGGER,
    });
    expect(manager.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('GraphQL fetchProjectCandidates が失敗しても daemon 起動を止めず (warn のみ) summary を返す', async () => {
    const projectsClient = {
      fetchProjectCandidates: vi.fn(async () => {
        throw new Error('network down');
      }),
      fetchProjectContext: vi.fn(),
    } as unknown as ProjectsClient;
    const manager = fakeWorkspaceManager();
    const summary = await cleanupStaleWorktreesAtStartup({
      config: fakeConfig(),
      repoRoot: REPO_ROOT,
      githubClient: fakeGitHubClient(),
      projectsClient,
      workspaceManager: manager,
      gitRunner: noopGitRunner,
      listIssueWorktrees: listWith(fakeWorktree('issue-1', 'feature/1-foo')),
      logger: SILENT_LOGGER,
    });
    expect(summary).toEqual({ scanned: 1, removed: 0, failed: 0, skipped: 0 });
    expect(manager.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('open PR がある worktree は cleanup されない (skip)', async () => {
    const manager = fakeWorkspaceManager();
    await cleanupStaleWorktreesAtStartup({
      config: fakeConfig(),
      repoRoot: REPO_ROOT,
      githubClient: fakeGitHubClient(new Map([['feature/42-', 100]])),
      projectsClient: fakeProjectsClient([fakeCandidate({ issueNumber: 42, status: 'Done' })]),
      workspaceManager: manager,
      gitRunner: noopGitRunner,
      listIssueWorktrees: listWith(fakeWorktree('issue-42', 'feature/42-foo')),
      logger: SILENT_LOGGER,
    });
    expect(manager.cleanupWorkspace).not.toHaveBeenCalled();
  });
});
