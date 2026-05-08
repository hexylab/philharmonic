import { z } from 'zod';

import { ProjectNotFoundError } from './extract.js';

const optionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const singleSelectFieldSchema = z.object({
  __typename: z.literal('ProjectV2SingleSelectField'),
  id: z.string(),
  name: z.string(),
  options: z.array(optionSchema),
});

const otherFieldSchema = z.object({
  __typename: z.string(),
});

const fieldNodeSchema = z.union([singleSelectFieldSchema, otherFieldSchema]);

const projectMetadataResponseSchema = z.object({
  repositoryOwner: z
    .object({
      __typename: z.string(),
      projectV2: z
        .object({
          id: z.string(),
          fields: z.object({
            nodes: z.array(fieldNodeSchema),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export type ProjectMetadataResponse = z.infer<typeof projectMetadataResponseSchema>;
export type ProjectStatusOption = z.infer<typeof optionSchema>;
export type ProjectStatusField = z.infer<typeof singleSelectFieldSchema>;

export type ProjectMetadata = {
  projectId: string;
  statusFieldId: string;
  statusOptions: ReadonlyArray<ProjectStatusOption>;
};

export class ProjectStatusFieldNotFoundError extends Error {
  public readonly code = 'project_status_field_not_found';

  constructor(
    public readonly statusFieldName: string,
    public readonly availableFields: readonly string[],
  ) {
    const list = availableFields.length === 0 ? '(なし)' : availableFields.join(', ');
    super(
      `Status field '${statusFieldName}' が Project に存在しません (Single select field: ${list})`,
    );
    this.name = 'ProjectStatusFieldNotFoundError';
  }
}

export type ExtractProjectMetadataInput = {
  response: ProjectMetadataResponse;
  owner: string;
  projectNumber: number;
  statusFieldName: string;
};

export function extractProjectMetadata(input: ExtractProjectMetadataInput): ProjectMetadata {
  const owner = input.response.repositoryOwner;
  if (owner === null) {
    throw new ProjectNotFoundError(input.owner, input.projectNumber, 'owner_not_found');
  }
  const project = owner.projectV2;
  if (project === null) {
    throw new ProjectNotFoundError(input.owner, input.projectNumber, 'project_not_found');
  }

  const singleSelectFields = project.fields.nodes.filter(
    (
      n,
    ): n is {
      __typename: 'ProjectV2SingleSelectField';
      id: string;
      name: string;
      options: ProjectStatusOption[];
    } => n.__typename === 'ProjectV2SingleSelectField' && 'name' in n,
  );

  const status = singleSelectFields.find((f) => f.name === input.statusFieldName);
  if (status === undefined) {
    throw new ProjectStatusFieldNotFoundError(
      input.statusFieldName,
      singleSelectFields.map((f) => f.name),
    );
  }

  return {
    projectId: project.id,
    statusFieldId: status.id,
    statusOptions: status.options,
  };
}

export const PROJECT_METADATA_QUERY = /* GraphQL */ `
  query ProjectMetadata($owner: String!, $number: Int!) {
    repositoryOwner(login: $owner) {
      __typename
      ... on User {
        ${projectMetadataFragment()}
      }
      ... on Organization {
        ${projectMetadataFragment()}
      }
    }
  }
`;

function projectMetadataFragment(): string {
  return /* GraphQL */ `
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  `;
}

export { projectMetadataResponseSchema };
