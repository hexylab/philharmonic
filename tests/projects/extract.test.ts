import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractCandidates, ProjectNotFoundError } from '../../src/projects/extract.js';
import {
  projectItemsResponseSchema,
  type ProjectItemsResponse,
} from '../../src/projects/schema.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/projects/items-response.json', import.meta.url),
);

function loadFixture(): ProjectItemsResponse {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  return projectItemsResponseSchema.parse(raw);
}

describe('extractCandidates', () => {
  it('Issue に紐づいた Item のみを Candidate として返す', () => {
    const response = loadFixture();

    const candidates = extractCandidates({
      response,
      owner: 'hexylab',
      projectNumber: 1,
    });

    expect(candidates).toHaveLength(3);
    const ids = candidates.map((c) => c.itemId);
    expect(ids).toEqual([
      'PVTI_lADOA_issue_todo',
      'PVTI_lADOA_issue_in_progress',
      'PVTI_lADOA_issue_no_status',
    ]);
  });

  it('DraftIssue / PullRequest / content が null の Item を除外する', () => {
    const response = loadFixture();

    const candidates = extractCandidates({
      response,
      owner: 'hexylab',
      projectNumber: 1,
    });
    const ids = candidates.map((c) => c.itemId);

    expect(ids).not.toContain('PVTI_lADOA_draft');
    expect(ids).not.toContain('PVTI_lADOA_pull_request');
    expect(ids).not.toContain('PVTI_lADOA_orphan');
  });

  it('Status field 名が一致した SingleSelectValue を current status として採用する', () => {
    const response = loadFixture();

    const candidates = extractCandidates({
      response,
      owner: 'hexylab',
      projectNumber: 1,
    });

    expect(candidates[0]).toMatchObject({
      itemId: 'PVTI_lADOA_issue_todo',
      issueNumber: 4,
      issueTitle: 'GitHub Projects v2 client の調査用 spike を実装する',
      repositoryNameWithOwner: 'hexylab/philharmonic',
      status: 'Todo',
    });
    expect(candidates[1]?.status).toBe('In Progress');
  });

  it('Status field 名が一致しない / 該当 field が無い場合は status=null を返す', () => {
    const response = loadFixture();

    const candidates = extractCandidates({
      response,
      owner: 'hexylab',
      projectNumber: 1,
    });

    const noStatus = candidates.find((c) => c.itemId === 'PVTI_lADOA_issue_no_status');
    expect(noStatus?.status).toBeNull();
  });

  it('statusFieldName を変えると別の field の値を current status として採用できる', () => {
    const response = loadFixture();

    const candidates = extractCandidates({
      response,
      owner: 'hexylab',
      projectNumber: 1,
      statusFieldName: 'Priority',
    });

    expect(candidates[0]?.status).toBe('P1');
    expect(candidates[1]?.status).toBeNull();
  });

  it('repositoryOwner が null のとき ProjectNotFoundError を throw する', () => {
    const response: ProjectItemsResponse = { repositoryOwner: null };

    expect(() => extractCandidates({ response, owner: 'unknown', projectNumber: 1 })).toThrowError(
      ProjectNotFoundError,
    );
  });

  it('projectV2 が null のとき ProjectNotFoundError (project_not_found) を throw する', () => {
    const response: ProjectItemsResponse = {
      repositoryOwner: { __typename: 'User', projectV2: null },
    };

    expect.assertions(2);
    try {
      extractCandidates({ response, owner: 'hexylab', projectNumber: 999 });
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectNotFoundError);
      expect((error as ProjectNotFoundError).reason).toBe('project_not_found');
    }
  });
});
