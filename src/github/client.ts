import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';

import { GitHubApiError } from './errors.js';
import { UPDATE_PROJECT_V2_ITEM_STATUS_MUTATION } from './query.js';

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

export type IssueComment = {
  id: number;
  htmlUrl: string;
};

export type PullRequest = {
  number: number;
  htmlUrl: string;
  draft: boolean;
};

export type UpdateProjectV2ItemStatusResult = {
  itemId: string;
};

export type GetIssueInput = {
  owner: string;
  repo: string;
  issueNumber: number;
};

export type CommentIssueInput = {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
};

export type CreatePullRequestInput = {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
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

export type UpdateProjectV2ItemStatusInput = {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
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
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number; html_url: string } }>;
  };
  pulls: {
    create(params: {
      owner: string;
      repo: string;
      head: string;
      base: string;
      title: string;
      body?: string;
      draft?: boolean;
    }): Promise<{ data: { number: number; html_url: string; draft?: boolean } }>;
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

export type GitHubClient = {
  getIssue(input: GetIssueInput): Promise<Issue>;
  commentIssue(input: CommentIssueInput): Promise<IssueComment>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listOpenPullRequests(input: ListOpenPullRequestsInput): Promise<OpenPullRequest[]>;
  updateProjectV2ItemStatus(
    input: UpdateProjectV2ItemStatusInput,
  ): Promise<UpdateProjectV2ItemStatusResult>;
};

type UpdateProjectV2ItemFieldValueResponse = {
  updateProjectV2ItemFieldValue?: {
    projectV2Item?: { id?: string | null } | null;
  } | null;
};

export function createGitHubClient(options: CreateGitHubClientOptions): GitHubClient {
  const restClient: RestClient = options.restClient ?? buildDefaultRestClient(options.token);
  const graphqlRequest: GraphqlRequest =
    options.graphqlRequest ?? buildDefaultGraphqlRequest(options.token);

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

    async commentIssue(input) {
      const response = await callRest(
        () =>
          restClient.issues.createComment({
            owner: input.owner,
            repo: input.repo,
            issue_number: input.issueNumber,
            body: input.body,
          }),
        'POST',
        `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
      );
      const { data } = response;
      return { id: data.id, htmlUrl: data.html_url };
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

    async createPullRequest(input) {
      const response = await callRest(
        () =>
          restClient.pulls.create({
            owner: input.owner,
            repo: input.repo,
            base: input.base,
            head: input.head,
            title: input.title,
            body: input.body,
            draft: input.draft,
          }),
        'POST',
        `/repos/${input.owner}/${input.repo}/pulls`,
      );
      const { data } = response;
      return {
        number: data.number,
        htmlUrl: data.html_url,
        draft: data.draft ?? false,
      };
    },

    async updateProjectV2ItemStatus(input) {
      let response: UpdateProjectV2ItemFieldValueResponse;
      try {
        response = await graphqlRequest<UpdateProjectV2ItemFieldValueResponse>(
          UPDATE_PROJECT_V2_ITEM_STATUS_MUTATION,
          {
            projectId: input.projectId,
            itemId: input.itemId,
            fieldId: input.fieldId,
            optionId: input.optionId,
          },
        );
      } catch (error) {
        throw toGraphqlApiError(error, 'UpdateProjectV2ItemStatus');
      }
      const itemId = response.updateProjectV2ItemFieldValue?.projectV2Item?.id;
      if (typeof itemId !== 'string' || itemId.length === 0) {
        throw new GitHubApiError(
          `GraphQL mutation 'UpdateProjectV2ItemStatus' のレスポンスから projectV2Item.id を取得できませんでした`,
          {
            status: null,
            responseBody: response,
            method: null,
            url: null,
          },
        );
      }
      return { itemId };
    },
  };
}

function buildDefaultRestClient(token: string): RestClient {
  const octokit = new Octokit({ auth: token });
  return octokit.rest as unknown as RestClient;
}

function buildDefaultGraphqlRequest(token: string): GraphqlRequest {
  return ((query, variables) =>
    graphql(query, {
      ...variables,
      headers: { authorization: `token ${token}` },
    })) as GraphqlRequest;
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

function toGraphqlApiError(error: unknown, operation: string): Error {
  const status = isOctokitRequestError(error) ? error.status : null;
  const responseBody = isGraphqlErrorResponse(error)
    ? { errors: error.errors }
    : isOctokitRequestError(error)
      ? error.response?.data
      : null;
  const reason =
    pickGraphqlReason(error) ?? (error instanceof Error ? error.message : String(error));
  return new GitHubApiError(`GraphQL mutation '${operation}' failed: ${reason}`, {
    status,
    responseBody,
    method: null,
    url: null,
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

type GraphqlErrorResponseShape = {
  errors: ReadonlyArray<{ message?: string }>;
};

function isGraphqlErrorResponse(error: unknown): error is GraphqlErrorResponseShape {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { errors?: unknown };
  return Array.isArray(candidate.errors);
}

function pickRestReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { message?: unknown };
  return typeof candidate.message === 'string' ? candidate.message : null;
}

function pickGraphqlReason(error: unknown): string | null {
  if (isGraphqlErrorResponse(error) && error.errors.length > 0) {
    const first = error.errors[0];
    if (first !== undefined && typeof first.message === 'string') return first.message;
  }
  return null;
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
