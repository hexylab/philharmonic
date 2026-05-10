import { Octokit } from '@octokit/rest';

import { GitHubApiError } from './errors.js';

export type IssueState = 'open' | 'closed';

export type IssueLabel = { name: string };
export type IssueAssignee = { login: string };

export type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: IssueState;
  htmlUrl: string;
  labels: IssueLabel[];
  assignees: IssueAssignee[];
};

export type GetIssueInput = {
  owner: string;
  repo: string;
  issueNumber: number;
};

export type ListOpenPullRequestsInput = {
  owner: string;
  repo: string;
  /** `head.ref` が `headBranchPrefix` で始まる open PR だけを返すフィルタ。空文字なら全件。 */
  headBranchPrefix?: string;
  /** 1 ページあたりの件数。デフォルト 100 (= GitHub REST 最大値)。 */
  perPage?: number;
};

export type OpenPullRequest = {
  number: number;
  headRef: string;
  htmlUrl: string;
};

export type RestClient = {
  issues: {
    get(params: { owner: string; repo: string; issue_number: number }): Promise<{
      data: {
        number: number;
        title: string;
        body: string | null | undefined;
        state: string;
        html_url: string;
        labels?: ReadonlyArray<string | { name?: string | null | undefined }> | null | undefined;
        assignees?: ReadonlyArray<{ login?: string | null | undefined }> | null | undefined;
      };
    }>;
  };
  pulls: {
    list(params: {
      owner: string;
      repo: string;
      state?: 'open' | 'closed' | 'all';
      per_page?: number;
    }): Promise<{
      data: ReadonlyArray<{
        number: number;
        html_url: string;
        head: { ref: string };
      }>;
    }>;
  };
};

export type GraphqlRequest = <T = unknown>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

export type CreateGitHubClientOptions = {
  token: string;
  restClient?: RestClient;
  graphqlRequest?: GraphqlRequest;
};

/**
 * Orchestrator が直接 GitHub と通信する API は ADR-0005 で **読み取り系のみ** に縮小した。
 *
 * - `getIssue` — candidate selection で Issue body / state / labels / assignees を取る
 * - `listOpenPullRequests` — recovery で「対応 PR が既にあるか」を判定する
 *
 * 書き込み系 (PR 作成 / Issue コメント / Status 更新) は agent (Claude Code + `gh` CLI) が
 * Runner subprocess の中で行う。allowlist を通った `GITHUB_TOKEN` / `GH_TOKEN` を agent が利用する。
 */
export type GitHubClient = {
  getIssue(input: GetIssueInput): Promise<Issue>;
  listOpenPullRequests(input: ListOpenPullRequestsInput): Promise<OpenPullRequest[]>;
};

export function createGitHubClient(options: CreateGitHubClientOptions): GitHubClient {
  const restClient: RestClient = options.restClient ?? buildDefaultRestClient(options.token);

  return {
    async getIssue(input) {
      const response = await callRest(
        () =>
          restClient.issues.get({
            owner: input.owner,
            repo: input.repo,
            issue_number: input.issueNumber,
          }),
        'GET',
        `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
      );
      const { data } = response;
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        state: data.state === 'closed' ? 'closed' : 'open',
        htmlUrl: data.html_url,
        labels: normalizeLabels(data.labels),
        assignees: normalizeAssignees(data.assignees),
      };
    },

    async listOpenPullRequests(input) {
      const perPage = input.perPage ?? 100;
      const response = await callRest(
        () =>
          restClient.pulls.list({
            owner: input.owner,
            repo: input.repo,
            state: 'open',
            per_page: perPage,
          }),
        'GET',
        `/repos/${input.owner}/${input.repo}/pulls`,
      );
      const prefix = input.headBranchPrefix ?? '';
      const out: OpenPullRequest[] = [];
      for (const item of response.data) {
        const headRef = item.head.ref;
        if (prefix.length > 0 && !headRef.startsWith(prefix)) continue;
        out.push({ number: item.number, headRef, htmlUrl: item.html_url });
      }
      return out;
    },
  };
}

function buildDefaultRestClient(token: string): RestClient {
  const octokit = new Octokit({ auth: token });
  return octokit.rest as unknown as RestClient;
}

async function callRest<T>(call: () => Promise<T>, method: string, path: string): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toRestApiError(error, method, path);
  }
}

function toRestApiError(error: unknown, fallbackMethod: string, fallbackPath: string): Error {
  if (isOctokitRequestError(error)) {
    const status = error.status;
    const requestMethod = error.request?.method ?? fallbackMethod;
    const requestUrl = error.request?.url ?? fallbackPath;
    const responseBody = error.response?.data;
    const reason = pickRestReason(responseBody) ?? error.message;
    return new GitHubApiError(`${requestMethod} ${requestUrl} failed with ${status}: ${reason}`, {
      status,
      responseBody,
      method: requestMethod,
      url: requestUrl,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitHubApiError(`${fallbackMethod} ${fallbackPath} failed: ${message}`, {
    status: null,
    responseBody: null,
    method: fallbackMethod,
    url: fallbackPath,
    cause: error,
  });
}

type OctokitRequestErrorShape = {
  status: number;
  request?: { method?: string; url?: string };
  response?: { data?: unknown };
  message: string;
};

function isOctokitRequestError(error: unknown): error is OctokitRequestErrorShape {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<OctokitRequestErrorShape>;
  return typeof candidate.status === 'number' && typeof candidate.message === 'string';
}

function pickRestReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { message?: unknown };
  return typeof candidate.message === 'string' ? candidate.message : null;
}

function normalizeLabels(
  labels: ReadonlyArray<string | { name?: string | null | undefined }> | null | undefined,
): IssueLabel[] {
  if (labels === null || labels === undefined) return [];
  const out: IssueLabel[] = [];
  for (const label of labels) {
    if (typeof label === 'string') {
      if (label.length > 0) out.push({ name: label });
      continue;
    }
    const name = label.name;
    if (typeof name === 'string' && name.length > 0) out.push({ name });
  }
  return out;
}

function normalizeAssignees(
  assignees: ReadonlyArray<{ login?: string | null | undefined }> | null | undefined,
): IssueAssignee[] {
  if (assignees === null || assignees === undefined) return [];
  const out: IssueAssignee[] = [];
  for (const a of assignees) {
    const login = a.login;
    if (typeof login === 'string' && login.length > 0) out.push({ login });
  }
  return out;
}
