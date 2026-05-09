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
    attempt: 1,
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
        'Attempt: {{ attempt }}',
        'Run: {{ run_id }}',
        '',
        '## Goal (from issue)',
        '',
        '{{ issue.goal }}',
      ].join('\n'),
      'utf8',
    );
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      const prompt = await source.render(baseInput());
      expect(prompt).toContain('# hexylab/philharmonic #27');
      expect(prompt).toContain('Attempt: 1');
      expect(prompt).toContain('Run: 01900000-0000-7000-8000-000000000000');
      expect(prompt).toContain('WORKFLOW.md テンプレートを上位レイヤとして取り扱う');
      expect(prompt.trimEnd().endsWith('形式で commit すること')).toBe(true);
      expect(prompt).toContain('## Orchestrator からの追加制約');
      expect(prompt).toContain('`git push` を実行しないこと');
      expect(prompt).toContain('Pull Request を作成しないこと');
      expect(prompt).toContain('GitHub token を期待しないこと');
      expect(prompt.endsWith('\n')).toBe(true);
    } finally {
      await source.close();
    }
  });

  it('attempt > 1 の if 分岐が描画される', async () => {
    await writeFile(
      workflowPath,
      [
        'attempt={{ attempt }}',
        '{% if attempt > 1 %}retry-notice{% else %}first-try{% endif %}',
      ].join('\n'),
      'utf8',
    );
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      const first = await source.render(baseInput({ attempt: 1 }));
      const second = await source.render(baseInput({ attempt: 2 }));
      expect(first).toContain('first-try');
      expect(first).not.toContain('retry-notice');
      expect(second).toContain('retry-notice');
      expect(second).not.toContain('first-try');
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

      // mtime が確実に変わるよう短く待機
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
      // buildPrompt の出力には Definition of Done セクションが含まれる
      expect(prompt).toContain('# Context');
      expect(prompt).toContain('# Definition of Done (Runner 向け)');
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

  it('Issue body の必須セクション欠損時はテンプレート評価前に MissingPromptSectionError が伝播する', async () => {
    await writeFile(workflowPath, '{{ issue.goal }}\n', 'utf8');
    const source = await createWorkflowSource({ workflowPath, fallbackOnMissing: true });
    try {
      const broken = baseInput({
        issueBody: '## Goal\n\n## Acceptance Criteria\n\n- [ ] x\n',
      });
      await expect(source.render(broken)).rejects.toThrow(/missing/);
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
