import { describe, expect, it, vi } from 'vitest';

import { GitHubApiError, createGitHubClient, type RestClient } from '../../src/github/index.js';

class FakeOctokitRequestError extends Error {
  public readonly status: number;
  public readonly request: { method: string; url: string };
  public readonly response: { data: unknown };

  constructor(input: {
    message: string;
    status: number;
    method: string;
    url: string;
    data: unknown;
  }) {
    super(input.message);
    this.name = 'HttpError';
    this.status = input.status;
    this.request = { method: input.method, url: input.url };
    this.response = { data: input.data };
  }
}

function buildRestClient(overrides: Partial<RestClient> = {}): RestClient {
  return {
    issues: {
      get: vi.fn(),
      ...overrides.issues,
    },
    pulls: {
      list: vi.fn(),
      ...overrides.pulls,
    },
  };
}

describe('createGitHubClient.getIssue', () => {
  it('REST issues.get の結果を Issue 型に正規化する', async () => {
    const rest = buildRestClient({
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 42,
            title: 'Add feature X',
            body: '## Goal\n\nDo X',
            state: 'open',
            html_url: 'https://github.com/o/r/issues/42',
            labels: [{ name: 'task' }, 'bug'],
            assignees: [{ login: 'alice' }],
          },
        }),
      },
    });

    const client = createGitHubClient({ token: 't', restClient: rest });
    const issue = await client.getIssue({ owner: 'o', repo: 'r', issueNumber: 42 });

    expect(issue).toEqual({
      number: 42,
      title: 'Add feature X',
      body: '## Goal\n\nDo X',
      state: 'open',
      htmlUrl: 'https://github.com/o/r/issues/42',
      labels: [{ name: 'task' }, { name: 'bug' }],
      assignees: [{ login: 'alice' }],
    });
  });

  it('labels / assignees が省略されたら空配列で返す', async () => {
    const rest = buildRestClient({
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 1,
            title: 't',
            body: '',
            state: 'open',
            html_url: 'u',
          },
        }),
      },
    });

    const client = createGitHubClient({ token: 't', restClient: rest });
    const issue = await client.getIssue({ owner: 'o', repo: 'r', issueNumber: 1 });

    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
  });

  it('body が null のときは body=null として返す', async () => {
    const rest = buildRestClient({
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 1,
            title: 't',
            body: null,
            state: 'closed',
            html_url: 'u',
          },
        }),
      },
    });
    const client = createGitHubClient({ token: 't', restClient: rest });
    const issue = await client.getIssue({ owner: 'o', repo: 'r', issueNumber: 1 });
    expect(issue.body).toBeNull();
    expect(issue.state).toBe('closed');
  });

  it('REST 呼び出しが RequestError で失敗したら GitHubApiError に変換する', async () => {
    const rest = buildRestClient({
      issues: {
        get: vi.fn().mockRejectedValue(
          new FakeOctokitRequestError({
            message: 'Not Found',
            status: 404,
            method: 'GET',
            url: '/repos/o/r/issues/9',
            data: { message: 'Not Found' },
          }),
        ),
      },
    });
    const client = createGitHubClient({ token: 't', restClient: rest });

    expect.assertions(4);
    try {
      await client.getIssue({ owner: 'o', repo: 'r', issueNumber: 9 });
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      const apiError = error as GitHubApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.url).toBe('/repos/o/r/issues/9');
      expect(apiError.message).toContain('404');
    }
  });
});

describe('createGitHubClient.listOpenPullRequests', () => {
  it('headBranchPrefix で一致する open PR のみ正規化して返す', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [
        { number: 10, html_url: 'u/10', head: { ref: 'feature/23-foo' } },
        { number: 11, html_url: 'u/11', head: { ref: 'feature/24-bar' } },
        { number: 12, html_url: 'u/12', head: { ref: 'feature/23-baz-something' } },
      ],
    });
    const rest = buildRestClient({
      pulls: { list },
    });

    const client = createGitHubClient({ token: 't', restClient: rest });
    const prs = await client.listOpenPullRequests({
      owner: 'o',
      repo: 'r',
      headBranchPrefix: 'feature/23-',
    });

    expect(list).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      state: 'open',
      per_page: 100,
    });
    expect(prs).toEqual([
      { number: 10, headRef: 'feature/23-foo', htmlUrl: 'u/10' },
      { number: 12, headRef: 'feature/23-baz-something', htmlUrl: 'u/12' },
    ]);
  });

  it('headBranchPrefix を省略したら全件返す', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [
        { number: 1, html_url: 'u/1', head: { ref: 'feature/x' } },
        { number: 2, html_url: 'u/2', head: { ref: 'fix/y' } },
      ],
    });
    const rest = buildRestClient({ pulls: { list } });
    const client = createGitHubClient({ token: 't', restClient: rest });

    const prs = await client.listOpenPullRequests({ owner: 'o', repo: 'r' });
    expect(prs).toHaveLength(2);
  });

  it('REST 失敗時に GitHubApiError でラップする', async () => {
    const list = vi.fn().mockRejectedValue(
      new FakeOctokitRequestError({
        message: 'forbidden',
        status: 403,
        method: 'GET',
        url: '/repos/o/r/pulls',
        data: { message: 'rate limit' },
      }),
    );
    const rest = buildRestClient({ pulls: { list } });
    const client = createGitHubClient({ token: 't', restClient: rest });

    expect.assertions(2);
    try {
      await client.listOpenPullRequests({ owner: 'o', repo: 'r' });
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      expect((error as GitHubApiError).status).toBe(403);
    }
  });
});
