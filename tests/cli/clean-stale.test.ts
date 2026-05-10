import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCleanStaleCommand, type CleanStaleCommandDeps } from '../../src/cli/clean-stale.js';
import { ConfigFileNotFoundError, type Config } from '../../src/config/index.js';
import { type GitHubClient, type OpenPullRequest } from '../../src/github/index.js';
import { type Candidate, type ProjectsClient } from '../../src/projects/index.js';
import type { IssueWorktree, WorkspaceManager } from '../../src/workspace/index.js';

type Streams = {
  stdout: { write: ReturnType<typeof vi.fn> };
  stderr: { write: ReturnType<typeof vi.fn> };
};

function createStreams(): Streams {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

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

function fakeWorkspaceManager(): WorkspaceManager {
  return {
    resolveWorkspacePath: vi.fn(),
    createWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(async () => undefined),
    runHooks: vi.fn(async () => undefined),
  };
}

function fakeGitHubClient(
  listOpenPullRequests: GitHubClient['listOpenPullRequests'] = vi.fn(async () => []),
): GitHubClient {
  return { getIssue: vi.fn(), listOpenPullRequests } as unknown as GitHubClient;
}

function fakeProjectsClient(candidates: readonly Candidate[]): ProjectsClient {
  return {
    fetchProjectCandidates: vi.fn(async () => [...candidates]),
    fetchProjectContext: vi.fn(async () => ({ projectId: 'P', candidates: [...candidates] })),
  };
}

const BASE_DEPS = (overrides: CleanStaleCommandDeps = {}): CleanStaleCommandDeps => ({
  cwd: () => REPO_ROOT,
  loadConfig: async () => fakeConfig(),
  resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
  setEnv: vi.fn(),
  createGitHubClient: () => fakeGitHubClient(),
  createProjectsClient: () => fakeProjectsClient([]),
  createWorkspaceManager: () => fakeWorkspaceManager(),
  listIssueWorktrees: async () => [],
  serveLockExists: async () => false,
  ...overrides,
});

async function runCmd(streams: Streams, deps: CleanStaleCommandDeps, args: string[] = []) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createCleanStaleCommand({ ...deps, ...streams, exit: exit as never });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  }
  return { exit };
}

describe('philharmonic clean-stale CLI コマンド', () => {
  it('--help に説明と --dry-run / --force / --terminal-status が含まれる', () => {
    const cmd = createCleanStaleCommand();
    const helpText = cmd.helpInformation();
    expect(cmd.description()).toContain('terminal');
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('--force');
    expect(helpText).toContain('--terminal-status');
    expect(helpText).toContain('--config');
  });

  it('serve.lock があるとデフォルトで abort する (--force で続行可)', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      BASE_DEPS({
        serveLockExists: async () => true,
      }),
    );
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('serve.lock'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('config 読み込み失敗時は stderr に出して exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      BASE_DEPS({
        loadConfig: async () => {
          throw new ConfigFileNotFoundError('/tmp/repo/philharmonic.yaml');
        },
      }),
    );
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('philharmonic.yaml'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('Done 状態の worktree を cleanup する (Project Status=Done, PR 無し)', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [fakeWorktree('issue-1', 'feature/1-foo')],
        createProjectsClient: () =>
          fakeProjectsClient([fakeCandidate({ issueNumber: 1, status: 'Done' })]),
        createWorkspaceManager: () => manager,
      }),
    );
    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-1',
      branch: 'feature/1-foo',
      deleteBranch: true,
    });
    const stdout = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdout).toContain('removed=1');
  });

  it('--dry-run は cleanupWorkspace を呼ばず、plan を stdout に出す', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [fakeWorktree('issue-1', 'feature/1-foo')],
        createProjectsClient: () =>
          fakeProjectsClient([fakeCandidate({ issueNumber: 1, status: 'Done' })]),
        createWorkspaceManager: () => manager,
      }),
      ['--dry-run'],
    );
    expect(cleanupSpy).not.toHaveBeenCalled();
    const stdout = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('issue-1');
    expect(stdout).toContain('feature/1-foo');
  });

  it('open PR が残っている worktree は skip される (cleanup 呼ばない)', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    const pr: OpenPullRequest = {
      number: 99,
      headRef: 'feature/1-foo',
      htmlUrl: 'https://github.com/hexylab/philharmonic/pull/99',
    };

    await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [fakeWorktree('issue-1', 'feature/1-foo')],
        createProjectsClient: () =>
          fakeProjectsClient([fakeCandidate({ issueNumber: 1, status: 'Done' })]),
        createGitHubClient: () => fakeGitHubClient(vi.fn(async () => [pr])),
        createWorkspaceManager: () => manager,
      }),
    );
    expect(cleanupSpy).not.toHaveBeenCalled();
    const stdout = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdout).toContain('open_pr_exists');
  });

  it('Open Issue かつ non-terminal Status は skip される (Todo / In Progress 等)', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [
          fakeWorktree('issue-1', 'feature/1-foo'),
          fakeWorktree('issue-2', 'feature/2-bar'),
        ],
        createProjectsClient: () =>
          fakeProjectsClient([
            fakeCandidate({ issueNumber: 1, status: 'Todo' }),
            fakeCandidate({ issueNumber: 2, status: 'In Progress' }),
          ]),
        createWorkspaceManager: () => manager,
      }),
    );
    expect(cleanupSpy).not.toHaveBeenCalled();
    const stdout = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdout).toContain('issue_open_non_terminal');
  });

  it('CLOSED Issue は Status を問わず cleanup する', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [fakeWorktree('issue-1', 'feature/1-foo')],
        createProjectsClient: () =>
          fakeProjectsClient([
            fakeCandidate({ issueNumber: 1, status: 'In Progress', issueState: 'CLOSED' }),
          ]),
        createWorkspaceManager: () => manager,
      }),
    );
    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-1',
      branch: 'feature/1-foo',
      deleteBranch: true,
    });
  });

  it('main を checkout している worktree は branch 削除しない (deleteBranch=false)', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [fakeWorktree('issue-1', 'main')],
        createProjectsClient: () =>
          fakeProjectsClient([fakeCandidate({ issueNumber: 1, status: 'Done' })]),
        createWorkspaceManager: () => manager,
      }),
    );
    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-1',
      branch: undefined,
      deleteBranch: false,
    });
  });

  it('--terminal-status で config の terminalStatuses を上書きできる', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      BASE_DEPS({
        loadConfig: async () => fakeConfig({ terminalStatuses: ['Done'] }),
        listIssueWorktrees: async () => [fakeWorktree('issue-1', 'feature/1-foo')],
        createProjectsClient: () =>
          fakeProjectsClient([fakeCandidate({ issueNumber: 1, status: 'Archived' })]),
        createWorkspaceManager: () => manager,
      }),
      ['--terminal-status', 'Archived'],
    );
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('cleanup が一部失敗した worktree は stdout の removed 行に出さず stderr に failed を書いて exit 1', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    (manager.cleanupWorkspace as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { taskKey: string }) => {
        if (input.taskKey === 'issue-1') throw new Error('lock held');
      },
    );

    const { exit } = await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [
          fakeWorktree('issue-1', 'feature/1-foo'),
          fakeWorktree('issue-2', 'feature/2-bar'),
        ],
        createProjectsClient: () =>
          fakeProjectsClient([
            fakeCandidate({ issueNumber: 1, status: 'Done' }),
            fakeCandidate({ issueNumber: 2, status: 'Done' }),
          ]),
        createWorkspaceManager: () => manager,
      }),
    );
    const stdout = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    const stderr = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdout).not.toMatch(/^removed issue-1\b/m);
    expect(stdout).toMatch(/^removed issue-2\b/m);
    expect(stderr).toContain('failed issue-1');
    expect(stderr).toContain('lock held');
    expect(stdout).toContain('removed=1');
    expect(stdout).toContain('failed=1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('cleanup 対象がゼロなら "nothing to remove" を出して exit 0', async () => {
    const streams = createStreams();
    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    const { exit } = await runCmd(
      streams,
      BASE_DEPS({
        listIssueWorktrees: async () => [],
        createProjectsClient: () => fakeProjectsClient([]),
        createWorkspaceManager: () => manager,
      }),
    );
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    const stdout = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdout).toContain('nothing to remove');
  });
});
