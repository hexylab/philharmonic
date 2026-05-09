import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type {
  GitHubClient,
  Issue,
  IssueComment,
  PullRequest,
  UpdateProjectV2ItemStatusInput,
  UpdateProjectV2ItemStatusResult,
} from '../../src/github/index.js';
import type { LogFields, Logger } from '../../src/logger/index.js';
import { runOnce, type RunOnceResult } from '../../src/orchestrator/index.js';
import type { Candidate, ProjectMetadata, ProjectsClient } from '../../src/projects/index.js';
import type { RunResult } from '../../src/runner/index.js';
import type {
  CreateWorkspaceInput,
  GitRunner,
  Workspace,
  WorkspaceManager,
} from '../../src/workspace/index.js';

type GitHubMock = GitHubClient & {
  getIssue: ReturnType<typeof vi.fn>;
  commentIssue: ReturnType<typeof vi.fn>;
  createPullRequest: ReturnType<typeof vi.fn>;
  updateProjectV2ItemStatus: ReturnType<typeof vi.fn>;
};

type ProjectsMock = ProjectsClient & {
  fetchProjectCandidates: ReturnType<typeof vi.fn>;
  fetchProjectMetadata: ReturnType<typeof vi.fn>;
};

type WorkspaceMock = WorkspaceManager & {
  createWorkspace: ReturnType<typeof vi.fn>;
  cleanupWorkspace: ReturnType<typeof vi.fn>;
  resolveWorkspacePath: ReturnType<typeof vi.fn>;
};

const FIXED_RUN_ID = '0190ce80-0000-7000-8000-000000000000';

const SAMPLE_CANDIDATE: Candidate = {
  itemId: 'PVTI_a',
  issueNumber: 19,
  issueTitle: 'philharmonic run コマンドで 1 ターンの orchestration を実装する',
  issueUrl: 'https://github.com/hexylab/philharmonic/issues/19',
  issueState: 'OPEN',
  repositoryNameWithOwner: 'hexylab/philharmonic',
  status: 'Todo',
};

const SAMPLE_ISSUE_BODY = `## Goal

Goal の本文。

## Constraints

- 制約 1
- 制約 2

## Acceptance Criteria

- [ ] AC1
- [ ] AC2
`;

const SAMPLE_ISSUE: Issue = {
  number: 19,
  title: SAMPLE_CANDIDATE.issueTitle,
  body: SAMPLE_ISSUE_BODY,
  state: 'open',
  htmlUrl: SAMPLE_CANDIDATE.issueUrl,
  labels: [],
  assignees: [],
};

const SAMPLE_METADATA: ProjectMetadata = {
  projectId: 'PVT_1',
  statusFieldId: 'PVTSSF_status',
  statusOptions: [
    { id: 'opt_todo', name: 'Todo' },
    { id: 'opt_ip', name: 'In Progress' },
    { id: 'opt_ir', name: 'In Review' },
    { id: 'opt_fail', name: 'Failed' },
    { id: 'opt_done', name: 'Done' },
  ],
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'hexylab',
    projectNumber: 1,
    baseBranch: 'main',
    statusField: 'Status',
    agentUserLogin: null,
    permissionMode: 'auto',
    timeoutMs: 30 * 60 * 1000,
    killGracePeriodMs: 5_000,
    workspaceRoot: '.philharmonic/worktrees',
    dispatchStatuses: ['Todo'],
    cleanRetentionDays: 7,
    logLevel: 'info',
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: 'success',
    exitCode: 0,
    signal: null,
    durationMs: 1_234,
    durationApiMs: 567,
    numTurns: 3,
    sessionId: FIXED_RUN_ID,
    resultSubtype: 'success',
    stopReason: 'end_turn',
    isError: false,
    finalText: 'done',
    totalCostUsd: 0.0123,
    usage: { inputTokens: 100, outputTokens: 50 },
    rawStderrTail: '',
    resultEventReceived: true,
    logPaths: null,
    ...overrides,
  };
}

function makeGitHubMock(overrides: Partial<GitHubMock> = {}): GitHubMock {
  const getIssue = (overrides.getIssue ?? vi.fn(async () => SAMPLE_ISSUE)) as ReturnType<
    typeof vi.fn
  >;
  const commentIssue = (overrides.commentIssue ??
    vi.fn(
      async (): Promise<IssueComment> => ({
        id: 1,
        htmlUrl: 'https://example.com/c',
      }),
    )) as ReturnType<typeof vi.fn>;
  const createPullRequest = (overrides.createPullRequest ??
    vi.fn(
      async (): Promise<PullRequest> => ({
        number: 99,
        htmlUrl: 'https://example.com/pr/99',
        draft: false,
      }),
    )) as ReturnType<typeof vi.fn>;
  const updateProjectV2ItemStatus = (overrides.updateProjectV2ItemStatus ??
    vi.fn(
      async (input: UpdateProjectV2ItemStatusInput): Promise<UpdateProjectV2ItemStatusResult> => ({
        itemId: input.itemId,
      }),
    )) as ReturnType<typeof vi.fn>;
  return { getIssue, commentIssue, createPullRequest, updateProjectV2ItemStatus };
}

function makeProjectsMock(
  candidates: Candidate[] = [SAMPLE_CANDIDATE],
  metadata: ProjectMetadata = SAMPLE_METADATA,
): ProjectsMock {
  return {
    fetchProjectCandidates: vi.fn(async () => candidates),
    fetchProjectMetadata: vi.fn(async () => metadata),
  };
}

type FakeLogger = Logger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  bindings: LogFields;
};

function makeFakeLogger(bindings: LogFields = {}): FakeLogger {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const fake: FakeLogger = {
    level: 'debug',
    bindings,
    debug,
    info,
    warn,
    error,
    child: (childBindings: LogFields) =>
      makeChildLogger({ debug, info, warn, error }, { ...bindings, ...childBindings }),
  };
  return fake;
}

type SharedFns = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeChildLogger(fns: SharedFns, bindings: LogFields): FakeLogger {
  const fake: FakeLogger = {
    level: 'debug',
    bindings,
    debug: fns.debug,
    info: fns.info,
    warn: fns.warn,
    error: fns.error,
    child: (childBindings: LogFields) => makeChildLogger(fns, { ...bindings, ...childBindings }),
  };
  return fake;
}

function makeWorkspaceMock(workspacePath: string): WorkspaceMock {
  return {
    resolveWorkspacePath: vi.fn(() => workspacePath),
    createWorkspace: vi.fn(
      async (input: CreateWorkspaceInput): Promise<Workspace> => ({
        taskKey: input.taskKey,
        path: workspacePath,
        branch: input.branch,
        reused: false,
      }),
    ),
    cleanupWorkspace: vi.fn(async () => undefined),
  };
}

function makeGitRunner(
  overrides: Partial<{
    fetch: () => Promise<{ stdout: string; stderr: string }>;
    revListCount: () => Promise<{ stdout: string; stderr: string }>;
    push: () => Promise<{ stdout: string; stderr: string }>;
  }> = {},
): GitRunner {
  return async (args) => {
    const command = args[0];
    if (command === 'fetch') {
      if (overrides.fetch !== undefined) return overrides.fetch();
      return { stdout: '', stderr: '' };
    }
    if (command === 'rev-list') {
      if (overrides.revListCount !== undefined) return overrides.revListCount();
      return { stdout: '1\n', stderr: '' };
    }
    if (command === 'push') {
      if (overrides.push !== undefined) return overrides.push();
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('runOnce', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-orch-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('候補が 0 件のときは no_candidate を返す (no-op)', async () => {
    const projects = makeProjectsMock([]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: vi.fn(),
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    expect(projects.fetchProjectMetadata).not.toHaveBeenCalled();
    expect(github.updateProjectV2ItemStatus).not.toHaveBeenCalled();
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
  });

  it('成功時は In Progress → In Review への遷移と PR 作成を行う', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(result.runId).toBe(FIXED_RUN_ID);
    expect(result.issueNumber).toBe(19);
    expect(result.prNumber).toBe(99);
    expect(result.branch).toMatch(/^feature\/19-/);

    expect(github.updateProjectV2ItemStatus).toHaveBeenCalledTimes(2);
    const calls = github.updateProjectV2ItemStatus.mock.calls.map(
      (c) => (c[0] as UpdateProjectV2ItemStatusInput).optionId,
    );
    expect(calls).toEqual(['opt_ip', 'opt_ir']);
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
    expect(github.commentIssue).not.toHaveBeenCalled();
    expect(workspace.cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
  });

  it('Runner が failed で返ったら reason=runner_error で Failed 遷移する', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () =>
      makeRunResult({ status: 'failed', exitCode: 1, isError: true, finalText: null }),
    );

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('runner_error');
    const optionIds = github.updateProjectV2ItemStatus.mock.calls.map(
      (c) => (c[0] as UpdateProjectV2ItemStatusInput).optionId,
    );
    expect(optionIds).toEqual(['opt_ip', 'opt_fail']);
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(github.commentIssue).toHaveBeenCalledTimes(1);
    expect(workspace.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('worktree に commit が無ければ reason=no_changes で Failed 遷移する', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner({
        revListCount: async () => ({ stdout: '0\n', stderr: '' }),
      }),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('no_changes');
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(github.commentIssue).toHaveBeenCalledTimes(1);
  });

  it('git push が失敗すれば reason=push で Failed 遷移する', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner({
        push: async () => {
          throw new Error('remote rejected');
        },
      }),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('push');
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(github.commentIssue).toHaveBeenCalledTimes(1);
  });

  it('dispatchStatuses を渡すと Todo 以外の Status (Ready for Agent) を dispatch できる (#38)', async () => {
    const candidate: Candidate = {
      ...SAMPLE_CANDIDATE,
      itemId: 'PVTI_b',
      status: 'Ready for Agent',
    };
    const projects = makeProjectsMock([candidate]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      dispatchStatuses: ['Ready for Agent'],
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(result.issueNumber).toBe(candidate.issueNumber);
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('deps.dispatchStatuses 未指定時は config.dispatchStatuses をフォールバックに使う (#38)', async () => {
    const candidate: Candidate = {
      ...SAMPLE_CANDIDATE,
      itemId: 'PVTI_cfg',
      status: 'Ready for Agent',
    };
    const projects = makeProjectsMock([candidate]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig({ dispatchStatuses: ['Ready for Agent'] }),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('dispatchStatuses 外の Status しかなければ no_candidate を返す (#38)', async () => {
    const candidate: Candidate = {
      ...SAMPLE_CANDIDATE,
      itemId: 'PVTI_done',
      status: 'Done',
    };
    const projects = makeProjectsMock([candidate]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      dispatchStatuses: ['Ready for Agent', 'Todo'],
      runClaude: vi.fn(),
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    expect(github.updateProjectV2ItemStatus).not.toHaveBeenCalled();
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
  });

  it('config.permissionMode は runClaude にそのまま渡され、bypass 時は警告ログを出す (#29)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const logger = makeFakeLogger();

    const result = (await runOnce({
      config: makeConfig({ permissionMode: 'bypass' }),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      logger,
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    expect(runClaudeMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ permissionMode: 'bypass' }),
    );

    const warnMessages = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(warnMessages.some((m) => m.includes('permission_mode=bypass'))).toBe(true);
  });

  it('config.permissionMode=auto では bypass 警告ログを出さない (#29)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const logger = makeFakeLogger();

    await runOnce({
      config: makeConfig({ permissionMode: 'auto' }),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      logger,
    });

    expect(runClaudeMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ permissionMode: 'auto' }),
    );
    const warnMessages = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(warnMessages.some((m) => m.includes('permission_mode=bypass'))).toBe(false);
  });

  it('runOnce は runId / issueNumber を child logger の bindings に注入する (#28)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const baseLogger = makeFakeLogger();

    const childCalls: LogFields[] = [];
    const baseChild = baseLogger.child.bind(baseLogger);
    baseLogger.child = (bindings: LogFields) => {
      childCalls.push(bindings);
      return baseChild(bindings);
    };

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      logger: baseLogger,
    });

    expect(childCalls.some((b) => b.runId === FIXED_RUN_ID && b.issueNumber === 19)).toBe(true);
  });

  it('runOnce は runClaude に同じ logger を渡す (session_id 付与のため) (#28)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const logger = makeFakeLogger();

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      logger,
    });

    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    const call = runClaudeMock.mock.calls[0]?.[0] as { logger?: Logger };
    expect(call.logger).toBeDefined();
    expect(typeof call.logger?.child).toBe('function');
  });

  it('PR 作成が失敗すれば reason=pr_create で Failed 遷移する', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock({
      createPullRequest: vi.fn(async () => {
        throw new Error('Validation failed');
      }) as ReturnType<typeof vi.fn>,
    });
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('pr_create');
    expect(github.commentIssue).toHaveBeenCalledTimes(1);
    const optionIds = github.updateProjectV2ItemStatus.mock.calls.map(
      (c) => (c[0] as UpdateProjectV2ItemStatusInput).optionId,
    );
    expect(optionIds).toEqual(['opt_ip', 'opt_fail']);
  });
});
