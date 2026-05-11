import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/index.js';
import type { GitHubClient, OpenPullRequest } from '../../src/github/index.js';
import type { Logger } from '../../src/logger/index.js';
import {
  createRetryQueue,
  recoverOrphaned,
  type RetryQueue,
} from '../../src/orchestrator/index.js';
import type { Candidate, ProjectsClient } from '../../src/projects/index.js';
import {
  createRunTracker,
  type OperatorActionReason,
  type RunTracker,
} from '../../src/server/index.js';

const REPO_ROOT = '/srv/repo';
const WORKSPACE_ROOT = '.philharmonic/worktrees';
const RUNNER_LOGS_ROOT = '/srv/repo/.philharmonic/runs';

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
    workspaceRoot: WORKSPACE_ROOT,
    dispatchStatuses: ['Todo'],
    statusTransitions: { inProgress: 'In Progress', inReview: 'In Review', failed: 'Failed' },
    terminalStatuses: ['In Review', 'Failed', 'Done'],
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
    github: { tokenSource: 'auto' },
    safety: { allowBypassInServe: false },
    server: null,
    ...overrides,
  } as Config;
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_test',
    issueNumber: 42,
    issueTitle: 'fix it',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/42',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'In Progress',
    ...overrides,
  };
}

type GitHubMock = GitHubClient & {
  listOpenPullRequests: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
};

function makeGitHubMock(
  overrides: { listOpenPullRequests?: OpenPullRequest[] | Error } = {},
): GitHubMock {
  const list = overrides.listOpenPullRequests ?? [];
  return {
    getIssue: vi.fn(),
    listOpenPullRequests: vi.fn(async () => {
      if (list instanceof Error) throw list;
      return list;
    }),
  };
}

type ProjectsMock = ProjectsClient & {
  fetchProjectCandidates: ReturnType<typeof vi.fn>;
};

function makeProjectsMock(candidates: Candidate[] | Error): ProjectsMock {
  return {
    fetchProjectCandidates: vi.fn(async () => {
      if (candidates instanceof Error) throw candidates;
      return candidates;
    }),
  };
}

type FakeLogger = Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

function makeLogger(): FakeLogger {
  const info = vi.fn();
  const warn = vi.fn();
  const fake: FakeLogger = {
    level: 'debug',
    debug: vi.fn(),
    info,
    warn,
    error: vi.fn(),
    child: () => fake,
  };
  return fake;
}

type TrackerSetup = {
  tracker: RunTracker;
  runId: string;
  issueNumber: number;
  startedAt: Date;
};

function startTrackerEntry(input: {
  runId?: string;
  issueNumber?: number;
  startedAt?: Date;
  workspacePath?: string;
  watchdog?: 'both' | 'orphaned_only' | 'stale_only' | 'none';
  runnerPid?: number | null;
  branch?: string;
  lastActivityAt?: Date;
}): TrackerSetup {
  const tracker = createRunTracker({
    startedAt: input.startedAt ?? new Date('2026-05-09T00:00:00Z'),
  });
  const runId = input.runId ?? 'r-1';
  const issueNumber = input.issueNumber ?? 42;
  const startedAt = input.startedAt ?? new Date('2026-05-09T00:00:00Z');
  const workspacePath =
    input.workspacePath ?? `${REPO_ROOT}/${WORKSPACE_ROOT}/issue-${issueNumber}`;
  tracker.runStarted({
    runId,
    issueNumber,
    branch: input.branch ?? `feature/${issueNumber}-fix`,
    startedAt,
    workspacePath,
    runLogPath: `/tmp/runs/${runId}`,
  });
  if (input.runnerPid !== null) tracker.recordRunnerProcess(runId, input.runnerPid ?? 12345);
  if (input.lastActivityAt !== undefined) tracker.recordActivity(runId, input.lastActivityAt);

  const watchdogKind = input.watchdog ?? 'both';
  if (watchdogKind !== 'none') {
    const reasons =
      watchdogKind === 'both'
        ? (['orphaned', 'stale'] as const)
        : watchdogKind === 'orphaned_only'
          ? (['orphaned'] as const)
          : (['stale'] as const);
    const since = '2026-05-09T00:01:00.000Z';
    const operatorReasons: OperatorActionReason[] =
      watchdogKind === 'orphaned_only'
        ? ['orphaned_only']
        : watchdogKind === 'stale_only'
          ? ['stale_only']
          : [];
    tracker.setWatchdog(runId, {
      reasons: [...reasons],
      orphanedSince: reasons.includes('orphaned') ? since : null,
      staleSince: reasons.includes('stale') ? since : null,
      operatorActionRequired: operatorReasons.length > 0,
      operatorActionReasons: operatorReasons,
    });
  }

  return { tracker, runId, issueNumber, startedAt };
}

const FIXED_NOW = new Date('2026-05-09T00:05:00.000Z');

function makeDeps(
  setup: TrackerSetup,
  overrides: {
    retryQueue?: RetryQueue | undefined;
    maxRetryAttempts?: number;
    maxRetryBackoffMs?: number;
    github?: GitHubMock;
    projects?: ProjectsMock;
    notifyFailureExhausted?: ReturnType<typeof vi.fn>;
    config?: Config;
    repoRoot?: string;
    logger?: FakeLogger;
  } = {},
): {
  config: Config;
  repoRoot: string;
  tracker: RunTracker;
  githubClient: GitHubMock;
  projectsClient: ProjectsMock;
  retryQueue: RetryQueue | undefined;
  maxRetryAttempts: number;
  maxRetryBackoffMs: number;
  notifyFailureExhausted: ReturnType<typeof vi.fn> | undefined;
  runnerLogsRoot: string;
  now: () => Date;
  logger: FakeLogger;
} {
  const candidate = makeCandidate({ issueNumber: setup.issueNumber });
  return {
    config: overrides.config ?? makeConfig(),
    repoRoot: overrides.repoRoot ?? REPO_ROOT,
    tracker: setup.tracker,
    githubClient: overrides.github ?? makeGitHubMock(),
    projectsClient: overrides.projects ?? makeProjectsMock([candidate]),
    retryQueue: 'retryQueue' in overrides ? overrides.retryQueue : createRetryQueue(),
    maxRetryAttempts: overrides.maxRetryAttempts ?? 5,
    maxRetryBackoffMs: overrides.maxRetryBackoffMs ?? 300_000,
    notifyFailureExhausted: overrides.notifyFailureExhausted,
    runnerLogsRoot: RUNNER_LOGS_ROOT,
    now: () => FIXED_NOW,
    logger: overrides.logger ?? makeLogger(),
  };
}

describe('recoverOrphaned (#109)', () => {
  it('orphaned + stale + no open PR + retry slot 余裕で tracker.runFinished + retryQueue.schedule (attempt=1)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes).toEqual([
      { kind: 'recovered', runId: setup.runId, issueNumber: setup.issueNumber, attempt: 1 },
    ]);
    expect(deps.tracker.listRunning()).toHaveLength(0);
    expect(deps.tracker.getTotals()).toMatchObject({ runsFailed: 1 });

    const entry = queue.list()[0];
    expect(entry?.kind).toBe('failure');
    expect(entry?.attempt).toBe(1);
    expect(entry?.failureReason).toBe('stalled');
    expect(entry?.issueNumber).toBe(setup.issueNumber);
    expect(entry?.workspacePath).toBe(`${REPO_ROOT}/${WORKSPACE_ROOT}/issue-${setup.issueNumber}`);
  });

  it('既存 failure entry がある場合は attempt+1 で schedule', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    queue.schedule({
      kind: 'failure',
      issueNumber: setup.issueNumber,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: `feature/${setup.issueNumber}-fix`,
      workspacePath: `${REPO_ROOT}/${WORKSPACE_ROOT}/issue-${setup.issueNumber}`,
      attempt: 2,
      failureReason: 'stalled',
      lastRunId: 'prev-run',
      lastErrorSummary: 'prev',
      now: new Date('2026-05-09T00:04:00Z'),
      maxBackoffMs: 300_000,
    });
    const deps = makeDeps(setup, { retryQueue: queue });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({ kind: 'recovered', attempt: 3 });
    expect(queue.list()[0]?.attempt).toBe(3);
  });

  it('nextAttempt > maxRetryAttempts のとき exhaustion へ流す (notifyFailureExhausted を呼ぶ)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    queue.schedule({
      kind: 'failure',
      issueNumber: setup.issueNumber,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: `feature/${setup.issueNumber}-fix`,
      workspacePath: `${REPO_ROOT}/${WORKSPACE_ROOT}/issue-${setup.issueNumber}`,
      attempt: 5,
      failureReason: 'stalled',
      lastRunId: 'prev-run',
      lastErrorSummary: 'prev',
      now: new Date('2026-05-09T00:04:00Z'),
      maxBackoffMs: 300_000,
    });
    const notify = vi.fn(async () => ({
      status: { ok: true as const },
      comment: { ok: true as const, skipped: false as const },
    }));
    const deps = makeDeps(setup, {
      retryQueue: queue,
      maxRetryAttempts: 5,
      notifyFailureExhausted: notify,
    });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({ kind: 'exhausted', attempt: 5 });
    expect(queue.size()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: setup.issueNumber,
        failureReason: 'stalled',
        attempt: 5,
        maxAttempts: 5,
      }),
    );
    expect(deps.tracker.listRunning()).toHaveLength(0);
  });

  it('orphaned のみ (stale なし) は operator_action_required で no-op', async () => {
    const setup = startTrackerEntry({ watchdog: 'orphaned_only' });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'not_eligible' });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('stale のみ (orphaned なし) は operator_action_required で no-op', async () => {
    const setup = startTrackerEntry({ watchdog: 'stale_only' });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'not_eligible' });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('open PR があれば operator_action_required で touch しない', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    const github = makeGitHubMock({
      listOpenPullRequests: [
        { number: 1, headRef: `feature/${setup.issueNumber}-x`, draft: false },
      ],
    });
    const deps = makeDeps(setup, { retryQueue: queue, github });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({
      kind: 'operator_action_required',
      reasons: expect.arrayContaining(['open_pr']),
    });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
    expect(deps.tracker.getRunningByIssue(setup.issueNumber)?.watchdog).toMatchObject({
      operatorActionRequired: true,
      operatorActionReasons: expect.arrayContaining(['open_pr']),
    });
  });

  it('retryQueue 未注入で operator_action_required (retry_disabled)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const deps = makeDeps(setup, { retryQueue: undefined });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({
      kind: 'operator_action_required',
      reasons: expect.arrayContaining(['retry_disabled']),
    });
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('maxRetryAttempts == 0 で operator_action_required (retry_disabled)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue, maxRetryAttempts: 0 });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({
      kind: 'operator_action_required',
      reasons: expect.arrayContaining(['retry_disabled']),
    });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('workspacePath が workspaceRoot 配下でないなら unsafe_workspace_path', async () => {
    const setup = startTrackerEntry({
      watchdog: 'both',
      workspacePath: '/etc/passwd-fake',
    });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({
      kind: 'operator_action_required',
      reasons: expect.arrayContaining(['unsafe_workspace_path']),
    });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('fetchProjectCandidates が候補に居ないなら recover_error', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    const projects = makeProjectsMock([]);
    const deps = makeDeps(setup, { retryQueue: queue, projects });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({
      kind: 'operator_action_required',
      reasons: expect.arrayContaining(['recover_error']),
    });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('listOpenPullRequests が throw した場合は recover_error', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    const github = makeGitHubMock({ listOpenPullRequests: new Error('network down') });
    const deps = makeDeps(setup, { retryQueue: queue, github });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({
      kind: 'operator_action_required',
      reasons: expect.arrayContaining(['recover_error']),
    });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });

  it('連続 tick で同じ orphaned+stale を 2 度 recover しない (べき等性)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue });

    await recoverOrphaned(deps);
    // 1 回目で tracker から外れる
    expect(deps.tracker.listRunning()).toHaveLength(0);

    // 2 度目は entry が無いため schedule は呼ばれない (queue は 1 件のまま)
    await recoverOrphaned(deps);
    expect(queue.size()).toBe(1);
  });

  it('exhausted 経路で tracker.runFinished が retryQueue.remove より先に呼ばれる (順序保証)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const tracker = setup.tracker;
    const queue = createRetryQueue();
    queue.schedule({
      kind: 'failure',
      issueNumber: setup.issueNumber,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: `feature/${setup.issueNumber}-fix`,
      workspacePath: `${REPO_ROOT}/${WORKSPACE_ROOT}/issue-${setup.issueNumber}`,
      attempt: 5,
      failureReason: 'stalled',
      lastRunId: 'prev-run',
      lastErrorSummary: 'prev',
      now: new Date('2026-05-09T00:04:00Z'),
      maxBackoffMs: 300_000,
    });

    const runFinishedSpy = vi.spyOn(tracker, 'runFinished');
    const removeSpy = vi.spyOn(queue, 'remove');
    const notify = vi.fn(async () => ({
      status: { ok: true as const },
      comment: { ok: true as const, skipped: false as const },
    }));
    const deps = makeDeps(setup, {
      retryQueue: queue,
      maxRetryAttempts: 5,
      notifyFailureExhausted: notify,
    });

    await recoverOrphaned(deps);

    expect(runFinishedSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    const finishedOrder = runFinishedSpy.mock.invocationCallOrder[0]!;
    const removeOrder = removeSpy.mock.invocationCallOrder[0]!;
    expect(finishedOrder).toBeLessThan(removeOrder);
  });

  it('orphaned + stale 同時 marker のときは watchdog 由来 operator reason が空 (#105 整合)', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    // setup 時点で operator_action_required は false / [] のまま (orphan-recovery 前)
    const before = setup.tracker.getRunningByIssue(setup.issueNumber)?.watchdog;
    expect(before?.operatorActionRequired).toBe(false);
    expect(before?.operatorActionReasons).toEqual([]);
  });

  it('open_pr で立てた reason が次 tick で recovery 合格しても remain せず置き換わる', async () => {
    const setup = startTrackerEntry({ watchdog: 'both' });
    const queue = createRetryQueue();

    // 1 回目: open PR ありで operator_action
    const github1 = makeGitHubMock({
      listOpenPullRequests: [
        { number: 1, headRef: `feature/${setup.issueNumber}-x`, draft: false },
      ],
    });
    await recoverOrphaned(makeDeps(setup, { retryQueue: queue, github: github1 }));
    expect(
      setup.tracker.getRunningByIssue(setup.issueNumber)?.watchdog?.operatorActionReasons,
    ).toEqual(['open_pr']);

    // 2 回目: open PR が無くなって retry 上限 0 なら retry_disabled に置き換わる
    const deps2 = makeDeps(setup, { retryQueue: queue, maxRetryAttempts: 0 });
    await recoverOrphaned(deps2);
    const after = setup.tracker.getRunningByIssue(setup.issueNumber)?.watchdog;
    expect(after?.operatorActionReasons).toEqual(['retry_disabled']);
    expect(after?.operatorActionReasons).not.toContain('open_pr');
  });

  it('watchdog が null の entry は skip (#105 marker 未評価)', async () => {
    const setup = startTrackerEntry({ watchdog: 'none' });
    const queue = createRetryQueue();
    const deps = makeDeps(setup, { retryQueue: queue });

    const result = await recoverOrphaned(deps);

    expect(result.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'not_eligible' });
    expect(queue.size()).toBe(0);
    expect(deps.tracker.listRunning()).toHaveLength(1);
  });
});
