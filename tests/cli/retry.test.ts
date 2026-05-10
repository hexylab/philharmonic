import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createRetryCommand, type RetryCommandDeps } from '../../src/cli/retry.js';
import { ConfigFileNotFoundError, type Config } from '../../src/config/index.js';
import { GitHubTokenNotSetError, type GitHubClient, type Issue } from '../../src/github/index.js';
import {
  GhCommandError,
  StatusOptionNotFoundError,
  type Candidate,
  type GhRunner,
  type ProjectContext,
  type ProjectsClient,
} from '../../src/projects/index.js';
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
    itemId: 'PVTI_item_42',
    issueNumber: 42,
    issueTitle: 'foo',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/42',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'In Progress',
    ...overrides,
  };
}

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: 'foo',
    body: 'body',
    state: 'open',
    htmlUrl: 'https://github.com/hexylab/philharmonic/issues/42',
    labels: [],
    assignees: [],
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

function fakeWorkspaceManager(): WorkspaceManager {
  return {
    resolveWorkspacePath: vi.fn(),
    createWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(async () => undefined),
    runHooks: vi.fn(async () => undefined),
  };
}

function fakeGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getIssue: vi.fn(async () => fakeIssue()),
    listOpenPullRequests: vi.fn(async () => []),
    ...overrides,
  } as GitHubClient;
}

function fakeProjectsClient(context: ProjectContext): ProjectsClient {
  return {
    fetchProjectCandidates: vi.fn(async () => [...context.candidates]),
    fetchProjectContext: vi.fn(async () => context),
  };
}

const PROJECT_CONTEXT_DEFAULT: ProjectContext = {
  projectId: 'PVT_proj',
  candidates: [fakeCandidate()],
};

type DepsBuilder = {
  config?: Config;
  context?: ProjectContext;
  issue?: Issue;
  openPRs?: Awaited<ReturnType<GitHubClient['listOpenPullRequests']>>;
  worktrees?: IssueWorktree[];
  pathExists?: (target: string) => Promise<boolean>;
  workspaceManager?: WorkspaceManager;
  runGh?: GhRunner;
  resolveToken?: () => Promise<{ token: string; origin: 'env' | 'gh_cli' }>;
};

function buildDeps(opts: DepsBuilder & { streams: Streams }): RetryCommandDeps {
  const config = opts.config ?? fakeConfig();
  const context = opts.context ?? PROJECT_CONTEXT_DEFAULT;
  const issue = opts.issue ?? fakeIssue();
  const openPRs = opts.openPRs ?? [];
  const worktrees = opts.worktrees ?? [];
  const workspaceManager = opts.workspaceManager ?? fakeWorkspaceManager();
  const runGh = opts.runGh ?? (vi.fn(async () => ({ stdout: '', stderr: '' })) as GhRunner);
  const pathExists = opts.pathExists ?? (async () => false);

  return {
    cwd: () => REPO_ROOT,
    loadConfig: async () => config,
    resolveGitHubToken:
      opts.resolveToken ?? (async () => ({ token: 'tok', origin: 'env' as const })),
    setEnv: vi.fn(),
    createGitHubClient: () =>
      fakeGitHubClient({
        getIssue: vi.fn(async () => issue),
        listOpenPullRequests: vi.fn(async () => openPRs),
      }),
    createProjectsClient: () => fakeProjectsClient(context),
    createWorkspaceManager: () => workspaceManager,
    runGit: vi.fn() as never,
    runGh,
    listIssueWorktrees: async () => [...worktrees],
    pathExists,
    stdout: opts.streams.stdout as unknown as NodeJS.WritableStream,
    stderr: opts.streams.stderr as unknown as NodeJS.WritableStream,
  };
}

async function runCmd(streams: Streams, deps: RetryCommandDeps, args: string[]) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createRetryCommand({ ...deps, ...streams, exit: exit as never });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  }
  return { exit };
}

describe('philharmonic retry CLI コマンド', () => {
  it('--help にコマンドの説明と --dry-run / --target-status / --force が含まれる', () => {
    const cmd = createRetryCommand();
    const helpText = cmd.helpInformation();
    expect(cmd.description()).toContain('dispatch');
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('--target-status');
    expect(helpText).toContain('--force');
    expect(helpText).toContain('--config');
  });

  it('issue-number が正の整数でないと commander が拒否する', async () => {
    const streams = createStreams();
    const cmd = createRetryCommand({
      ...buildDeps({ streams }),
      ...streams,
      exit: ((code: number) => {
        throw new Error(`__exit__${code}`);
      }) as never,
    });
    cmd.exitOverride();
    await expect(cmd.parseAsync(['abc'], { from: 'user' })).rejects.toThrow();
  });

  it('config 読み込み失敗時は stderr に出して exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      {
        ...buildDeps({ streams }),
        loadConfig: async () => {
          throw new ConfigFileNotFoundError('/tmp/repo/philharmonic.yaml');
        },
      },
      ['42'],
    );
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('philharmonic.yaml'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('GITHUB_TOKEN 未設定時は exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      {
        ...buildDeps({ streams }),
        resolveGitHubToken: async () => {
          throw new GitHubTokenNotSetError();
        },
      },
      ['42'],
    );
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('対象 Issue が project 内に存在しないと exit 1', async () => {
    const streams = createStreams();
    const context: ProjectContext = {
      projectId: 'PVT_proj',
      candidates: [fakeCandidate({ issueNumber: 99 })],
    };
    const { exit } = await runCmd(streams, buildDeps({ streams, context }), ['42']);
    const stderrWritten = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stderrWritten).toContain('not in project');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('Issue が close 済みなら exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      buildDeps({ streams, issue: fakeIssue({ state: 'closed' }) }),
      ['42'],
    );
    const stderrWritten = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stderrWritten).toContain('closed');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('open PR があると default で abort (--force なしで exit 1)', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const cleanupSpy = workspaceManager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    const runGh: GhRunner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const { exit } = await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
        openPRs: [
          {
            number: 7,
            headRef: 'feature/42-foo',
            htmlUrl: 'https://github.com/hexylab/philharmonic/pull/7',
          },
        ],
        worktrees: [fakeWorktree('issue-42', 'feature/42-foo')],
      }),
      ['42'],
    );
    const stderrWritten = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stderrWritten).toContain('open PR');
    expect(exit).toHaveBeenCalledWith(1);
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it('--dry-run では cleanupWorkspace も runGh も呼ばず plan を表示する', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const cleanupSpy = workspaceManager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    const runGh: GhRunner = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
        worktrees: [fakeWorktree('issue-42', 'feature/42-foo')],
      }),
      ['42', '--dry-run'],
    );

    const stdoutWritten = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdoutWritten).toContain('dry-run plan for issue #42');
    expect(stdoutWritten).toContain('current status: In Progress');
    expect(stdoutWritten).toContain('target status:  Todo');
    expect(stdoutWritten).toContain('feature/42-foo  (will delete)');
    expect(stdoutWritten).toContain('dry-run: no changes applied');
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it('worktree あり + status 不一致時に cleanupWorkspace と updateProjectItemStatus の両方を呼ぶ', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const cleanupSpy = workspaceManager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    const FIELD_LIST_OK = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_status',
          name: 'Status',
          type: 'ProjectV2SingleSelectField',
          options: [
            { id: 'opt-todo', name: 'Todo' },
            { id: 'opt-in-progress', name: 'In Progress' },
          ],
        },
      ],
    });
    const ghCalls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args) => {
      ghCalls.push([...args]);
      if (args[1] === 'field-list') return { stdout: FIELD_LIST_OK, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
        worktrees: [fakeWorktree('issue-42', 'feature/42-foo')],
      }),
      ['42'],
    );

    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-42',
      branch: 'feature/42-foo',
      deleteBranch: true,
    });
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[1]).toContain('--single-select-option-id');
    expect(ghCalls[1]).toContain('opt-todo');

    const stdoutWritten = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdoutWritten).toContain('removed worktree');
    expect(stdoutWritten).toContain('updated status In Progress -> Todo');
    expect(stdoutWritten).toContain('done issue=#42');
  });

  it('既に target status で worktree も無いときは status 書き戻しを skip し no-op を出す', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const cleanupSpy = workspaceManager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    const runGh: GhRunner = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
        context: { projectId: 'PVT_proj', candidates: [fakeCandidate({ status: 'Todo' })] },
      }),
      ['42'],
    );

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
    const stdoutWritten = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdoutWritten).toContain('nothing to do');
  });

  it('feature/<n>- でないブランチが checkout された worktree は branch 削除を skip する', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const cleanupSpy = workspaceManager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    const runGh: GhRunner = vi.fn(async () => ({
      stdout: JSON.stringify({
        fields: [
          {
            id: 'PVTSSF_status',
            name: 'Status',
            type: 'ProjectV2SingleSelectField',
            options: [{ id: 'opt-todo', name: 'Todo' }],
          },
        ],
      }),
      stderr: '',
    }));

    await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
        worktrees: [fakeWorktree('issue-42', 'main')],
      }),
      ['42'],
    );

    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-42',
      branch: undefined,
      deleteBranch: false,
    });
    const stdoutWritten = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stdoutWritten).toContain('skip delete');
  });

  it('--target-status を渡すと dispatch_statuses[0] ではなくその値を使う', async () => {
    const streams = createStreams();
    const ghCalls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args) => {
      ghCalls.push([...args]);
      if (args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'PVTSSF_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [
                  { id: 'opt-ready', name: 'Ready for Agent' },
                  { id: 'opt-todo', name: 'Todo' },
                ],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await runCmd(
      streams,
      buildDeps({
        streams,
        runGh,
        config: fakeConfig({ dispatchStatuses: ['Todo'] }),
      }),
      ['42', '--target-status', 'Ready for Agent'],
    );
    const itemEditCall = ghCalls.find((args) => args[1] === 'item-edit');
    expect(itemEditCall).toBeDefined();
    expect(itemEditCall).toContain('opt-ready');
  });

  it('--force を付けると open PR があっても続行する', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const cleanupSpy = workspaceManager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    const runGh: GhRunner = vi.fn(async (args) => {
      if (args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'PVTSSF_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [{ id: 'opt-todo', name: 'Todo' }],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
        openPRs: [
          {
            number: 7,
            headRef: 'feature/42-foo',
            htmlUrl: 'https://github.com/hexylab/philharmonic/pull/7',
          },
        ],
        worktrees: [fakeWorktree('issue-42', 'feature/42-foo')],
      }),
      ['42', '--force'],
    );

    expect(cleanupSpy).toHaveBeenCalled();
    expect(runGh).toHaveBeenCalled();
  });

  it('updateProjectItemStatus が StatusOptionNotFoundError を出した場合は exit 1', async () => {
    const streams = createStreams();
    const workspaceManager = fakeWorkspaceManager();
    const runGh: GhRunner = vi.fn(async (args) => {
      if (args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'PVTSSF_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [{ id: 'opt-other', name: 'Backlog' }],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const { exit } = await runCmd(
      streams,
      buildDeps({
        streams,
        workspaceManager,
        runGh,
      }),
      ['42'],
    );
    const stderrWritten = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stderrWritten).toContain('failed to update status');
    expect(stderrWritten).toContain('not found');
    expect(exit).toHaveBeenCalledWith(1);
    // テスト念のため: error type と CLI から見える stderr の同期確認
    expect(StatusOptionNotFoundError.name).toBe('StatusOptionNotFoundError');
    expect(GhCommandError.name).toBe('GhCommandError');
  });
});
