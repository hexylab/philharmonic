import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type { GitHubClient, Issue, OpenPullRequest } from '../../src/github/index.js';
import type { Logger } from '../../src/logger/index.js';
import { recoverInProgress } from '../../src/orchestrator/index.js';
import type { Candidate, ProjectsClient } from '../../src/projects/index.js';
import type { RunResult } from '../../src/runner/index.js';
import type { WorkflowSource } from '../../src/workflow/index.js';
import type {
  CleanupWorkspaceInput,
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
  resolveWorkspacePath: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  cleanupWorkspace: ReturnType<typeof vi.fn>;
  runHooks: ReturnType<typeof vi.fn>;
};

const FIXED_RUN_ID = '0190ce80-0000-7000-8000-000000000023';

const SAMPLE_ISSUE_BODY = '## Description\n\nSome content.\n';

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

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_a',
    issueNumber: 23,
    issueTitle: 'Tracker-driven recovery を実装する',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/23',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'In Progress',
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 23,
    title: 'Tracker-driven recovery を実装する',
    body: SAMPLE_ISSUE_BODY,
    state: 'open',
    htmlUrl: 'https://github.com/hexylab/philharmonic/issues/23',
    labels: [],
    assignees: [],
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
  return {
    getIssue: (overrides.getIssue ?? vi.fn(async () => makeIssue())) as ReturnType<typeof vi.fn>,
    listOpenPullRequests: (overrides.listOpenPullRequests ??
      vi.fn(async (): Promise<OpenPullRequest[]> => [])) as ReturnType<typeof vi.fn>,
  };
}

function makeProjectsMock(candidates: Candidate[]): ProjectsMock {
  return {
    fetchProjectCandidates: vi.fn(async () => candidates),
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
    cleanupWorkspace: vi.fn(async (): Promise<void> => undefined),
    runHooks: vi.fn(async (): Promise<void> => undefined),
  };
}

type FakeLogger = Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

function makeLogger(): FakeLogger {
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  const child = (): FakeLogger => fake;
  const fake: FakeLogger = {
    level: 'debug',
    debug,
    info,
    warn,
    error,
    child,
  };
  return fake;
}

describe('recoverInProgress (ADR-0005: agent 委譲)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-recovery-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('In Progress 0 件のときは早期に完了する', async () => {
    const projects = makeProjectsMock([]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const logger = makeLogger();

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      logger,
    });

    expect(summary.inProgressCount).toBe(0);
    expect(summary.processed).toBe(0);
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('recovery started', { inProgressCount: 0 });
  });

  it('対応する open PR があれば skip してログを残す', async () => {
    const projects = makeProjectsMock([makeCandidate({ issueNumber: 23 })]);
    const github = makeGitHubMock({
      listOpenPullRequests: vi.fn(
        async (): Promise<OpenPullRequest[]> => [
          { number: 99, headRef: 'feature/23-foo', htmlUrl: 'u' },
        ],
      ),
    });
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      logger,
      pathExists: async () => false,
    });

    expect(github.listOpenPullRequests).toHaveBeenCalledWith({
      owner: 'hexylab',
      repo: 'philharmonic',
      headBranchPrefix: 'feature/23-',
    });
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(summary).toEqual({
      inProgressCount: 1,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });
    const skipLog = logger.info.mock.calls.find((c) => c[0] === 'recovery skip (open PR exists)');
    expect(skipLog?.[1]).toMatchObject({ issueNumber: 23, prNumber: 99 });
  });

  it('worktree が残っていれば cleanupWorkspace 後に dispatchSelected が走る', async () => {
    const projects = makeProjectsMock([makeCandidate({ issueNumber: 23 })]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const cleanupOrder: string[] = [];
    const cleanupCalls: CleanupWorkspaceInput[] = [];
    workspace.cleanupWorkspace.mockImplementation(async (input: CleanupWorkspaceInput) => {
      cleanupOrder.push(`cleanup:${input.taskKey}:${input.deleteBranch ?? false}`);
      cleanupCalls.push(input);
    });
    workspace.createWorkspace.mockImplementation(async (input: CreateWorkspaceInput) => {
      cleanupOrder.push(`create:${input.taskKey}`);
      return {
        taskKey: input.taskKey,
        path: path.join(tempDir, 'issue-23'),
        branch: input.branch,
        reused: false,
      };
    });

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      logger,
      pathExists: async () => true,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(cleanupOrder[0]).toBe('cleanup:issue-23:true');
    expect(cleanupCalls[0]).toMatchObject({
      taskKey: 'issue-23',
      deleteBranch: true,
      branch: expect.stringMatching(/^feature\/23-/),
    });
    expect(cleanupOrder.slice(1)).toContain('create:issue-23');
    expect(summary).toMatchObject({
      inProgressCount: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('worktree が無ければそのまま dispatchSelected が走る (cleanup は success 経路の 1 回のみ)', async () => {
    const projects = makeProjectsMock([makeCandidate({ issueNumber: 23 })]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      logger,
      pathExists: async () => false,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    // success 経路で 1 回 cleanup される (deleteBranch=true)
    expect(workspace.cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(workspace.cleanupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ deleteBranch: true }),
    );
    expect(workspace.createWorkspace).toHaveBeenCalledTimes(1);
    expect(summary.succeeded).toBe(1);
  });

  it('dispatchSelected が failed を返したら次 item に進む (Status flip は agent 任せ)', async () => {
    const projects = makeProjectsMock([
      makeCandidate({ itemId: 'PVTI_a', issueNumber: 23 }),
      makeCandidate({ itemId: 'PVTI_b', issueNumber: 24 }),
    ]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();
    let call = 0;
    const runClaudeMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return makeRunResult({ status: 'failed', exitCode: 1 });
      return makeRunResult();
    });
    workspace.resolveWorkspacePath.mockImplementation((key: string) => path.join(tempDir, key));
    workspace.createWorkspace.mockImplementation(async (input: CreateWorkspaceInput) => ({
      taskKey: input.taskKey,
      path: path.join(tempDir, input.taskKey),
      branch: input.branch,
      reused: false,
    }));

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      logger,
      pathExists: async () => false,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('signal が aborted になったら次 item に進まない', async () => {
    const candidates = [
      makeCandidate({ itemId: 'PVTI_a', issueNumber: 23 }),
      makeCandidate({ itemId: 'PVTI_b', issueNumber: 24 }),
    ];
    const projects = makeProjectsMock(candidates);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();
    const ac = new AbortController();
    workspace.resolveWorkspacePath.mockImplementation((k: string) => path.join(tempDir, k));
    workspace.createWorkspace.mockImplementation(async (input: CreateWorkspaceInput) => {
      ac.abort();
      return {
        taskKey: input.taskKey,
        path: path.join(tempDir, input.taskKey),
        branch: input.branch,
        reused: false,
      };
    });
    const runClaudeMock = vi.fn(async () => makeRunResult());

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: ac.signal,
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      logger,
      pathExists: async () => false,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(summary.processed).toBe(1);
  });

  it('Issue が closed 状態なら skip して次に進む', async () => {
    const projects = makeProjectsMock([makeCandidate()]);
    const github = makeGitHubMock({
      getIssue: vi.fn(async () => makeIssue({ state: 'closed' })),
    });
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: vi.fn(),
      logger,
      pathExists: async () => false,
    });

    expect(summary.skipped).toBe(1);
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
    const skipLog = logger.info.mock.calls.find((c) => c[0] === 'recovery skip (issue closed)');
    expect(skipLog).toBeDefined();
  });

  it('dispatchSelected が failed を返したら retryQueue に attempt=1 で schedule する (#84 / ADR-0008)', async () => {
    const { createRetryQueue } = await import('../../src/orchestrator/retry-queue.js');
    const queue = createRetryQueue();

    const candidate = makeCandidate();
    const projects = makeProjectsMock([candidate]);
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt-recovery'));
    const runClaudeMock = vi.fn(async () => makeRunResult({ status: 'stalled' }));
    const logger = makeLogger();

    const summary = await recoverInProgress({
      config: makeConfig(),
      repoRoot: tempDir,
      githubClient: github,
      projectsClient: projects,
      workspaceManager: workspace,
      workflowSource,
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      gitRunner: noopGitRunner,
      runClaude: runClaudeMock,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      logger,
      pathExists: async () => false,
      retryQueue: queue,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    });

    expect(summary.failed).toBe(1);
    expect(queue.size()).toBe(1);
    const entry = queue.list()[0]!;
    expect(entry.issueNumber).toBe(candidate.issueNumber);
    expect(entry.attempt).toBe(1);
    expect(entry.failureReason).toBe('stalled');
    expect(entry.dueAt.toISOString()).toBe('2026-05-09T00:00:10.000Z');
  });
});
