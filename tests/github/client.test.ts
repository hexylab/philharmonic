import { describe, expect, it, vi } from 'vitest';

import {
  GitHubApiError,
  UPDATE_PROJECT_V2_ITEM_STATUS_MUTATION,
  createGitHubClient,
  type RestClient,
} from '../../src/github/index.js';

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
      createComment: vi.fn(),
      ...overrides.issues,
    },
    pulls: {
      create: vi.fn(),
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
            title: 'Hello',
            body: 'world',
            state: 'open',
            html_url: 'https://github.com/o/r/issues/42',
            labels: [{ name: 'task' }, 'agent:skip'],
            assignees: [{ login: 'philharmonic-bot' }],
          },
        }),
        createComment: vi.fn(),
      },
    });

    const client = createGitHubClient({ token: 't', restClient: rest });

    const issue = await client.getIssue({ owner: 'o', repo: 'r', issueNumber: 42 });

    expect(issue).toEqual({
      number: 42,
      title: 'Hello',
      body: 'world',
      state: 'open',
      htmlUrl: 'https://github.com/o/r/issues/42',
      labels: [{ name: 'task' }, { name: 'agent:skip' }],
      assignees: [{ login: 'philharmonic-bot' }],
    });
    expect(rest.issues.get).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
    });
  });

  it('labels / assignees が省略されたら空配列で返す', async () => {
    const rest = buildRestClient({
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 1,
            title: 't',
            body: null,
            state: 'open',
            html_url: 'u',
          },
        }),
        createComment: vi.fn(),
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
        createComment: vi.fn(),
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
            data: { message: 'Not Found', documentation_url: 'https://docs.github.com' },
          }),
        ),
        createComment: vi.fn(),
      },
    });
    const client = createGitHubClient({ token: 't', restClient: rest });

    expect.assertions(5);
    try {
      await client.getIssue({ owner: 'o', repo: 'r', issueNumber: 9 });
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      const apiError = error as GitHubApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.method).toBe('GET');
      expect(apiError.url).toBe('/repos/o/r/issues/9');
      expect(apiError.message).toContain('404');
    }
  });
});

describe('createGitHubClient.commentIssue', () => {
  it('REST issues.createComment を呼んで IssueComment を返す', async () => {
    const createComment = vi.fn().mockResolvedValue({
      data: { id: 100, html_url: 'https://github.com/o/r/issues/1#issuecomment-100' },
    });
    const rest = buildRestClient({
      issues: { get: vi.fn(), createComment },
    });

    const client = createGitHubClient({ token: 't', restClient: rest });
    const result = await client.commentIssue({
      owner: 'o',
      repo: 'r',
      issueNumber: 1,
      body: 'hi',
    });

    expect(result).toEqual({
      id: 100,
      htmlUrl: 'https://github.com/o/r/issues/1#issuecomment-100',
    });
    expect(createComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 1,
      body: 'hi',
    });
  });

  it('REST が予期せぬ例外を投げたときも GitHubApiError でラップする', async () => {
    const rest = buildRestClient({
      issues: {
        get: vi.fn(),
        createComment: vi.fn().mockRejectedValue(new Error('socket hang up')),
      },
    });
    const client = createGitHubClient({ token: 't', restClient: rest });

    await expect(
      client.commentIssue({ owner: 'o', repo: 'r', issueNumber: 1, body: 'b' }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe('createGitHubClient.createPullRequest', () => {
  it('REST pulls.create を呼んで PullRequest を返す', async () => {
    const create = vi.fn().mockResolvedValue({
      data: { number: 7, html_url: 'https://github.com/o/r/pull/7', draft: false },
    });
    const rest = buildRestClient({
      pulls: { create },
    });

    const client = createGitHubClient({ token: 't', restClient: rest });
    const pr = await client.createPullRequest({
      owner: 'o',
      repo: 'r',
      base: 'main',
      head: 'feature/x',
      title: 'Add x',
      body: 'closes #1',
    });

    expect(pr).toEqual({
      number: 7,
      htmlUrl: 'https://github.com/o/r/pull/7',
      draft: false,
    });
    expect(create).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      base: 'main',
      head: 'feature/x',
      title: 'Add x',
      body: 'closes #1',
      draft: undefined,
    });
  });

  it('draft が省略された場合 draft=false で返す', async () => {
    const rest = buildRestClient({
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: { number: 8, html_url: 'u' },
        }),
      },
    });
    const client = createGitHubClient({ token: 't', restClient: rest });
    const pr = await client.createPullRequest({
      owner: 'o',
      repo: 'r',
      base: 'main',
      head: 'feature/x',
      title: 't',
    });
    expect(pr.draft).toBe(false);
  });

  it('REST 失敗時に status / responseBody / method / url を保持した GitHubApiError を投げる', async () => {
    const rest = buildRestClient({
      pulls: {
        create: vi.fn().mockRejectedValue(
          new FakeOctokitRequestError({
            message: 'Validation Failed',
            status: 422,
            method: 'POST',
            url: '/repos/o/r/pulls',
            data: { message: 'No commits between main and feature/x' },
          }),
        ),
      },
    });
    const client = createGitHubClient({ token: 't', restClient: rest });

    expect.assertions(4);
    try {
      await client.createPullRequest({
        owner: 'o',
        repo: 'r',
        base: 'main',
        head: 'feature/x',
        title: 't',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      const apiError = error as GitHubApiError;
      expect(apiError.status).toBe(422);
      expect(apiError.responseBody).toMatchObject({
        message: 'No commits between main and feature/x',
      });
      expect(apiError.message).toContain('No commits between main and feature/x');
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
      pulls: { create: vi.fn(), list },
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
    const rest = buildRestClient({ pulls: { create: vi.fn(), list } });
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
    const rest = buildRestClient({ pulls: { create: vi.fn(), list } });
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

describe('createGitHubClient.updateProjectV2ItemStatus', () => {
  it('mutation を 4 つの ID と共に呼び出し itemId を返す', async () => {
    const graphqlRequest = vi.fn().mockResolvedValue({
      updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_x' } },
    });

    const client = createGitHubClient({
      token: 't',
      restClient: buildRestClient(),
      graphqlRequest,
    });

    const result = await client.updateProjectV2ItemStatus({
      projectId: 'PVT_1',
      itemId: 'PVTI_x',
      fieldId: 'PVTSSF_1',
      optionId: 'opt_in_progress',
    });

    expect(result).toEqual({ itemId: 'PVTI_x' });
    expect(graphqlRequest).toHaveBeenCalledWith(UPDATE_PROJECT_V2_ITEM_STATUS_MUTATION, {
      projectId: 'PVT_1',
      itemId: 'PVTI_x',
      fieldId: 'PVTSSF_1',
      optionId: 'opt_in_progress',
    });
  });

  it('GraphQL request が throw したら GitHubApiError でラップする', async () => {
    const graphqlError = Object.assign(new Error('Bad credentials'), {
      errors: [{ message: 'Bad credentials' }],
    });
    const graphqlRequest = vi.fn().mockRejectedValue(graphqlError);

    const client = createGitHubClient({
      token: 't',
      restClient: buildRestClient(),
      graphqlRequest,
    });

    expect.assertions(3);
    try {
      await client.updateProjectV2ItemStatus({
        projectId: 'PVT_1',
        itemId: 'PVTI_x',
        fieldId: 'PVTSSF_1',
        optionId: 'opt_in_progress',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      const apiError = error as GitHubApiError;
      expect(apiError.message).toContain('Bad credentials');
      expect(apiError.responseBody).toMatchObject({
        errors: [{ message: 'Bad credentials' }],
      });
    }
  });

  it('レスポンスから itemId が取れない場合 GitHubApiError を投げる', async () => {
    const graphqlRequest = vi.fn().mockResolvedValue({
      updateProjectV2ItemFieldValue: { projectV2Item: null },
    });

    const client = createGitHubClient({
      token: 't',
      restClient: buildRestClient(),
      graphqlRequest,
    });

    await expect(
      client.updateProjectV2ItemStatus({
        projectId: 'PVT_1',
        itemId: 'PVTI_x',
        fieldId: 'PVTSSF_1',
        optionId: 'opt_in_progress',
      }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
