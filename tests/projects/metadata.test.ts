import { describe, expect, it } from 'vitest';

import {
  extractProjectMetadata,
  ProjectStatusFieldNotFoundError,
  projectMetadataResponseSchema,
} from '../../src/projects/metadata.js';
import { ProjectNotFoundError } from '../../src/projects/index.js';

const SAMPLE = {
  repositoryOwner: {
    __typename: 'User',
    projectV2: {
      id: 'PVT_1',
      fields: {
        nodes: [
          { __typename: 'ProjectV2Field', name: 'Title' },
          {
            __typename: 'ProjectV2SingleSelectField',
            id: 'PVTSSF_status',
            name: 'Status',
            options: [
              { id: 'opt_todo', name: 'Todo' },
              { id: 'opt_ip', name: 'In Progress' },
              { id: 'opt_ir', name: 'In Review' },
              { id: 'opt_fail', name: 'Failed' },
            ],
          },
        ],
      },
    },
  },
};

describe('extractProjectMetadata', () => {
  it('Status field の ID と option を返す', () => {
    const response = projectMetadataResponseSchema.parse(SAMPLE);
    const md = extractProjectMetadata({
      response,
      owner: 'hexylab',
      projectNumber: 1,
      statusFieldName: 'Status',
    });
    expect(md.projectId).toBe('PVT_1');
    expect(md.statusFieldId).toBe('PVTSSF_status');
    expect(md.statusOptions).toHaveLength(4);
    expect(md.statusOptions[1]).toEqual({ id: 'opt_ip', name: 'In Progress' });
  });

  it('Status field 名が一致しないと ProjectStatusFieldNotFoundError を throw', () => {
    const response = projectMetadataResponseSchema.parse(SAMPLE);
    expect(() =>
      extractProjectMetadata({
        response,
        owner: 'hexylab',
        projectNumber: 1,
        statusFieldName: 'NonExistent',
      }),
    ).toThrow(ProjectStatusFieldNotFoundError);
  });

  it('repositoryOwner が null のときは ProjectNotFoundError', () => {
    const response = projectMetadataResponseSchema.parse({ repositoryOwner: null });
    expect(() =>
      extractProjectMetadata({
        response,
        owner: 'unknown',
        projectNumber: 1,
        statusFieldName: 'Status',
      }),
    ).toThrow(ProjectNotFoundError);
  });
});
