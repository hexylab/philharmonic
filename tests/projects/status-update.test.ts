import { describe, expect, it, vi } from 'vitest';

import {
  GhCommandError,
  StatusOptionNotFoundError,
  updateProjectItemStatus,
  type GhRunner,
} from '../../src/projects/index.js';

const FIELD_LIST_OK = JSON.stringify({
  fields: [
    {
      id: 'PVTF_text_title',
      name: 'Title',
      type: 'ProjectV2Field',
    },
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt-todo', name: 'Todo' },
        { id: 'opt-in-progress', name: 'In Progress' },
        { id: 'opt-failed', name: 'Failed' },
      ],
    },
    {
      id: 'PVTSSF_priority',
      name: 'Priority',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt-p1', name: 'P1' },
        { id: 'opt-p2', name: 'P2' },
      ],
    },
  ],
});

function createRunGh(responses: Record<string, { stdout?: string; stderr?: string }>): {
  runGh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGh: GhRunner = vi.fn(async (args) => {
    calls.push([...args]);
    const key = args.slice(0, 2).join(' ');
    const reply = responses[key] ?? {};
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  });
  return { runGh, calls };
}

const BASE_INPUT = {
  owner: 'hexylab',
  projectNumber: 1,
  projectId: 'PVT_proj',
  itemId: 'PVTI_item',
  statusFieldName: 'Status',
  targetStatus: 'Todo',
};

describe('updateProjectItemStatus', () => {
  it('field-list で取得した option ID を `gh project item-edit` に渡す', async () => {
    const { runGh, calls } = createRunGh({
      'project field-list': { stdout: FIELD_LIST_OK },
      'project item-edit': { stdout: '' },
    });

    await updateProjectItemStatus(runGh, BASE_INPUT);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      'project',
      'field-list',
      '1',
      '--owner',
      'hexylab',
      '--format',
      'json',
      '--limit',
      '100',
    ]);
    expect(calls[1]).toEqual([
      'project',
      'item-edit',
      '--id',
      'PVTI_item',
      '--project-id',
      'PVT_proj',
      '--field-id',
      'PVTSSF_status',
      '--single-select-option-id',
      'opt-todo',
    ]);
  });

  it('指定した statusFieldName と type ProjectV2SingleSelectField の field のみを採用する', async () => {
    const { runGh, calls } = createRunGh({
      'project field-list': { stdout: FIELD_LIST_OK },
      'project item-edit': { stdout: '' },
    });

    await updateProjectItemStatus(runGh, {
      ...BASE_INPUT,
      statusFieldName: 'Priority',
      targetStatus: 'P2',
    });

    expect(calls[1]?.slice(6, 10)).toEqual([
      '--field-id',
      'PVTSSF_priority',
      '--single-select-option-id',
      'opt-p2',
    ]);
  });

  it('target status が field の options に存在しないとき StatusOptionNotFoundError を throw する', async () => {
    const { runGh } = createRunGh({
      'project field-list': { stdout: FIELD_LIST_OK },
    });

    await expect(
      updateProjectItemStatus(runGh, { ...BASE_INPUT, targetStatus: 'Backlog' }),
    ).rejects.toBeInstanceOf(StatusOptionNotFoundError);
  });

  it('status field 自体が見つからないときも StatusOptionNotFoundError を throw する', async () => {
    const { runGh } = createRunGh({
      'project field-list': { stdout: JSON.stringify({ fields: [] }) },
    });

    await expect(updateProjectItemStatus(runGh, BASE_INPUT)).rejects.toBeInstanceOf(
      StatusOptionNotFoundError,
    );
  });

  it('field-list の JSON が壊れていれば parse エラーを throw する', async () => {
    const { runGh } = createRunGh({
      'project field-list': { stdout: '<<not json>>' },
    });

    await expect(updateProjectItemStatus(runGh, BASE_INPUT)).rejects.toThrowError(
      /failed to parse `gh project field-list` JSON output/,
    );
  });

  it('field-list レスポンスに fields[] が無いと shape エラーを throw する', async () => {
    const { runGh } = createRunGh({
      'project field-list': { stdout: JSON.stringify({ totalCount: 0 }) },
    });

    await expect(updateProjectItemStatus(runGh, BASE_INPUT)).rejects.toThrowError(
      /missing `fields\[\]`/,
    );
  });

  it('gh subprocess が GhCommandError を throw した場合はそのまま伝播する', async () => {
    const ghError = new GhCommandError(['project', 'item-edit'], 1, 'auth required');
    const runGh: GhRunner = vi.fn(async (args) => {
      if (args[1] === 'field-list') return { stdout: FIELD_LIST_OK, stderr: '' };
      throw ghError;
    });

    await expect(updateProjectItemStatus(runGh, BASE_INPUT)).rejects.toBe(ghError);
  });
});
