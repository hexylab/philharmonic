import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { projectItemsResponseSchema } from '../../src/projects/schema.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/projects/items-response.json', import.meta.url),
);

describe('projectItemsResponseSchema', () => {
  it('正常な GraphQL レスポンスをパースできる', () => {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;

    const parsed = projectItemsResponseSchema.parse(raw);

    expect(parsed.repositoryOwner?.projectV2?.items.nodes).toHaveLength(6);
  });

  it('repositoryOwner が null でも受け入れる', () => {
    expect(() => projectItemsResponseSchema.parse({ repositoryOwner: null })).not.toThrow();
  });

  it('item.content の __typename が未知でもエラーにならない (フォールバック shape を許容)', () => {
    const raw = {
      repositoryOwner: {
        __typename: 'Organization',
        projectV2: {
          id: 'PVT_x',
          title: 't',
          items: {
            nodes: [
              {
                id: 'PVTI_x',
                content: { __typename: 'FutureContentType' },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    expect(() => projectItemsResponseSchema.parse(raw)).not.toThrow();
  });

  it('id 等の必須フィールドが欠けている場合はエラーになる', () => {
    const raw = {
      repositoryOwner: {
        __typename: 'User',
        projectV2: {
          id: 'PVT_x',
          title: 't',
          items: {
            nodes: [
              {
                content: { __typename: 'Issue' },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    expect(() => projectItemsResponseSchema.parse(raw)).toThrow();
  });
});
