import { describe, expect, it, vi } from 'vitest';

import { createRunCommand, type RunCommandDeps } from '../../src/cli/run.js';
import type { Config } from '../../src/config/index.js';
import { ConfigFileNotFoundError } from '../../src/config/index.js';
import { GitHubTokenNotSetError, type GitHubClient } from '../../src/github/index.js';
import { BootstrapError, type RunOnceResult } from '../../src/orchestrator/index.js';
import type { ProjectsClient } from '../../src/projects/index.js';
import type { WorkspaceManager } from '../../src/workspace/index.js';

type Streams = {
  stdout: { write: ReturnType<typeof vi.fn> };
  stderr: { write: ReturnType<typeof vi.fn> };
};

function createStreams(): Streams {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'hexylab',
    projectNumber: 1,
    baseBranch: 'main',
    statusField: 'Status',
    workflowFile: 'WORKFLOW.md',
    agentUserLogin: null,
    permissionMode: 'auto',
    timeoutMs: 1_800_000,
    killGracePeriodMs: 5_000,
    workspaceRoot: '.philharmonic/worktrees',
    dispatchStatuses: ['Todo'],
    cleanRetentionDays: 7,
    logLevel: 'info',
    polling: { intervalMs: 30_000 },
    retry: { maxAttempts: 3, maxBackoffMs: 600_000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 1, stallTimeoutMs: 300_000 },
    ...overrides,
  };
}

const fakeWorkflowSource = {
  render: vi.fn(async () => 'mocked-prompt'),
  close: vi.fn(async () => {}),
};
const fakeCreateWorkflowSource = vi.fn(async () => fakeWorkflowSource);

const fakeGitHub: GitHubClient = {
  getIssue: vi.fn(),
  commentIssue: vi.fn(),
  createPullRequest: vi.fn(),
  updateProjectV2ItemStatus: vi.fn(),
};

const fakeProjects: ProjectsClient = {
  fetchProjectCandidates: vi.fn(),
  fetchProjectMetadata: vi.fn(),
};

const fakeWorkspace: WorkspaceManager = {
  resolveWorkspacePath: vi.fn(),
  createWorkspace: vi.fn(),
  cleanupWorkspace: vi.fn(),
};

async function runCmd(streams: Streams, deps: RunCommandDeps, args: string[] = []) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createRunCommand({ ...deps, ...streams, exit: exit as never });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  }
  return { exit };
}

describe('philharmonic run CLI コマンド', () => {
  it('--help にコマンドの説明が含まれる', () => {
    const cmd = createRunCommand();
    expect(cmd.description()).toContain('1 ターン');
  });

  it('GITHUB_TOKEN 未設定時は exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => {
        throw new GitHubTokenNotSetError();
      },
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('config 読み込み失敗時は stderr に出して exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: vi.fn(async () => {
        throw new ConfigFileNotFoundError('/tmp/repo/philharmonic.yaml');
      }),
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('philharmonic.yaml'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('no_candidate のときは "no candidate" を stdout に出力する (exit せず)', async () => {
    const streams = createStreams();
    const runOnceMock = vi.fn(async (): Promise<RunOnceResult> => ({ kind: 'no_candidate' }));
    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      runOnce: runOnceMock,
    });
    expect(streams.stdout.write).toHaveBeenCalledWith(expect.stringContaining('no candidate'));
    expect(runOnceMock).toHaveBeenCalledTimes(1);
  });

  it('success のときは run-id / pr / branch を含む 1 行を stdout に出す', async () => {
    const streams = createStreams();
    const runOnceMock = vi.fn(
      async (): Promise<RunOnceResult> => ({
        kind: 'success',
        runId: 'rid',
        issueNumber: 19,
        prNumber: 99,
        branch: 'feature/19-task',
      }),
    );
    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      runOnce: runOnceMock,
    });
    const written = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('success');
    expect(written).toContain('run-id=rid');
    expect(written).toContain('pr=#99');
    expect(written).toContain('branch=feature/19-task');
  });

  it('failed のときは reason 付きで stderr に出して exit 1', async () => {
    const streams = createStreams();
    const runOnceMock = vi.fn(
      async (): Promise<RunOnceResult> => ({
        kind: 'failed',
        runId: 'rid',
        issueNumber: 19,
        reason: 'runner_error',
        branch: 'feature/19-task',
      }),
    );
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      runOnce: runOnceMock,
    });
    const written = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('failed');
    expect(written).toContain('reason=runner_error');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('config.dispatchStatuses を runOnce にそのまま引き渡す (#38)', async () => {
    const streams = createStreams();
    const runOnceMock = vi.fn(async (): Promise<RunOnceResult> => ({ kind: 'no_candidate' }));
    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ dispatchStatuses: ['Ready for Agent', 'Todo'] }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      runOnce: runOnceMock,
    });
    expect(runOnceMock).toHaveBeenCalledTimes(1);
    const arg = runOnceMock.mock.calls[0]?.[0] as { dispatchStatuses?: readonly string[] };
    expect(arg.dispatchStatuses).toEqual(['Ready for Agent', 'Todo']);
  });

  it('BootstrapError が throw されたら stderr に出して exit 1', async () => {
    const streams = createStreams();
    const runOnceMock = vi.fn(async () => {
      throw new BootstrapError(
        'status_transition_to_in_progress_failed',
        'Status を In Progress に遷移できませんでした: oops',
      );
    });
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      runOnce: runOnceMock,
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('In Progress'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
