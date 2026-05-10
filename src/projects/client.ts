import { graphql } from '@octokit/graphql';

import { extractProjectContext, type ExtractedProjectContext } from './extract.js';
import { PROJECT_ITEMS_QUERY } from './query.js';
import { projectItemsResponseSchema, type Candidate } from './schema.js';

export type GraphqlRequest = <T = unknown>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

export type CreateProjectsClientOptions = {
  token: string;
  request?: GraphqlRequest;
};

export type FetchProjectCandidatesInput = {
  owner: string;
  projectNumber: number;
  statusFieldName?: string;
  first?: number;
};

export type ProjectContext = ExtractedProjectContext;

export type ProjectsClient = {
  fetchProjectCandidates(input: FetchProjectCandidatesInput): Promise<Candidate[]>;
  /**
   * project ID 込みで candidates を返す read-only API。`philharmonic retry` (#88) など
   * `gh project item-edit --project-id <id>` で project ID を必要とする経路で使う。
   */
  fetchProjectContext(input: FetchProjectCandidatesInput): Promise<ProjectContext>;
};

const DEFAULT_FIRST = 100;
const MAX_FIRST = 100;
const MIN_FIRST = 1;

export class InvalidFirstError extends Error {
  constructor(public readonly value: number) {
    super(
      `--first は ${MIN_FIRST}〜${MAX_FIRST} の範囲で指定してください (受け取った値: ${value})`,
    );
    this.name = 'InvalidFirstError';
  }
}

export function createProjectsClient(options: CreateProjectsClientOptions): ProjectsClient {
  const request: GraphqlRequest =
    options.request ??
    (((query, variables) =>
      graphql(query, {
        ...variables,
        headers: { authorization: `token ${options.token}` },
      })) as GraphqlRequest);

  return {
    async fetchProjectCandidates(input) {
      const context = await fetchContext(input);
      return context.candidates;
    },
    async fetchProjectContext(input) {
      return fetchContext(input);
    },
  };

  async function fetchContext(input: FetchProjectCandidatesInput): Promise<ProjectContext> {
    const first = input.first ?? DEFAULT_FIRST;
    if (!Number.isInteger(first) || first < MIN_FIRST || first > MAX_FIRST) {
      throw new InvalidFirstError(first);
    }

    const raw = await request<unknown>(PROJECT_ITEMS_QUERY, {
      owner: input.owner,
      number: input.projectNumber,
      first,
    });

    const response = projectItemsResponseSchema.parse(raw);

    return extractProjectContext({
      response,
      owner: input.owner,
      projectNumber: input.projectNumber,
      statusFieldName: input.statusFieldName,
    });
  }
}
