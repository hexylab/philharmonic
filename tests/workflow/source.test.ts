import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkflowSource,
  WorkflowFileNotFoundError,
  WorkflowRenderError,
  type RenderInput,
} from '../../src/workflow/index.js';

const ISSUE_BODY = [
  '## Goal',
  '',
  'WORKFLOW.md テンプレートを上位レイヤとして取り扱う',
  '',
  '## Constraints',
  '',
  '- リポジトリ直下を読む',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] テンプレート展開ができる',
].join('\n');

function baseInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    repository: { owner: 'hexylab', name: 'philharmonic' },
    baseBranch: 'main',
    issueNumber: 27,
    issueTitle: 'WORKFLOW.md を導入する',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/27',
    issueBody: ISSUE_BODY,
    workspacePath: '/tmp/.philharmonic/worktrees/issue-27',
    runId: '01900000-0000-7000-8000-000000000000',
    ...overrides,
  };
}

describe('createWorkflowSource', () => {
  let workdir: string;
  let workflowPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'philharmonic-workflow-'));
    workflowPath = path.join(workdir, 'WORKFLOW.md');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('テンプレートが Liquid 変数を展開し末尾に Orchestrator フッタが連結される', async () => {
    await writeFile(
      workflowPath,
      [
        '# {{ repository.owner }}/{{ repository.name }} #{{ issue.number }}',
        '',
        'Run: {{ run_id }}',
        '',
        '## Issue body (full)',
        '',
        '{{ issue.body }}',
      ].join('\n'),
      'utf8',
    );
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      const prompt = await source.render(baseInput());
      expect(prompt).toContain('# hexylab/philharmonic #27');
      expect(prompt).toContain('Run: 01900000-0000-7000-8000-000000000000');
      expect(prompt).toContain('WORKFLOW.md テンプレートを上位レイヤとして取り扱う');
      expect(prompt).toContain('## Orchestrator からの追加指示');
      expect(prompt).toContain('Project Status を `In Progress` に遷移');
      expect(prompt).toContain('`gh pr create`');
      expect(prompt).toContain('Project Status を `In Review` に遷移');
      expect(prompt).toContain('Project Status を `Failed` に遷移');
      expect(prompt).toContain('Conventional Commits');
      expect(prompt.endsWith('\n')).toBe(true);
    } finally {
      await source.close();
    }
  });

  it('hot-reload: ファイル変更後の dispatch から新しい prompt が生成される', async () => {
    await writeFile(workflowPath, '# v1 {{ issue.number }}\n', 'utf8');
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      const before = await source.render(baseInput());
      expect(before).toContain('# v1 27');

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(workflowPath, '# v2 {{ issue.title }}\n', 'utf8');

      const after = await source.render(baseInput());
      expect(after).toContain('# v2 WORKFLOW.md を導入する');
      expect(after).not.toContain('# v1');
    } finally {
      await source.close();
    }
  });

  it('WORKFLOW.md 不在 + fallbackOnMissing=true で buildPrompt フォールバックする', async () => {
    const source = await createWorkflowSource({
      workflowPath: path.join(workdir, 'no-such.md'),
      fallbackOnMissing: true,
    });
    try {
      const prompt = await source.render(baseInput());
      // buildPrompt の出力には Context / Issue 本文 / agent 委譲フッタが含まれる
      expect(prompt).toContain('# Context');
      expect(prompt).toContain('# Issue 本文');
      expect(prompt).toContain('## Orchestrator からの追加指示');
      expect(prompt).toContain('Conventional Commits');
    } finally {
      await source.close();
    }
  });

  it('明示指定 (fallbackOnMissing=false) でファイル不在時は WorkflowFileNotFoundError が throw される', async () => {
    await expect(
      createWorkflowSource({
        workflowPath: path.join(workdir, 'no-such.md'),
        fallbackOnMissing: false,
      }),
    ).rejects.toBeInstanceOf(WorkflowFileNotFoundError);
  });

  it('Liquid parse エラーは WorkflowRenderError で render から throw される', async () => {
    await writeFile(workflowPath, '{% if attempt %}unclosed', 'utf8');
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      await expect(source.render(baseInput())).rejects.toBeInstanceOf(WorkflowRenderError);
    } finally {
      await source.close();
    }
  });

  it('Issue body が空文字でもテンプレート評価は失敗しない (構造化セクション必須は撤廃)', async () => {
    await writeFile(workflowPath, '{{ issue.body }}\n', 'utf8');
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      const prompt = await source.render(baseInput({ issueBody: '' }));
      expect(prompt).toContain('## Orchestrator からの追加指示');
    } finally {
      await source.close();
    }
  });

  it('close() は idempotent で何度呼んでも安全', async () => {
    const source = await createWorkflowSource({
      workflowPath: path.join(workdir, 'no-such.md'),
      fallbackOnMissing: true,
    });
    await source.close();
    await expect(source.close()).resolves.toBeUndefined();
  });
});
