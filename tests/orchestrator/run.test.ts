import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type { GitHubClient, Issue } from '../../src/github/index.js';
import type { LogFields, Logger } from '../../src/logger/index.js';
import { runConcurrent, runOnce, type RunOnceResult } from '../../src/orchestrator/index.js';
import type { Candidate, ProjectsClient } from '../../src/projects/index.js';
import type { RunResult } from '../../src/runner/index.js';
import type { RunTracker } from '../../src/server/tracker.js';
import type { WorkflowSource } from '../../src/workflow/index.js';
import { HookExecutionError } from '../../src/workspace/index.js';
import type {
  CreateWorkspaceInput,
  GitRunner,
  Workspace,
  WorkspaceManager,
} from '../../src/workspace/index.js';
import { makeFallbackWorkflowSource } from '../_helpers/workflow.js';

type GitHubMock = GitHubClient & {
  getIssue: ReturnType<typeof vi.fn>;
  listOpenPullRequests: ReturnType<typeof vi.fn>;
};

type ProjectsMock = ProjectsClient & {
  fetchProjectCandidates: ReturnType<typeof vi.fn>;
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

const SAMPLE_ISSUE_BODY = `## Goal\n\nGoal の本文。\n`;

const SAMPLE_ISSUE: Issue = {
  number: 19,
  title: SAMPLE_CANDIDATE.issueTitle,
  body: SAMPLE_ISSUE_BODY,
  state: 'open',
  htmlUrl: SAMPLE_CANDIDATE.issueUrl,
  labels: [],
  assignees: [],
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'hexylab',
    projectNumber: 1,
    baseBranch: 'main',
    statusField: 'Status',
    workflowFile: '.philharmonic/WORKFLOW.md',
    agentUserLogin: null,
    permissionMode: 'auto',
    timeoutMs: 30 * 60 * 1000,
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
    turns: 1,
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
  const listOpenPullRequests = (overrides.listOpenPullRequests ??
    vi.fn(async () => [])) as ReturnType<typeof vi.fn>;
  return { getIssue, listOpenPullRequests };
}

function makeProjectsMock(candidates: Candidate[] = [SAMPLE_CANDIDATE]): ProjectsMock {
  return {
    fetchProjectCandidates: vi.fn(async () => candidates),
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
  return {
    level: 'debug',
    bindings,
    debug: fns.debug,
    info: fns.info,
    warn: fns.warn,
    error: fns.error,
    child: (childBindings: LogFields) => makeChildLogger(fns, { ...bindings, ...childBindings }),
  };
}

/**
 * 何もしない gitRunner (実 git を呼ばずに fetch / push 等を pass-through する)。
 * dispatchSelected が `git fetch` を呼ぶ #62 以降のテストで必須。
 */
const noopGitRunner: GitRunner = async () => ({ stdout: '', stderr: '' });

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
    runHooks: vi.fn(async () => undefined),
  };
}

describe('runOnce (ADR-0005: 薄い orchestrator)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-orch-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
  });

  it('成功時は worktree を cleanup し、PR / Status は orchestrator から触らない', async () => {
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(result.runId).toBe(FIXED_RUN_ID);
    expect(result.issueNumber).toBe(19);
    expect(result.branch).toMatch(/^feature\/19-/);
    expect(workspace.cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    // ADR-0005: orchestrator は GitHub に書き込まない
    expect((result as unknown as { prNumber?: number }).prNumber).toBeUndefined();
  });

  it('Runner が stalled で返ったら reason=stalled で failed (Status flip しない)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('stalled');
    // 失敗時は worktree を保持する (debug 用)
    expect(workspace.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('Runner が failed で返ったら reason=runner_error で failed (worktree 保持)', async () => {
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('runner_error');
    expect(workspace.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('Runner が timeout で返ったら reason=timeout で failed', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'timeout' }));

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('timeout');
  });

  it('workspace 作成失敗は reason=workspace_provisioning で failed', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    workspace.createWorkspace = vi.fn(async () => {
      throw new Error('worktree add failed');
    });

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('workspace_provisioning');
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      dispatchStatuses: ['Ready for Agent'],
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
  });

  it('dispatchStatuses 外の Status しかなければ no_candidate を返す', async () => {
    const candidate: Candidate = { ...SAMPLE_CANDIDATE, status: 'Done' };
    const projects = makeProjectsMock([candidate]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      dispatchStatuses: ['Ready for Agent', 'Todo'],
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    });

    expect(result).toEqual({ kind: 'no_candidate' });
  });

  it('worktree が既存なら二重 dispatch ガードで skip する (ADR-0005)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => true,
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
  });

  it('runTracker.getRunningByIssue が non-null なら二重 dispatch ガードで skip する (ADR-0005)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const tracker: RunTracker = {
      runStarted: vi.fn(),
      runFinished: vi.fn(),
      recordActivity: vi.fn(),
      recordRunnerProcess: vi.fn(),
      setWatchdog: vi.fn(),
      listRunning: () => [],
      getRunningByIssue: () => ({
        runId: 'r',
        issueNumber: 19,
        branch: 'feature/19-x',
        startedAt: new Date().toISOString(),
        slot: null,
        lastActivityAt: new Date().toISOString(),
        retryAttempt: null,
        workspacePath: '/tmp/ws/issue-19',
        runLogPath: '/tmp/runs/r',
        runnerPid: null,
        watchdog: null,
      }),
      getTotals: () => ({
        runsCompleted: 0,
        runsSucceeded: 0,
        runsFailed: 0,
        totalCostUsd: 0,
      }),
      recordPollTick: vi.fn(),
      getLastPollTickAt: () => null,
      getStartedAt: () => new Date(0).toISOString(),
    };

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      runTracker: tracker,
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
  });

  it('config.permissionMode は runClaude にそのまま渡され、bypass 時は警告ログを出す', async () => {
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      logger,
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(runClaudeMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ permissionMode: 'bypass' }),
    );
    const warnMessages = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(warnMessages.some((m) => m.includes('permission_mode=bypass'))).toBe(true);
  });

  it('config.permissionMode=auto では dispatchSelected 内で警告を出さない (CLI bootstrap で 1 回だけ出す)', async () => {
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      logger,
    });

    expect(runClaudeMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ permissionMode: 'auto' }),
    );
    const warnMessages = logger.warn.mock.calls.map((c) => c[0] as string);
    // dispatchSelected 内では permission_mode=auto / bypass のいずれの警告も出さない (bootstrap 側に集約)
    expect(warnMessages.some((m) => m.includes('permission_mode=auto'))).toBe(false);
    expect(warnMessages.some((m) => m.includes('permission_mode=bypass'))).toBe(false);
  });

  it('runId / issueNumber を child logger の bindings に注入する (#28)', async () => {
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      logger,
    });

    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    const childLogger = runClaudeMock.mock.calls[0]?.[0]?.logger as FakeLogger | undefined;
    expect(childLogger?.bindings).toMatchObject({ runId: FIXED_RUN_ID, issueNumber: 19 });
  });

  it('before_run hook が失敗すると reason=hook_failed で failed', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    workspace.runHooks = vi.fn(async (event: string) => {
      if (event === 'before_run') {
        throw new HookExecutionError('before_run', 'pnpm', 1, 'install failed');
      }
    }) as never;
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(result.reason).toBe('hook_failed');
    expect(runClaudeMock).not.toHaveBeenCalled();
  });

  it('after_run hook は runner status に関わらず PHILHARMONIC_RUN_STATUS 付きで発火する', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const hookCalls: Array<{ event: string; extraEnv?: Record<string, string> }> = [];
    workspace.runHooks = vi.fn(
      async (event: string, ctx: { extraEnv?: Record<string, string> }) => {
        hookCalls.push({ event, extraEnv: ctx.extraEnv });
      },
    ) as never;
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'failed', exitCode: 1 }));

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
    });

    const afterRun = hookCalls.find((c) => c.event === 'after_run');
    expect(afterRun).toBeDefined();
    expect(afterRun?.extraEnv?.PHILHARMONIC_RUN_STATUS).toBe('failed');
  });

  it('runTracker.runStarted / runFinished が success 経路で 1 回ずつ呼ばれる (#30)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const startedSpy = vi.fn();
    const finishedSpy = vi.fn();
    const tracker: RunTracker = {
      runStarted: startedSpy,
      runFinished: finishedSpy,
      recordActivity: vi.fn(),
      recordRunnerProcess: vi.fn(),
      setWatchdog: vi.fn(),
      listRunning: () => [],
      getRunningByIssue: () => null,
      getTotals: () => ({
        runsCompleted: 0,
        runsSucceeded: 0,
        runsFailed: 0,
        totalCostUsd: 0,
      }),
      recordPollTick: vi.fn(),
      getLastPollTickAt: () => null,
      getStartedAt: () => new Date(0).toISOString(),
    };

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      runTracker: tracker,
    });

    expect(startedSpy).toHaveBeenCalledTimes(1);
    // success 経路 + finally の防御発火 = 2 回呼ばれるが、tracker 自身が idempotent
    expect(finishedSpy).toHaveBeenCalled();
    expect(finishedSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'success', runId: FIXED_RUN_ID });
  });

  it('runStarted に workspacePath / runLogPath を渡す (#105)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const startedSpy = vi.fn();
    const tracker: RunTracker = {
      runStarted: startedSpy,
      runFinished: vi.fn(),
      recordActivity: vi.fn(),
      recordRunnerProcess: vi.fn(),
      setWatchdog: vi.fn(),
      listRunning: () => [],
      getRunningByIssue: () => null,
      getTotals: () => ({
        runsCompleted: 0,
        runsSucceeded: 0,
        runsFailed: 0,
        totalCostUsd: 0,
      }),
      recordPollTick: vi.fn(),
      getLastPollTickAt: () => null,
      getStartedAt: () => new Date(0).toISOString(),
    };

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      runTracker: tracker,
    });

    expect(startedSpy).toHaveBeenCalledTimes(1);
    const arg = startedSpy.mock.calls[0]![0];
    expect(arg).toMatchObject({
      runId: FIXED_RUN_ID,
      // makeWorkspaceMock の resolveWorkspacePath は固定 path を返すモックなので、
      // issue 番号を含まない (実装は workspaceManager.resolveWorkspacePath の戻り値をそのまま使う)。
      workspacePath: path.join(tempDir, 'wt'),
      runLogPath: expect.stringContaining(FIXED_RUN_ID),
    });
    expect(workspace.resolveWorkspacePath).toHaveBeenCalledWith(
      `issue-${SAMPLE_CANDIDATE.issueNumber}`,
    );
  });

  it('runner に onSpawn を渡し、tracker.recordRunnerProcess に配線する (#105)', async () => {
    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));

    let capturedOnSpawn: ((pid: number) => void) | undefined;
    const runClaudeMock = vi.fn(async (opts) => {
      capturedOnSpawn = opts.onSpawn;
      // sim: spawn が pid 9999 を返したと仮定
      capturedOnSpawn?.(9999);
      return makeRunResult();
    });
    const recordRunnerProcessSpy = vi.fn();
    const tracker: RunTracker = {
      runStarted: vi.fn(),
      runFinished: vi.fn(),
      recordActivity: vi.fn(),
      recordRunnerProcess: recordRunnerProcessSpy,
      setWatchdog: vi.fn(),
      listRunning: () => [],
      getRunningByIssue: () => null,
      getTotals: () => ({
        runsCompleted: 0,
        runsSucceeded: 0,
        runsFailed: 0,
        totalCostUsd: 0,
      }),
      recordPollTick: vi.fn(),
      getLastPollTickAt: () => null,
      getStartedAt: () => new Date(0).toISOString(),
    };

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      runTracker: tracker,
    });

    expect(recordRunnerProcessSpy).toHaveBeenCalledWith(FIXED_RUN_ID, 9999);
  });
});

describe('runConcurrent (ADR-0005: 薄い orchestrator)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-concurrent-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('候補 0 件のときは空配列を返す', async () => {
    const projects = makeProjectsMock([]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));

    const outcomes = await runConcurrent({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      maxConcurrent: 2,
    });

    expect(outcomes).toEqual([]);
  });

  it('複数 Issue を並列 dispatch する (各結果に slot index が付く)', async () => {
    const candidates: Candidate[] = [
      { ...SAMPLE_CANDIDATE, itemId: 'A', issueNumber: 101 },
      { ...SAMPLE_CANDIDATE, itemId: 'B', issueNumber: 102 },
    ];
    const projects = makeProjectsMock(candidates);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    let runIdSeq = 0;
    const outcomes = await runConcurrent({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => {
        runIdSeq += 1;
        return `0190ce80-0000-7000-8000-00000000000${runIdSeq}`;
      },
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      maxConcurrent: 2,
    });

    expect(outcomes).toHaveLength(2);
    const issueNumbers = outcomes.map((o) => o.result.issueNumber).sort();
    expect(issueNumbers).toEqual([101, 102]);
    expect(runClaudeMock).toHaveBeenCalledTimes(2);
  });

  it('worktree 既存の Issue は二重 dispatch ガードで skip される', async () => {
    const candidates: Candidate[] = [
      { ...SAMPLE_CANDIDATE, itemId: 'A', issueNumber: 201 },
      { ...SAMPLE_CANDIDATE, itemId: 'B', issueNumber: 202 },
    ];
    const projects = makeProjectsMock(candidates);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    workspace.resolveWorkspacePath.mockImplementation((key: string) => path.join(tempDir, key));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const pathExists = vi.fn(async (target: string) => target.includes('issue-202'));

    let runIdSeq = 0;
    const outcomes = await runConcurrent({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => {
        runIdSeq += 1;
        return `0190ce80-0000-7000-8000-00000000000${runIdSeq}`;
      },
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists,
      maxConcurrent: 2,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result.issueNumber).toBe(201);
  });

  it('複数 success の continuation 判定で fetchProjectCandidates は 1 tick で 2 回 (initial + 共有 1 回) に抑える (#85 / ADR-0009)', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const candidates: Candidate[] = [
      { ...SAMPLE_CANDIDATE, itemId: 'A', issueNumber: 101, status: 'In Review' },
      { ...SAMPLE_CANDIDATE, itemId: 'B', issueNumber: 102, status: 'In Review' },
    ];
    const initial: Candidate[] = [
      { ...SAMPLE_CANDIDATE, itemId: 'A', issueNumber: 101 }, // Todo (dispatch 用)
      { ...SAMPLE_CANDIDATE, itemId: 'B', issueNumber: 102 },
    ];
    const projects: ProjectsMock = {
      fetchProjectCandidates: vi
        .fn()
        .mockResolvedValueOnce(initial) // initial selection
        .mockResolvedValueOnce(candidates), // shared continuation re-fetch (1 回のみ)
    };
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    workspace.resolveWorkspacePath.mockImplementation((key: string) => path.join(tempDir, key));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    let runIdSeq = 0;
    await runConcurrent({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => {
        runIdSeq += 1;
        return `0190ce80-0000-7000-8000-00000000010${runIdSeq}`;
      },
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      maxConcurrent: 2,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    });

    // initial selection: 1 回 + continuation 用 (2 success 共有): 1 回 = 計 2 回
    expect(projects.fetchProjectCandidates).toHaveBeenCalledTimes(2);
    // 両 Issue とも In Review (terminal) → release
    expect(queue.size()).toBe(0);
  });
});

describe('runOnce + retry queue (#84 / ADR-0008)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-orch-retry-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('retry-eligible failure で kind=failure attempt=1 が schedule される', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));

    const failResult = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(failResult.reason).toBe('stalled');
    expect(queue.size()).toBe(1);
    const entry = queue.list()[0]!;
    expect(entry.kind).toBe('failure');
    expect(entry.issueNumber).toBe(19);
    expect(entry.attempt).toBe(1);
    expect(entry.dueAt.toISOString()).toBe('2026-05-09T00:00:10.000Z');
    expect(entry.failureReason).toBe('stalled');

    // 次の dispatch (success) で failure entry が消え、Issue がまだ active なら
    // 同 Issue は continuation entry に置き換わる (ADR-0009)
    runClaudeMock.mockResolvedValueOnce(makeRunResult());
    const successResult = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: makeWorkspaceMock(path.join(tempDir, 'wt2')),
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:30Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    });

    expect(successResult.kind).toBe('success');
    expect(queue.size()).toBe(1);
    const continuation = queue.list()[0]!;
    expect(continuation.kind).toBe('continuation');
    expect(continuation.attempt).toBe(1); // counter リセット (failure → continuation)
    expect(continuation.failureReason).toBeNull();
    expect(continuation.dueAt.toISOString()).toBe('2026-05-09T00:00:40.000Z'); // 30s + 10s
  });

  it('attempt が max_retry_attempts に達したら exhausted になり queue から落とす', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    // 既に kind=failure attempt=5 で due な entry を仕込む
    const workspacePath = path.join(tempDir, 'wt-retry');
    queue.schedule({
      kind: 'failure',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 5,
      failureReason: 'runner_error',
      lastRunId: 'prev-run',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));
    const logger = makeFakeLogger();

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:01:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(queue.size()).toBe(0);
    const warnMessages = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(warnMessages.some((m) => m === 'retry exhausted')).toBe(true);

    // Issue #86: retry 上限到達時に failure summary が残り、warn ログから path で辿れる
    const exhausted = logger.warn.mock.calls.find((c) => c[0] === 'retry exhausted');
    const fields = exhausted?.[1] as Record<string, unknown> | undefined;
    expect(fields).toMatchObject({
      kind: 'failure',
      issueNumber: 19,
      attempt: 5,
      failureReason: 'stalled',
      lastRunId: FIXED_RUN_ID,
      branch: expect.stringMatching(/^feature\/19-/),
      summaryPath: `.philharmonic/runs/${FIXED_RUN_ID}/summary.md`,
      streamPath: `.philharmonic/runs/${FIXED_RUN_ID}/stream.jsonl`,
      stderrPath: `.philharmonic/runs/${FIXED_RUN_ID}/stderr.log`,
    });
    const failureSummaryPath = fields?.['failureSummaryPath'] as string | null;
    expect(failureSummaryPath).toBe(path.join(tempDir, 'runs', FIXED_RUN_ID, 'failure-summary.md'));
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(failureSummaryPath as string, 'utf8');
    expect(body).toContain('# Run Failed (Retry Exhausted)');
    expect(body).toContain('Issue: #19');
    expect(body).toContain('Last failure reason: stalled');
    expect(body).toContain(`Last run id: ${FIXED_RUN_ID}`);
    expect(body).toContain('Manual recovery');
  });

  it('failure summary 書き込みに失敗しても retry exhausted は warn される (orchestrator は壊れない)', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const { processDispatchResultForRetryForTest } = await import('../../src/orchestrator/run.js');
    const queue = createRetryQueue();

    // 直前 attempt が retry queue 起源 (kind=failure attempt=5) で再失敗 → next=6 > max=5 で exhausted
    const previousEntry = queue.schedule({
      kind: 'failure',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath: path.join(tempDir, 'wt-x'),
      attempt: 5,
      failureReason: 'runner_error',
      lastRunId: 'prev-run',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const logger = makeFakeLogger();
    // run log dir が存在しない runsRoot を渡すことで writeFile を ENOENT で落とす
    // (dispatchSelected を経由しないため createRunLog の mkdir は走らない)
    const missingRunsRoot = path.join(tempDir, 'never-created');

    await processDispatchResultForRetryForTest({
      task: {
        candidate: SAMPLE_CANDIDATE,
        issue: SAMPLE_ISSUE,
        repository: { owner: 'hexylab', name: 'philharmonic' },
        retryAttempt: 5,
        retryFrom: previousEntry,
      },
      result: {
        kind: 'failed',
        runId: FIXED_RUN_ID,
        issueNumber: 19,
        reason: 'runner_error',
        branch: 'feature/19-x',
        errorSummary: 'boom',
      },
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      runnerLogsRoot: missingRunsRoot,
      config: makeConfig(),
      dispatchStatuses: ['Todo'],
      logger,
      clock: () => new Date('2026-05-09T00:01:00Z'),
      resolveWorkspacePath: () => path.join(tempDir, 'wt-x'),
      resolveContinuationCandidates: async () => null,
    });

    const warnCalls = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(warnCalls).toContain('failure summary write failed');
    expect(warnCalls).toContain('retry exhausted');
    const exhausted = logger.warn.mock.calls.find((c) => c[0] === 'retry exhausted');
    expect((exhausted?.[1] as Record<string, unknown>)['failureSummaryPath']).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it('Issue が closed なら retry を skip して queue から落とす', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    queue.schedule({
      kind: 'failure',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath: path.join(tempDir, 'wt'),
      attempt: 1,
      failureReason: 'runner_error',
      lastRunId: 'prev-run',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock({
      getIssue: vi.fn(async () => ({ ...SAMPLE_ISSUE, state: 'closed' as const })),
    });
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const logger = makeFakeLogger();

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:01:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    // retry が skip された後、fresh candidate selection が走る → success にもなり得るが
    // 重要なのは「queue から落ちる」こと
    expect(queue.size()).toBe(0);
    expect(runClaudeMock).toHaveBeenCalledTimes(0); // retry も走らず、Issue closed で fresh も走らない
    expect(result.kind === 'no_candidate' || result.kind === 'success').toBe(true);

    const infoMessages = logger.info.mock.calls.map((c) => ({
      msg: c[0] as string,
      fields: c[1] as Record<string, unknown> | undefined,
    }));
    const skipped = infoMessages.find(
      (m) => m.msg === 'retry skipped' && m.fields?.['reason'] === 'closed',
    );
    expect(skipped).toBeDefined();
  });

  it('runner_error 以外 (= 全 retry-eligible) で attempt が積まれる', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');

    const reasons: Array<['timeout' | 'runner_error' | 'stalled', string]> = [
      ['timeout', 'timeout'],
      ['runner_error', 'failed'],
      ['stalled', 'stalled'],
    ];

    for (const [expected, runnerStatus] of reasons) {
      const queue = createRetryQueue();
      const projects = makeProjectsMock();
      const github = makeGitHubMock();
      const workspace = makeWorkspaceMock(path.join(tempDir, `wt-${expected}`));
      const runClaudeMock = vi.fn(async () =>
        makeRunResult({ status: runnerStatus as 'timeout' | 'failed' | 'stalled' }),
      );

      await runOnce({
        config: makeConfig(),
        repoRoot: tempDir,
        githubClient: github,
        projectsClient: projects,
        workspaceManager: workspace,
        workflowSource,
        runnerLogsRoot: path.join(tempDir, 'runs'),
        gitRunner: noopGitRunner,
        runClaude: runClaudeMock,
        generateRunId: () => FIXED_RUN_ID,
        clock: () => new Date('2026-05-09T00:00:00Z'),
        pathExists: async () => false,
        retryQueue: queue,
        maxRetryAttempts: 5,
        maxRetryBackoffMs: 300_000,
      });

      expect(queue.size()).toBe(1);
      expect(queue.list()[0]!.failureReason).toBe(expected);
    }
  });

  it('max_retry_attempts == 0 のとき retry queue は積まれない', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 0,
      maxRetryBackoffMs: 300_000,
    });

    expect(queue.size()).toBe(0);
  });
});

describe('runOnce + continuation retry (#85 / ADR-0009)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-orch-cont-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('success かつ Issue が active のままなら continuation entry が固定 10s 後に schedule される', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const projects = makeProjectsMock(); // SAMPLE_CANDIDATE.status === 'Todo' (active)
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult()); // success
    const logger = makeFakeLogger();

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    expect(result.kind).toBe('success');
    expect(queue.size()).toBe(1);
    const entry = queue.list()[0]!;
    expect(entry.kind).toBe('continuation');
    expect(entry.attempt).toBe(1);
    expect(entry.failureReason).toBeNull();
    expect(entry.lastErrorSummary).toBeNull();
    expect(entry.dueAt.toISOString()).toBe('2026-05-09T00:00:10.000Z');
    // 構造化ログに kind=continuation で retry scheduled が出る
    const scheduledLog = logger.info.mock.calls.find((c) => c[0] === 'retry scheduled');
    expect(scheduledLog).toBeDefined();
    const fields = scheduledLog?.[1] as Record<string, unknown>;
    expect(fields['kind']).toBe('continuation');
    expect(fields['delayMs']).toBe(10_000);
  });

  it('success だが Status が In Review (terminal) になっていれば release される', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    // 1 回目の fetchProjectCandidates は dispatch 用 (Todo)、2 回目は continuation 用 (In Review)
    const candidateInReview: Candidate = { ...SAMPLE_CANDIDATE, status: 'In Review' };
    const projects: ProjectsMock = {
      fetchProjectCandidates: vi
        .fn()
        .mockResolvedValueOnce([SAMPLE_CANDIDATE])
        .mockResolvedValueOnce([candidateInReview]),
    };
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const logger = makeFakeLogger();

    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    expect(result.kind).toBe('success');
    expect(queue.size()).toBe(0);
    const released = logger.info.mock.calls.find((c) => c[0] === 'continuation released');
    expect(released).toBeDefined();
    const fields = released?.[1] as Record<string, unknown>;
    expect(fields['reason']).toBe('terminal_status');
    expect(fields['status']).toBe('In Review');
  });

  it('success だが Issue が close 済みなら release される', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const closedCandidate: Candidate = {
      ...SAMPLE_CANDIDATE,
      issueState: 'CLOSED',
      status: 'Done',
    };
    const projects: ProjectsMock = {
      fetchProjectCandidates: vi
        .fn()
        .mockResolvedValueOnce([SAMPLE_CANDIDATE])
        .mockResolvedValueOnce([closedCandidate]),
    };
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    expect(queue.size()).toBe(0);
    const released = logger.info.mock.calls.find((c) => c[0] === 'continuation released');
    expect(released?.[1]).toMatchObject({ reason: 'closed' });
  });

  it('continuation 中の Issue は fresh candidate selection から retry_queued で skip される', async () => {
    // ADR-0009 §5: success で worktree が cleanup されている間に同 Issue を fresh selection が
    // 拾わないことを保証する。
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    // 同 Issue を kind=continuation で先に積んでおく (まだ due ではないので drainDue では取れない)
    queue.schedule({
      kind: 'continuation',
      issueNumber: SAMPLE_CANDIDATE.issueNumber,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath: path.join(tempDir, 'wt'),
      attempt: 1,
      failureReason: null,
      lastRunId: 'prev',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock(); // SAMPLE_CANDIDATE.status === 'Todo'
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
    const logger = makeFakeLogger();

    // continuation の dueAt は 00:00:10。clock を 00:00:05 に設定して drainDue が空になるようにする
    const result = await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:05Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    expect(result.kind).toBe('no_candidate');
    expect(runClaudeMock).toHaveBeenCalledTimes(0);
    expect(queue.size()).toBe(1); // continuation entry は据え置き
    const skipped = logger.info.mock.calls.find((c) => c[0] === 'skip candidate (retry queued)');
    expect(skipped).toBeDefined();
  });

  it('continuation attempt が max_retry_attempts に達したら exhausted になる', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    // attempt=5 の continuation entry が due な状態を作る
    const workspacePath = path.join(tempDir, 'wt');
    queue.schedule({
      kind: 'continuation',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 5,
      failureReason: null,
      lastRunId: 'prev',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult()); // success
    const logger = makeFakeLogger();

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:30Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    expect(queue.size()).toBe(0);
    const exhausted = logger.warn.mock.calls.find((c) => c[0] === 'retry exhausted');
    expect(exhausted?.[1]).toMatchObject({ kind: 'continuation', attempt: 5 });
  });

  it('success だが continuation 用の fetchProjectCandidates が失敗したら release される', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const projects: ProjectsMock = {
      fetchProjectCandidates: vi
        .fn()
        .mockResolvedValueOnce([SAMPLE_CANDIDATE]) // dispatch 用 (success まで進むため)
        .mockRejectedValueOnce(new Error('boom')), // continuation 用 (release path)
    };
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
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
    });

    expect(queue.size()).toBe(0);
    const released = logger.info.mock.calls.find((c) => c[0] === 'continuation released');
    expect(released?.[1]).toMatchObject({ reason: 'fetch_error' });
  });

  it('continuation 中の Issue が success で再 dispatch されると attempt が +1 される', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const workspacePath = path.join(tempDir, 'wt');
    queue.schedule({
      kind: 'continuation',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 1,
      failureReason: null,
      lastRunId: 'first-cont',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult());

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => '0190ce80-0000-7000-8000-000000000099',
      clock: () => new Date('2026-05-09T00:00:30Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    });

    expect(queue.size()).toBe(1);
    const entry = queue.list()[0]!;
    expect(entry.kind).toBe('continuation');
    expect(entry.attempt).toBe(2); // 1 → 2
    expect(entry.lastRunId).toBe('0190ce80-0000-7000-8000-000000000099');
  });

  // ─── ADR-0010 / Issue #103: retry exhaustion 時の GitHub safety-net ───

  it('kind=failure の exhaustion で notifyFailureExhausted が config 値とともに呼ばれる', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();
    const workspacePath = path.join(tempDir, 'wt-retry');
    queue.schedule({
      kind: 'failure',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 5,
      failureReason: 'runner_error',
      lastRunId: 'prev-run',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));
    const notify = vi.fn(async () => ({
      statusUpdated: true,
      commentPosted: true,
      duplicateSkipped: false,
    }));

    await runOnce({
      config: makeConfig({
        statusTransitions: {
          inProgress: 'In Progress',
          inReview: 'In Review',
          failed: 'Aborted',
        },
      }),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:01:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      notifyFailureExhausted: notify,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const input = notify.mock.calls[0]![0];
    expect(input).toMatchObject({
      owner: 'hexylab',
      projectNumber: 1,
      statusFieldName: 'Status',
      failedStatus: 'Aborted',
      issueNumber: 19,
      itemId: SAMPLE_CANDIDATE.itemId,
      attempt: 5,
      maxAttempts: 5,
      failureReason: 'stalled',
      runId: FIXED_RUN_ID,
      repository: { owner: 'hexylab', name: 'philharmonic' },
    });
    expect(typeof input.failureSummaryPath).toBe('string');
  });

  it('runGh 未注入 (philharmonic run) では notify は呼ばれない', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();
    const workspacePath = path.join(tempDir, 'wt-noop');
    queue.schedule({
      kind: 'failure',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 5,
      failureReason: 'runner_error',
      lastRunId: 'prev-run',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));
    const logger = makeFakeLogger();

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:01:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
      // runGh / notifyFailureExhausted いずれも未指定
    });

    expect(queue.size()).toBe(0);
    // retry exhausted warn だけは出る (Status / Comment は触らない)
    expect(logger.warn.mock.calls.some((c) => c[0] === 'retry exhausted')).toBe(true);
  });

  it('notifyFailureExhausted が throw しても orchestrator は落ちず warn を残す', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();
    const workspacePath = path.join(tempDir, 'wt-throw');
    queue.schedule({
      kind: 'failure',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 5,
      failureReason: 'runner_error',
      lastRunId: 'prev-run',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));
    const logger = makeFakeLogger();
    const notify = vi.fn(async () => {
      throw new Error('gh: unexpected');
    });

    const result = (await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:01:00Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
      notifyFailureExhausted: notify,
    })) as Extract<RunOnceResult, { kind: 'failed' }>;

    expect(result.kind).toBe('failed');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls.some((c) => c[0] === 'exhaustion notify threw')).toBe(true);
    // retry exhausted warn は notify より先に出ているはず (= ログ順は orchestrator 優先)
    const warnMessages = logger.warn.mock.calls.map((c) => c[0]);
    expect(warnMessages.indexOf('retry exhausted')).toBeLessThan(
      warnMessages.indexOf('exhaustion notify threw'),
    );
  });

  it('kind=continuation の exhaustion では notify は呼ばれない', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();
    const workspacePath = path.join(tempDir, 'wt-cont');

    // attempt=5 の continuation entry を仕込む。retry 中 dispatch が再 success →
    // next attempt が 6 で exhausted (continuation) になる。
    queue.schedule({
      kind: 'continuation',
      issueNumber: 19,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/19-x',
      workspacePath,
      attempt: 5,
      failureReason: null,
      lastRunId: 'prev-cont',
      lastErrorSummary: null,
      now: new Date('2026-05-09T00:00:00Z'),
      maxBackoffMs: 0,
    });

    const projects = makeProjectsMock();
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(workspacePath);
    const runClaudeMock = vi.fn(async () => makeRunResult()); // success
    const logger = makeFakeLogger();
    const notify = vi.fn(async () => ({
      statusUpdated: true,
      commentPosted: true,
      duplicateSkipped: false,
    }));

    await runOnce({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:30Z'),
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
      logger,
      notifyFailureExhausted: notify,
    });

    const exhaustedWarn = logger.warn.mock.calls.find((c) => c[0] === 'retry exhausted');
    expect(exhaustedWarn?.[1]).toMatchObject({ kind: 'continuation' });
    expect(notify).not.toHaveBeenCalled();
  });
});
