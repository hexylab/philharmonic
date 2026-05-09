import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type {
  GitHubClient,
  UpdateProjectV2ItemStatusInput,
  UpdateProjectV2ItemStatusResult,
} from '../../src/github/index.js';
import type { Logger } from '../../src/logger/index.js';
import { promoteRetryReady } from '../../src/orchestrator/retry-promote.js';
import type { Candidate, ProjectMetadata, ProjectsClient } from '../../src/projects/index.js';
import {
  createEmptyRetryState,
  createRetryScheduler,
  type RetryScheduler,
  type RetryState,
  type RetryStorage,
} from '../../src/serve/index.js';

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
    agent: { maxConcurrentAgents: 1, maxTurns: 1, stallTimeoutMs: 300_000 },
    ...overrides,
  };
}

const SAMPLE_METADATA: ProjectMetadata = {
  projectId: 'PVT_1',
  statusFieldId: 'PVTSSF_status',
  statusOptions: [
    { id: 'opt_todo', name: 'Todo' },
    { id: 'opt_ip', name: 'In Progress' },
    { id: 'opt_ir', name: 'In Review' },
    { id: 'opt_failed', name: 'Failed' },
    { id: 'opt_done', name: 'Done' },
  ],
};

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_a',
    issueNumber: 7,
    issueTitle: 'sample issue',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/7',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'Failed',
    ...overrides,
  };
}

function makeMemoryStorage(initial?: RetryState): RetryStorage {
  let state: RetryState = initial ?? createEmptyRetryState();
  return {
    async load() {
      return JSON.parse(JSON.stringify(state)) as RetryState;
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next)) as RetryState;
    },
  };
}

type GitHubMock = GitHubClient & {
  updateProjectV2ItemStatus: ReturnType<typeof vi.fn>;
};

function makeGitHubMock(): GitHubMock {
  return {
    getIssue: vi.fn(),
    commentIssue: vi.fn(),
    createPullRequest: vi.fn(),
    listOpenPullRequests: vi.fn(),
    updateProjectV2ItemStatus: vi.fn(
      async (input: UpdateProjectV2ItemStatusInput): Promise<UpdateProjectV2ItemStatusResult> => ({
        itemId: input.itemId,
      }),
    ) as unknown as ReturnType<typeof vi.fn>,
  };
}

type ProjectsMock = ProjectsClient & {
  fetchProjectCandidates: ReturnType<typeof vi.fn>;
  fetchProjectMetadata: ReturnType<typeof vi.fn>;
};

function makeProjectsMock(
  candidates: Candidate[],
  metadata: ProjectMetadata = SAMPLE_METADATA,
): ProjectsMock {
  return {
    fetchProjectCandidates: vi.fn(async () => candidates),
    fetchProjectMetadata: vi.fn(async () => metadata),
  };
}

type CapturingLogger = Logger & { calls: { level: string; msg: string; fields?: object }[] };

function makeCapturingLogger(): CapturingLogger {
  const calls: { level: string; msg: string; fields?: object }[] = [];
  const make = (): CapturingLogger => {
    const logger = {
      level: 'debug' as const,
      calls,
      debug: (msg: string, fields?: object) => calls.push({ level: 'debug', msg, fields }),
      info: (msg: string, fields?: object) => calls.push({ level: 'info', msg, fields }),
      warn: (msg: string, fields?: object) => calls.push({ level: 'warn', msg, fields }),
      error: (msg: string, fields?: object) => calls.push({ level: 'error', msg, fields }),
      child: () => make(),
    };
    return logger as CapturingLogger;
  };
  return make();
}

async function makeSchedulerWithReady(
  issueNumber: number,
  attempts: number,
  now: Date,
): Promise<RetryScheduler> {
  // attempts 回 recordFailure して、最終的な nextAttemptAt が `now` 以前になるよう調整する
  const storage = makeMemoryStorage();
  const past = new Date(now.getTime() - 1_000_000_000);
  const scheduler = createRetryScheduler({ storage, maxAttempts: 10, maxBackoffMs: 60_000 });
  for (let i = 0; i < attempts; i += 1) {
    await scheduler.recordFailure({ issueNumber, reason: 'runner_error', now: past });
  }
  return scheduler;
}

describe('promoteRetryReady', () => {
  const NOW = new Date('2026-05-09T12:00:00.000Z');

  it('pickReady が空のときは fetch を行わずに ready=0 で返る', async () => {
    const storage = makeMemoryStorage();
    const scheduler = createRetryScheduler({ storage, maxAttempts: 3, maxBackoffMs: 600_000 });
    const projects = makeProjectsMock([]);
    const github = makeGitHubMock();
    const logger = makeCapturingLogger();

    const summary = await promoteRetryReady({
      config: makeConfig(),
      scheduler,
      projectsClient: projects,
      githubClient: github,
      logger,
      clock: () => NOW,
    });

    expect(summary).toEqual({ ready: 0, promoted: 0, skipped: 0, failed: 0 });
    expect(projects.fetchProjectMetadata).not.toHaveBeenCalled();
    expect(projects.fetchProjectCandidates).not.toHaveBeenCalled();
    expect(github.updateProjectV2ItemStatus).not.toHaveBeenCalled();
  });

  it('Failed Status の candidate を Todo に戻す (promoted カウント)', async () => {
    const scheduler = await makeSchedulerWithReady(42, 1, NOW);
    const projects = makeProjectsMock([
      makeCandidate({ itemId: 'PVTI_42', issueNumber: 42, status: 'Failed' }),
    ]);
    const github = makeGitHubMock();
    const logger = makeCapturingLogger();

    const summary = await promoteRetryReady({
      config: makeConfig(),
      scheduler,
      projectsClient: projects,
      githubClient: github,
      logger,
      clock: () => NOW,
    });

    expect(summary).toEqual({ ready: 1, promoted: 1, skipped: 0, failed: 0 });
    expect(github.updateProjectV2ItemStatus).toHaveBeenCalledWith({
      projectId: SAMPLE_METADATA.projectId,
      itemId: 'PVTI_42',
      fieldId: SAMPLE_METADATA.statusFieldId,
      optionId: 'opt_todo',
    });
    const promotedLog = logger.calls.find((c) => c.msg === 'retry promoted to Todo');
    expect(promotedLog?.fields).toMatchObject({ issueNumber: 42, attempts: 1 });
  });

  it('Status が Failed 以外の candidate は skip する (人手で戻された等)', async () => {
    const scheduler = await makeSchedulerWithReady(42, 1, NOW);
    const projects = makeProjectsMock([
      makeCandidate({ itemId: 'PVTI_42', issueNumber: 42, status: 'Todo' }),
    ]);
    const github = makeGitHubMock();
    const logger = makeCapturingLogger();

    const summary = await promoteRetryReady({
      config: makeConfig(),
      scheduler,
      projectsClient: projects,
      githubClient: github,
      logger,
      clock: () => NOW,
    });

    expect(summary).toEqual({ ready: 1, promoted: 0, skipped: 1, failed: 0 });
    expect(github.updateProjectV2ItemStatus).not.toHaveBeenCalled();
    const skipLog = logger.calls.find(
      (c) => c.msg === 'retry promote skipped (status no longer Failed)',
    );
    expect(skipLog?.fields).toMatchObject({ issueNumber: 42, currentStatus: 'Todo' });
  });

  it('candidate が見つからない issue は skip する (Project から削除された等)', async () => {
    const scheduler = await makeSchedulerWithReady(42, 1, NOW);
    const projects = makeProjectsMock([]);
    const github = makeGitHubMock();
    const logger = makeCapturingLogger();

    const summary = await promoteRetryReady({
      config: makeConfig(),
      scheduler,
      projectsClient: projects,
      githubClient: github,
      logger,
      clock: () => NOW,
    });

    expect(summary).toEqual({ ready: 1, promoted: 0, skipped: 1, failed: 0 });
    expect(github.updateProjectV2ItemStatus).not.toHaveBeenCalled();
  });

  it("project に 'Todo' option が無いと全件 skip して warn ログを出す", async () => {
    const scheduler = await makeSchedulerWithReady(42, 1, NOW);
    const customMetadata: ProjectMetadata = {
      projectId: 'PVT_1',
      statusFieldId: 'PVTSSF_status',
      statusOptions: [
        { id: 'opt_ready', name: 'Ready for Agent' },
        { id: 'opt_ip', name: 'In Progress' },
        { id: 'opt_ir', name: 'In Review' },
        { id: 'opt_failed', name: 'Failed' },
      ],
    };
    const projects = makeProjectsMock(
      [makeCandidate({ itemId: 'PVTI_42', issueNumber: 42, status: 'Failed' })],
      customMetadata,
    );
    const github = makeGitHubMock();
    const logger = makeCapturingLogger();

    const summary = await promoteRetryReady({
      config: makeConfig({ dispatchStatuses: ['Ready for Agent'] }),
      scheduler,
      projectsClient: projects,
      githubClient: github,
      logger,
      clock: () => NOW,
    });

    expect(summary).toEqual({ ready: 1, promoted: 0, skipped: 1, failed: 0 });
    expect(github.updateProjectV2ItemStatus).not.toHaveBeenCalled();
    const warn = logger.calls.find(
      (c) =>
        c.level === 'warn' &&
        c.msg.includes("retry promote 対象の Status option 'Todo' が見つかりません"),
    );
    expect(warn).toBeDefined();
  });

  it('Status update が失敗した場合は failed カウントに計上され next tick で再試行可能 (state は変更しない)', async () => {
    const scheduler = await makeSchedulerWithReady(42, 1, NOW);
    const projects = makeProjectsMock([
      makeCandidate({ itemId: 'PVTI_42', issueNumber: 42, status: 'Failed' }),
    ]);
    const github = makeGitHubMock();
    github.updateProjectV2ItemStatus.mockRejectedValueOnce(new Error('graphql boom'));
    const logger = makeCapturingLogger();

    const summary = await promoteRetryReady({
      config: makeConfig(),
      scheduler,
      projectsClient: projects,
      githubClient: github,
      logger,
      clock: () => NOW,
    });

    expect(summary).toEqual({ ready: 1, promoted: 0, skipped: 0, failed: 1 });
    const warn = logger.calls.find((c) => c.msg === 'retry promote failed');
    expect(warn?.fields).toMatchObject({ issueNumber: 42, error: 'graphql boom' });
    // pickReady が次回 tick でも同じ entry を返すこと (state 削除されていない)
    const stillReady = await scheduler.pickReady(NOW);
    expect(stillReady).toHaveLength(1);
    expect(stillReady[0]?.issueNumber).toBe(42);
  });
});
