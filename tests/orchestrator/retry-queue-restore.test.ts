import { describe, expect, it, vi } from 'vitest';

import type { GitHubClient, Issue, OpenPullRequest } from '../../src/github/index.js';
import {
  createRetryQueue,
  releaseRestoredRetries,
  type RetryEntry,
} from '../../src/orchestrator/index.js';

const REPO = { owner: 'hexylab', name: 'philharmonic' };

function makeLogger(): {
  level: 'info';
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
} {
  const logger = {
    level: 'info' as const,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: 't',
    body: '',
    state: 'open',
    htmlUrl: 'https://github.com/hexylab/philharmonic/issues/42',
    labels: [],
    assignees: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    kind: 'failure',
    issueNumber: 42,
    repository: REPO,
    branch: 'feature/42-foo',
    workspacePath: '/abs/issue-42',
    attempt: 2,
    dueAt: new Date('2026-05-09T00:00:30Z'),
    scheduledAt: new Date('2026-05-09T00:00:00Z'),
    failureReason: 'runner_error',
    lastRunId: 'run-1',
    lastErrorSummary: null,
    ...overrides,
  };
}

function makeClient(
  overrides: {
    getIssue?: (input: { issueNumber: number }) => Promise<Issue>;
    listOpenPullRequests?: () => Promise<OpenPullRequest[]>;
  } = {},
): GitHubClient {
  return {
    getIssue: vi.fn(async (input) =>
      overrides.getIssue !== undefined
        ? await overrides.getIssue(input)
        : makeIssue({ number: input.issueNumber }),
    ),
    listOpenPullRequests: vi.fn(async () =>
      overrides.listOpenPullRequests !== undefined ? await overrides.listOpenPullRequests() : [],
    ),
  };
}

describe('releaseRestoredRetries', () => {
  it('open issue かつ open PR が無ければ entry を保持する', async () => {
    const queue = createRetryQueue({ initialEntries: [makeEntry()] });
    const logger = makeLogger();
    const githubClient = makeClient();

    const summary = await releaseRestoredRetries({ queue, githubClient, logger });
    expect(summary).toEqual({ inspected: 1, released: 0, retained: 1, skipped: 0 });
    expect(queue.has(42)).toBe(true);
  });

  it('Issue が closed のときは entry を release する', async () => {
    const queue = createRetryQueue({ initialEntries: [makeEntry()] });
    const logger = makeLogger();
    const githubClient = makeClient({
      getIssue: async () => makeIssue({ state: 'closed' }),
    });

    const summary = await releaseRestoredRetries({ queue, githubClient, logger });
    expect(summary).toEqual({ inspected: 1, released: 1, retained: 0, skipped: 0 });
    expect(queue.has(42)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'retry skipped',
      expect.objectContaining({ reason: 'closed', via: 'restore', issueNumber: 42 }),
    );
  });

  it('open PR が存在するときは entry を release する', async () => {
    const queue = createRetryQueue({ initialEntries: [makeEntry()] });
    const logger = makeLogger();
    const githubClient = makeClient({
      listOpenPullRequests: async () => [
        { number: 100, headRef: 'feature/42-foo', htmlUrl: 'https://github.com/x/y/pull/100' },
      ],
    });

    const summary = await releaseRestoredRetries({ queue, githubClient, logger });
    expect(summary).toEqual({ inspected: 1, released: 1, retained: 0, skipped: 0 });
    expect(queue.has(42)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'retry skipped',
      expect.objectContaining({ reason: 'open_pr', via: 'restore', issueNumber: 42 }),
    );
  });

  it('getIssue が throw した entry は warn して queue に残す (= 次の drain tick が拾う)', async () => {
    const queue = createRetryQueue({ initialEntries: [makeEntry()] });
    const logger = makeLogger();
    const githubClient = makeClient({
      getIssue: async () => {
        throw new Error('network blip');
      },
    });

    const summary = await releaseRestoredRetries({ queue, githubClient, logger });
    expect(summary).toEqual({ inspected: 1, released: 0, retained: 0, skipped: 1 });
    expect(queue.has(42)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'retry queue restore fetch error',
      expect.objectContaining({ stage: 'getIssue', issueNumber: 42 }),
    );
  });

  it('listOpenPullRequests が throw した entry は warn して queue に残す', async () => {
    const queue = createRetryQueue({ initialEntries: [makeEntry()] });
    const logger = makeLogger();
    const githubClient = makeClient({
      listOpenPullRequests: async () => {
        throw new Error('rate limit');
      },
    });

    const summary = await releaseRestoredRetries({ queue, githubClient, logger });
    expect(summary).toEqual({ inspected: 1, released: 0, retained: 0, skipped: 1 });
    expect(queue.has(42)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'retry queue restore fetch error',
      expect.objectContaining({ stage: 'listOpenPullRequests', issueNumber: 42 }),
    );
  });

  it('複数 entry の release / retain を独立に処理する', async () => {
    const queue = createRetryQueue({
      initialEntries: [
        makeEntry({ issueNumber: 1 }),
        makeEntry({ issueNumber: 2 }),
        makeEntry({ issueNumber: 3 }),
      ],
    });
    const logger = makeLogger();
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async (input) => {
        if (input.issueNumber === 2) return makeIssue({ state: 'closed', number: 2 });
        return makeIssue({ number: input.issueNumber });
      }),
      listOpenPullRequests: vi.fn(async (input) => {
        if (input.headBranchPrefix === 'feature/3-') {
          return [{ number: 999, headRef: 'feature/3-x', htmlUrl: 'https://example.com' }];
        }
        return [];
      }),
    };

    const summary = await releaseRestoredRetries({ queue, githubClient, logger });
    expect(summary).toEqual({ inspected: 3, released: 2, retained: 1, skipped: 0 });
    expect(queue.has(1)).toBe(true);
    expect(queue.has(2)).toBe(false);
    expect(queue.has(3)).toBe(false);
  });

  it('signal が aborted のときは早期に break する', async () => {
    const queue = createRetryQueue({
      initialEntries: [makeEntry({ issueNumber: 1 }), makeEntry({ issueNumber: 2 })],
    });
    const logger = makeLogger();
    const githubClient = makeClient();
    const controller = new AbortController();
    controller.abort();

    const summary = await releaseRestoredRetries({
      queue,
      githubClient,
      logger,
      signal: controller.signal,
    });
    expect(summary).toEqual({ inspected: 2, released: 0, retained: 0, skipped: 0 });
    expect(queue.size()).toBe(2);
  });
});
