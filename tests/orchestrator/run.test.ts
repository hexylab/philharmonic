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
    agent: { maxConcurrentAgents: 1, maxTurns: 1, stallTimeoutMs: 300_000 },
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
      listRunning: () => [],
      getRunningByIssue: () => ({
        runId: 'r',
        issueNumber: 19,
        branch: 'feature/19-x',
        startedAt: new Date().toISOString(),
        slot: null,
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
});
