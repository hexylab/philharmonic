import { graphql } from '@octokit/graphql';

import { extractCandidates } from './extract.js';
import {
  extractProjectMetadata,
  PROJECT_METADATA_QUERY,
  projectMetadataResponseSchema,
  type ProjectMetadata,
} from './metadata.js';
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

export type FetchProjectMetadataInput = {
  owner: string;
  projectNumber: number;
  statusFieldName: string;
};

export type ProjectsClient = {
  fetchProjectCandidates(input: FetchProjectCandidatesInput): Promise<Candidate[]>;
  fetchProjectMetadata(input: FetchProjectMetadataInput): Promise<ProjectMetadata>;
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

      return extractCandidates({
        response,
        owner: input.owner,
        projectNumber: input.projectNumber,
        statusFieldName: input.statusFieldName,
      });
    },

    async fetchProjectMetadata(input) {
      const raw = await request<unknown>(PROJECT_METADATA_QUERY, {
        owner: input.owner,
        number: input.projectNumber,
      });
      const response = projectMetadataResponseSchema.parse(raw);
      return extractProjectMetadata({
        response,
        owner: input.owner,
        projectNumber: input.projectNumber,
        statusFieldName: input.statusFieldName,
      });
    },
  };
}
