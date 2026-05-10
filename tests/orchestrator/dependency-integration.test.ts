/**
 * `runOnce` / `runConcurrent` の candidate selection に dependency filter (ADR-0007 §5 split 3) を
 * 統合した挙動を検証する integration test。
 *
 * - 先頭 candidate が blocked のとき次の ready candidate が選ばれる (#79 AC1)
 * - blocked / invalid / cycle は dispatch されない (#79 AC3)
 * - dependency state が structured log に出る (#79 AC4)
 * - worktree / in-flight 二重 dispatch guard と干渉しない (#79 AC5)
 * - max_concurrent_agents の上限が維持される (#79 AC6)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type { FetchDependencyIssue } from '../../src/dependency/index.js';
import type { GitHubClient, Issue } from '../../src/github/index.js';
import type { LogFields, Logger } from '../../src/logger/index.js';
import { runConcurrent, runOnce, type RunOnceResult } from '../../src/orchestrator/index.js';
import type { Candidate, ProjectsClient } from '../../src/projects/index.js';
import type { RunResult } from '../../src/runner/index.js';
import type { WorkflowSource } from '../../src/workflow/index.js';
import type {
  CreateWorkspaceInput,
  GitRunner,
  Workspace,
  WorkspaceManager,
} from '../../src/workspace/index.js';
import { makeFallbackWorkflowSource } from '../_helpers/workflow.js';

const FIXED_RUN_ID = '0190ce80-0000-7000-8000-000000000000';
const noopGitRunner: GitRunner = async () => ({ stdout: '', stderr: '' });

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
    durationMs: 1_000,
    durationApiMs: 200,
    numTurns: 1,
    turns: 1,
    sessionId: FIXED_RUN_ID,
    resultSubtype: 'success',
    stopReason: 'end_turn',
    isError: false,
    finalText: 'done',
    totalCostUsd: 0.01,
    usage: { inputTokens: 1, outputTokens: 1 },
    rawStderrTail: '',
    resultEventReceived: true,
    logPaths: null,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: `PVTI_${overrides.issueNumber ?? 1}`,
    issueNumber: 1,
    issueTitle: 'sample',
    issueUrl: 'https://example.com',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'Todo',
    ...overrides,
  };
}

function makeIssue(number: number, body: string | null, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `issue-${number}`,
    body,
    state: 'open',
    htmlUrl: `https://example.com/${number}`,
    labels: [],
    assignees: [],
    ...overrides,
  };
}

type IssueByNumber = ReadonlyMap<number, Issue>;

function makeGitHubMock(issues: IssueByNumber): GitHubClient & {
  getIssue: ReturnType<typeof vi.fn>;
  listOpenPullRequests: ReturnType<typeof vi.fn>;
} {
  return {
    getIssue: vi.fn(async ({ issueNumber }: { issueNumber: number }) => {
      const issue = issues.get(issueNumber);
      if (issue === undefined) {
        return makeIssue(issueNumber, '', { state: 'open' });
      }
      return issue;
    }),
    listOpenPullRequests: vi.fn(async () => []),
  };
}

function makeWorkspaceMock(workspacePath: string): WorkspaceManager & {
  createWorkspace: ReturnType<typeof vi.fn>;
  cleanupWorkspace: ReturnType<typeof vi.fn>;
  resolveWorkspacePath: ReturnType<typeof vi.fn>;
} {
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

type FakeLogger = Logger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeFakeLogger(): FakeLogger {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const fake: FakeLogger = {
    level: 'debug',
    debug,
    info,
    warn,
    error,
    child: () => fake,
  } as FakeLogger;
  return fake;
}

function logCalls(
  fake: FakeLogger,
  level: 'info' | 'warn',
): Array<[string, LogFields | undefined]> {
  return (level === 'info' ? fake.info : fake.warn).mock.calls.map(
    (c) => [c[0] as string, c[1] as LogFields | undefined] as const,
  ) as Array<[string, LogFields | undefined]>;
}

describe('runOnce: dependency filter integration (ADR-0007)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-dep-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('先頭 candidate が blocked のとき、board 順で次の ready candidate を選ぶ (AC1)', async () => {
    const cBlocked = makeCandidate({
      itemId: 'A',
      issueNumber: 100,
      issueTitle: 'blocked first',
    });
    const cReady = makeCandidate({
      itemId: 'B',
      issueNumber: 200,
      issueTitle: 'ready second',
    });
    const issues = new Map<number, Issue>([
      [100, makeIssue(100, 'Depends-On: #999')], // 999 は open → blocked
      [200, makeIssue(200, '## Goal\n')],
      [999, makeIssue(999, '', { state: 'open' })],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [cBlocked, cReady]),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
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
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      logger,
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.kind).toBe('success');
    expect(result.issueNumber).toBe(200);

    // structured log に dependency blocked が出る (AC4)
    const blockedLogs = logCalls(logger, 'info').filter(([msg]) => msg === 'dependency blocked');
    expect(blockedLogs).toHaveLength(1);
    expect(blockedLogs[0]?.[1]).toMatchObject({
      issueNumber: 100,
      blockingIssueNumbers: [999],
    });
  });

  it('唯一の candidate が blocked のときは no_candidate (AC3)', async () => {
    const cBlocked = makeCandidate({ issueNumber: 50 });
    const issues = new Map<number, Issue>([
      [50, makeIssue(50, 'Depends-On: #51')],
      [51, makeIssue(51, '', { state: 'open' })],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [cBlocked]),
    };
    const github = makeGitHubMock(issues);
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

  it('依存先が closed なら ready とみなして dispatch する', async () => {
    const c = makeCandidate({ issueNumber: 70 });
    const issues = new Map<number, Issue>([
      [70, makeIssue(70, 'Depends-On: #71')],
      [71, makeIssue(71, '', { state: 'closed' })],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [c]),
    };
    const github = makeGitHubMock(issues);
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
    expect(result.issueNumber).toBe(70);
  });

  it('parse-invalid な entry は invalid_dependency として warn ログを出し dispatch しない (AC3, AC4)', async () => {
    const cInvalid = makeCandidate({ itemId: 'A', issueNumber: 80 });
    const cReady = makeCandidate({ itemId: 'B', issueNumber: 81 });
    const issues = new Map<number, Issue>([
      [80, makeIssue(80, 'Depends-On: hexylab/other#1')], // cross-repo → parse_invalid
      [81, makeIssue(81, '## Goal\n')],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [cInvalid, cReady]),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());
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
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      logger,
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.issueNumber).toBe(81);
    const invalidLogs = logCalls(logger, 'warn').filter(([msg]) => msg === 'dependency invalid');
    expect(invalidLogs).toHaveLength(1);
    expect(invalidLogs[0]?.[1]).toMatchObject({ issueNumber: 80 });
  });

  it('self-dependency は cycle として warn ログを出し dispatch しない (AC3, AC4)', async () => {
    const c = makeCandidate({ issueNumber: 90 });
    const issues = new Map<number, Issue>([[90, makeIssue(90, 'Depends-On: #90')]]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [c]),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
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
      runClaude: vi.fn(),
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      logger,
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    const cycleLogs = logCalls(logger, 'warn').filter(([msg]) => msg === 'dependency cycle');
    expect(cycleLogs).toHaveLength(1);
    expect(cycleLogs[0]?.[1]).toMatchObject({ issueNumber: 90, cycleIssueNumbers: [90] });
  });

  it('依存先が 404 (not_found) のときは invalid_dependency として skip する', async () => {
    const c = makeCandidate({ issueNumber: 60 });
    const issues = new Map<number, Issue>([[60, makeIssue(60, 'Depends-On: #61')]]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [c]),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const logger = makeFakeLogger();

    const fetchDependencyIssue: FetchDependencyIssue = vi.fn(async (n) => {
      if (n === 61) return { kind: 'not_found' };
      return { kind: 'error', message: 'unexpected' };
    });

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
      logger,
      fetchDependencyIssue,
    });

    expect(result).toEqual({ kind: 'no_candidate' });
    const invalidLogs = logCalls(logger, 'warn').filter(([msg]) => msg === 'dependency invalid');
    expect(invalidLogs).toHaveLength(1);
    expect(invalidLogs[0]?.[1]).toMatchObject({
      issueNumber: 60,
      invalidEntries: [expect.objectContaining({ issueNumber: 61, reason: 'not_found' })],
    });
  });

  it('worktree 既存の candidate は dependency filter の前に skip される (AC5)', async () => {
    const cBlocked = makeCandidate({ itemId: 'A', issueNumber: 30 });
    const cReady = makeCandidate({ itemId: 'B', issueNumber: 31 });
    const issues = new Map<number, Issue>([
      [30, makeIssue(30, 'Depends-On: #99')],
      [31, makeIssue(31, '## Goal\n')],
      [99, makeIssue(99, '', { state: 'open' })],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [cBlocked, cReady]),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    workspace.resolveWorkspacePath.mockImplementation((key: string) => path.join(tempDir, key));
    // issue-30 の worktree が既存 (二重 dispatch ガードで skip される)
    const pathExists = vi.fn(async (target: string) => target.includes('issue-30'));
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
      pathExists,
      logger: makeFakeLogger(),
    })) as Extract<RunOnceResult, { kind: 'success' }>;

    expect(result.issueNumber).toBe(31);
    // dependency filter の入力には #30 が含まれない (worktree 既存で先に弾かれる)
    // → fetchIssue で #99 を引きにいかない
    expect(github.getIssue).not.toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 99 }));
  });
});

describe('runConcurrent: dependency filter integration (ADR-0007)', () => {
  let tempDir: string;
  let workflowSource: WorkflowSource;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-dep-c-'));
    workflowSource = await makeFallbackWorkflowSource(tempDir);
  });

  afterEach(async () => {
    await workflowSource.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('blocked / ready が混在しても ready のみを max_concurrent_agents 件まで dispatch する (AC2, AC6)', async () => {
    const candidates: Candidate[] = [
      makeCandidate({ itemId: 'A', issueNumber: 401 }), // blocked
      makeCandidate({ itemId: 'B', issueNumber: 402 }), // ready
      makeCandidate({ itemId: 'C', issueNumber: 403 }), // ready
      makeCandidate({ itemId: 'D', issueNumber: 404 }), // ready
    ];
    const issues = new Map<number, Issue>([
      [401, makeIssue(401, 'Depends-On: #999')],
      [402, makeIssue(402, '## Goal\n')],
      [403, makeIssue(403, '## Goal\n')],
      [404, makeIssue(404, '## Goal\n')],
      [999, makeIssue(999, '', { state: 'open' })],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => candidates),
    };
    const github = makeGitHubMock(issues);
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

    // ready は 402 / 403 / 404 の 3 件あるが、limit=2 で 402, 403 のみ
    expect(outcomes).toHaveLength(2);
    const issueNumbers = outcomes.map((o) => o.result.issueNumber).sort();
    expect(issueNumbers).toEqual([402, 403]);
    // blocked は dispatch されない
    expect(issueNumbers).not.toContain(401);
  });

  it('candidate 全部が blocked のとき空配列を返す (AC3)', async () => {
    const candidates: Candidate[] = [
      makeCandidate({ itemId: 'A', issueNumber: 501 }),
      makeCandidate({ itemId: 'B', issueNumber: 502 }),
    ];
    const issues = new Map<number, Issue>([
      [501, makeIssue(501, 'Depends-On: #999')],
      [502, makeIssue(502, 'Depends-On: #999')],
      [999, makeIssue(999, '', { state: 'open' })],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => candidates),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

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
      generateRunId: () => FIXED_RUN_ID,
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      maxConcurrent: 3,
    });

    expect(outcomes).toEqual([]);
    expect(runClaudeMock).not.toHaveBeenCalled();
  });

  it('candidate 内の依存関係 (A → B、B が同一 batch にいて open) は B が ready として通り、A は blocked', async () => {
    const a = makeCandidate({ itemId: 'A', issueNumber: 601 });
    const b = makeCandidate({ itemId: 'B', issueNumber: 602 });
    const issues = new Map<number, Issue>([
      [601, makeIssue(601, 'Depends-On: #602')],
      [602, makeIssue(602, '## Goal\n')],
    ]);
    const projects: ProjectsClient = {
      fetchProjectCandidates: vi.fn(async () => [a, b]),
    };
    const github = makeGitHubMock(issues);
    const workspace = makeWorkspaceMock(path.join(tempDir, 'wt'));
    const runClaudeMock = vi.fn(async () => makeRunResult());

    let seq = 0;
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
        seq += 1;
        return `0190ce80-0000-7000-8000-00000000000${seq}`;
      },
      clock: () => new Date('2026-05-09T00:00:00Z'),
      pathExists: async () => false,
      maxConcurrent: 2,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result.issueNumber).toBe(602);
  });
});
