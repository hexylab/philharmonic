import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type {
  GitHubClient,
  Issue,
  IssueComment,
  OpenPullRequest,
  PullRequest,
  UpdateProjectV2ItemStatusInput,
  UpdateProjectV2ItemStatusResult,
} from '../../src/github/index.js';
import type { Logger } from '../../src/logger/index.js';
import { recoverInProgress } from '../../src/orchestrator/index.js';
import type { Candidate, ProjectMetadata, ProjectsClient } from '../../src/projects/index.js';
import type { RunResult } from '../../src/runner/index.js';
import type {
  CleanupWorkspaceInput,
  CreateWorkspaceInput,
  GitRunner,
  Workspace,
  WorkspaceManager,
} from '../../src/workspace/index.js';

type GitHubMock = GitHubClient & {
  getIssue: ReturnType<typeof vi.fn>;
  commentIssue: ReturnType<typeof vi.fn>;
  createPullRequest: ReturnType<typeof vi.fn>;
  listOpenPullRequests: ReturnType<typeof vi.fn>;
  updateProjectV2ItemStatus: ReturnType<typeof vi.fn>;
};

type ProjectsMock = ProjectsClient & {
  fetchProjectCandidates: ReturnType<typeof vi.fn>;
  fetchProjectMetadata: ReturnType<typeof vi.fn>;
};

type WorkspaceMock = WorkspaceManager & {
  resolveWorkspacePath: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  cleanupWorkspace: ReturnType<typeof vi.fn>;
};

const FIXED_RUN_ID = '0190ce80-0000-7000-8000-000000000023';

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

const SAMPLE_ISSUE_BODY = `## Goal\n\nGoal\n\n## Constraints\n\n- c1\n\n## Acceptance Criteria\n\n- [ ] AC1\n`;

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
    polling: { intervalMs: 30_000 },
    retry: { maxAttempts: 3, maxBackoffMs: 600_000 },
    agent: { maxConcurrentAgents: 1 },
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
    commentIssue: (overrides.commentIssue ??
      vi.fn(async (): Promise<IssueComment> => ({ id: 1, htmlUrl: 'u' }))) as ReturnType<
      typeof vi.fn
    >,
    createPullRequest: (overrides.createPullRequest ??
      vi.fn(
        async (): Promise<PullRequest> => ({
          number: 99,
          htmlUrl: 'https://example.com/pr/99',
          draft: false,
        }),
      )) as ReturnType<typeof vi.fn>,
    listOpenPullRequests: (overrides.listOpenPullRequests ??
      vi.fn(async (): Promise<OpenPullRequest[]> => [])) as ReturnType<typeof vi.fn>,
    updateProjectV2ItemStatus: (overrides.updateProjectV2ItemStatus ??
      vi.fn(
        async (
          input: UpdateProjectV2ItemStatusInput,
        ): Promise<UpdateProjectV2ItemStatusResult> => ({
          itemId: input.itemId,
        }),
      )) as ReturnType<typeof vi.fn>,
  };
}

function makeProjectsMock(
  candidates: Candidate[],
  metadata: ProjectMetadata = SAMPLE_METADATA,
): ProjectsMock {
  return {
    fetchProjectCandidates: vi.fn(async () => candidates),
    fetchProjectMetadata: vi.fn(async () => metadata),
  };
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
    cleanupWorkspace: vi.fn(async (): Promise<void> => undefined),
  };
}

function makeGitRunner(): GitRunner {
  return async (args) => {
    const command = args[0];
    if (command === 'rev-list') return { stdout: '1\n', stderr: '' };
    return { stdout: '', stderr: '' };
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

describe('recoverInProgress', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-recovery-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('In Progress 0 件のときは fetchProjectMetadata を呼ばずに完了する', async () => {
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      runClaude: vi.fn(),
      gitRunner: makeGitRunner(),
      logger,
    });

    expect(summary.inProgressCount).toBe(0);
    expect(summary.processed).toBe(0);
    expect(projects.fetchProjectMetadata).not.toHaveBeenCalled();
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      runClaude: vi.fn(),
      gitRunner: makeGitRunner(),
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      logger,
      pathExists: async () => true,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    // force reset: cleanup → create の順
    // cleanup には deleteBranch=true と branch=feature/23-<slug> が渡される
    // (branch を消さないと後段の createWorkspace({ reuse: false }) が branch_already_exists で
    //  失敗するため、recovery 自体が破綻する。spec: orchestration-mvp.md 参照)
    expect(cleanupOrder[0]).toBe('cleanup:issue-23:true');
    expect(cleanupCalls[0]).toMatchObject({
      taskKey: 'issue-23',
      deleteBranch: true,
      branch: expect.stringMatching(/^feature\/23-/),
    });
    expect(cleanupOrder.slice(1)).toContain('create:issue-23');
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
    // recovery では Todo→In Progress 遷移は呼ばない (= In Review への 1 回のみ)
    expect(github.updateProjectV2ItemStatus).toHaveBeenCalledTimes(1);
    expect(github.updateProjectV2ItemStatus).toHaveBeenCalledWith(
      expect.objectContaining({ optionId: 'opt_ir' }),
    );
    expect(summary).toMatchObject({
      inProgressCount: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('worktree が無ければそのまま dispatchSelected が走る (cleanup は呼ばない)', async () => {
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      logger,
      pathExists: async () => false,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(workspace.cleanupWorkspace).toHaveBeenCalledTimes(1); // 8.4 success cleanup のみ
    // 8.4 cleanup は deleteBranch=true で呼ばれる (= force reset 用ではない)
    expect(workspace.cleanupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ deleteBranch: true }),
    );
    expect(workspace.createWorkspace).toHaveBeenCalledTimes(1);
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
    expect(summary.succeeded).toBe(1);
  });

  it('dispatchSelected が failed を返したら markFailed まで通って次 item に進む', async () => {
    const projects = makeProjectsMock([
      makeCandidate({ itemId: 'PVTI_a', issueNumber: 23 }),
      makeCandidate({ itemId: 'PVTI_b', issueNumber: 24 }),
    ]);
    const github = makeGitHubMock({
      // Issue 23 は runner エラーになるよう仕込む
      // → runClaude 側で kind=failed を返す
    });
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      logger,
      pathExists: async () => false,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    // 失敗側: Issue コメント + Status Failed が呼ばれる
    expect(github.commentIssue).toHaveBeenCalledTimes(1);
    expect(
      github.updateProjectV2ItemStatus.mock.calls.some(
        (c) => (c[0] as UpdateProjectV2ItemStatusInput).optionId === 'opt_fail',
      ),
    ).toBe(true);
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
      // 1 件目の dispatch 中に abort
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: ac.signal,
      runClaude: runClaudeMock,
      gitRunner: makeGitRunner(),
      logger,
      pathExists: async () => false,
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
    });

    expect(summary.processed).toBe(1); // 2 件目には進まない
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('Project metadata 取得失敗は BootstrapError で再 throw する', async () => {
    const projects = makeProjectsMock([makeCandidate()]);
    projects.fetchProjectMetadata.mockRejectedValue(new Error('graphql down'));
    const github = makeGitHubMock();
    const workspace = makeWorkspaceMock(path.join(tempDir, 'issue-23'));
    const logger = makeLogger();

    await expect(
      recoverInProgress({
        config: makeConfig(),
        repoRoot: tempDir,
        githubClient: github,
        projectsClient: projects,
        workspaceManager: workspace,
        runnerLogsRoot: path.join(tempDir, 'runs'),
        signal: new AbortController().signal,
        runClaude: vi.fn(),
        gitRunner: makeGitRunner(),
        logger,
      }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      reason: 'metadata_load_failed',
    });
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
      runnerLogsRoot: path.join(tempDir, 'runs'),
      signal: new AbortController().signal,
      runClaude: vi.fn(),
      gitRunner: makeGitRunner(),
      logger,
      pathExists: async () => false,
    });

    expect(summary.skipped).toBe(1);
    expect(workspace.createWorkspace).not.toHaveBeenCalled();
    const skipLog = logger.info.mock.calls.find((c) => c[0] === 'recovery skip (issue closed)');
    expect(skipLog).toBeDefined();
  });
});
