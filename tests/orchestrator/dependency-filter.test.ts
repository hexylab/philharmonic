import { describe, expect, it, vi } from 'vitest';

import {
  createDependencyIssueFetcher,
  logDependencyEvaluation,
} from '../../src/orchestrator/dependency-filter.js';
import { GitHubApiError, type GitHubClient, type Issue } from '../../src/github/index.js';
import type { LogFields, Logger } from '../../src/logger/index.js';
import type { Candidate } from '../../src/projects/index.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 100,
    title: 't',
    body: '',
    state: 'open',
    htmlUrl: 'https://example.com',
    labels: [],
    assignees: [],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'PVTI_x',
    issueNumber: 1,
    issueTitle: 't',
    issueUrl: 'u',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'o/r',
    status: 'Todo',
    ...overrides,
  };
}

function makeFakeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    level: 'debug',
    debug,
    info,
    warn,
    error,
    child: () => makeFakeLogger(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

function unusedFields(fields: LogFields | undefined): LogFields {
  return fields ?? {};
}

describe('createDependencyIssueFetcher', () => {
  const repo = { owner: 'hexylab', name: 'philharmonic' };

  it('open Issue を found / open / body 付きで返す', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async () => makeIssue({ number: 42, state: 'open', body: 'hi' })),
      listOpenPullRequests: vi.fn(async () => []),
    };
    const fetcher = createDependencyIssueFetcher({
      githubClient,
      defaultRepository: repo,
    });
    const result = await fetcher(42);
    expect(result).toEqual({ kind: 'found', state: 'open', body: 'hi' });
  });

  it('closed Issue を found / closed / body 付きで返す', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async () => makeIssue({ number: 42, state: 'closed', body: null })),
      listOpenPullRequests: vi.fn(async () => []),
    };
    const fetcher = createDependencyIssueFetcher({
      githubClient,
      defaultRepository: repo,
    });
    const result = await fetcher(42);
    expect(result).toEqual({ kind: 'found', state: 'closed', body: null });
  });

  it('GitHubApiError 404 は not_found に正規化', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async () => {
        throw new GitHubApiError('not found', {
          status: 404,
          responseBody: null,
          method: 'GET',
          url: 'x',
        });
      }),
      listOpenPullRequests: vi.fn(async () => []),
    };
    const fetcher = createDependencyIssueFetcher({
      githubClient,
      defaultRepository: repo,
    });
    expect(await fetcher(99)).toEqual({ kind: 'not_found' });
  });

  it('GitHubApiError 403 は forbidden に正規化', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async () => {
        throw new GitHubApiError('forbidden', {
          status: 403,
          responseBody: null,
          method: 'GET',
          url: 'x',
        });
      }),
      listOpenPullRequests: vi.fn(async () => []),
    };
    const fetcher = createDependencyIssueFetcher({
      githubClient,
      defaultRepository: repo,
    });
    expect(await fetcher(99)).toEqual({ kind: 'forbidden' });
  });

  it('それ以外の例外は error / message を返す', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async () => {
        throw new Error('network down');
      }),
      listOpenPullRequests: vi.fn(async () => []),
    };
    const fetcher = createDependencyIssueFetcher({
      githubClient,
      defaultRepository: repo,
    });
    expect(await fetcher(99)).toEqual({ kind: 'error', message: 'network down' });
  });

  it('500 系の GitHubApiError は error として扱う (status を not_found / forbidden に塗り替えない)', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn(async () => {
        throw new GitHubApiError('server error', {
          status: 500,
          responseBody: null,
          method: 'GET',
          url: 'x',
        });
      }),
      listOpenPullRequests: vi.fn(async () => []),
    };
    const fetcher = createDependencyIssueFetcher({
      githubClient,
      defaultRepository: repo,
    });
    const result = await fetcher(99);
    expect(result.kind).toBe('error');
  });
});

describe('logDependencyEvaluation', () => {
  const candidate = makeCandidate({ issueNumber: 1 });

  it('ready は何もログに出さない', () => {
    const logger = makeFakeLogger();
    logDependencyEvaluation(logger, { state: 'ready', candidate });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('blocked は info レベルで dependency blocked を出す', () => {
    const logger = makeFakeLogger();
    logDependencyEvaluation(logger, {
      state: 'blocked',
      candidate,
      blockingIssueNumbers: [10, 11],
    });
    expect(logger.info).toHaveBeenCalledWith(
      'dependency blocked',
      expect.objectContaining({ issueNumber: 1, blockingIssueNumbers: [10, 11] }),
    );
  });

  it('invalid_dependency は warn レベルで dependency invalid を出し invalidEntries を含める', () => {
    const logger = makeFakeLogger();
    logDependencyEvaluation(logger, {
      state: 'invalid_dependency',
      candidate,
      invalidEntries: [
        { raw: 'foo', issueNumber: null, reason: 'parse_invalid' },
        {
          raw: '#42',
          issueNumber: 42,
          reason: 'fetch_error',
          message: 'oops',
        },
      ],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'dependency invalid',
      expect.objectContaining({
        issueNumber: 1,
        invalidEntries: [
          expect.objectContaining({ raw: 'foo', issueNumber: null, reason: 'parse_invalid' }),
          expect.objectContaining({
            raw: '#42',
            issueNumber: 42,
            reason: 'fetch_error',
            message: 'oops',
          }),
        ],
      }),
    );
    // 第 2 entry の `message` がそのまま現れる
    const fields = unusedFields(logger.warn.mock.calls[0]?.[1] as LogFields | undefined);
    const entries = fields.invalidEntries as ReadonlyArray<Record<string, unknown>>;
    expect(entries[1]).toMatchObject({ message: 'oops' });
  });

  it('cycle は warn レベルで dependency cycle を出し cycleIssueNumbers を含める', () => {
    const logger = makeFakeLogger();
    logDependencyEvaluation(logger, {
      state: 'cycle',
      candidate,
      cycleIssueNumbers: [1, 2],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'dependency cycle',
      expect.objectContaining({ issueNumber: 1, cycleIssueNumbers: [1, 2] }),
    );
  });
});
