import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPrompt, type BuildPromptInput } from '../../src/prompt/build.js';
import { MissingPromptSectionError } from '../../src/prompt/errors.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/prompt/${name}`, import.meta.url)),
    'utf8',
  );
}

function baseInput(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
  return {
    repository: { owner: 'hexylab', name: 'philharmonic' },
    baseBranch: 'main',
    issueNumber: 17,
    issueTitle: 'Issue body から prompt を組み立てる Prompt Construction を実装する',
    issueUrl: 'https://github.com/hexylab/philharmonic/issues/17',
    issueBody: fixture('issue-body-valid.md'),
    workspacePath: '/home/runner/.philharmonic/worktrees/issue-17',
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('Context / Goal / Constraints / Acceptance Criteria / DoD の順で連結される', () => {
    const prompt = buildPrompt(baseInput());

    const contextIdx = prompt.indexOf('# Context');
    const goalIdx = prompt.indexOf('# Goal');
    const constraintsIdx = prompt.indexOf('# Constraints');
    const acIdx = prompt.indexOf('# Acceptance Criteria');
    const dodIdx = prompt.indexOf('# Definition of Done (Runner 向け)');

    expect(contextIdx).toBeGreaterThanOrEqual(0);
    expect(contextIdx).toBeLessThan(goalIdx);
    expect(goalIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(acIdx);
    expect(acIdx).toBeLessThan(dodIdx);
  });

  it('Context にメタ情報が含まれる', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain('- Repository: hexylab/philharmonic');
    expect(prompt).toContain('- Base branch: main');
    expect(prompt).toContain('- Issue: #17 Issue body から prompt を組み立てる');
    expect(prompt).toContain('- Issue URL: https://github.com/hexylab/philharmonic/issues/17');
    expect(prompt).toContain(
      '- Workspace (worktree, absolute path): /home/runner/.philharmonic/worktrees/issue-17',
    );
    expect(prompt).toContain('`AGENTS.md` および `CLAUDE.md`');
  });

  it('Issue body の Constraints が Orchestrator 追加制約より先に来る', () => {
    const prompt = buildPrompt(baseInput());

    const issueConstraintIdx = prompt.indexOf('Issue body の Markdown ヘッダ');
    const orchestratorHeaderIdx = prompt.indexOf('## Orchestrator からの追加制約');

    expect(issueConstraintIdx).toBeGreaterThanOrEqual(0);
    expect(orchestratorHeaderIdx).toBeGreaterThan(issueConstraintIdx);
  });

  it('Orchestrator 追加制約が末尾に必ず追記される', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain('`git push` を実行しないこと');
    expect(prompt).toContain('Pull Request を作成しないこと');
    expect(prompt).toContain('GitHub token を期待しないこと');
    expect(prompt).toContain('Conventional Commits');
  });

  it('Runner 向け Definition of Done チェックリストが含まれる', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain('- [ ] Issue の Acceptance Criteria をすべて満たしている');
    expect(prompt).toContain('- [ ] ローカルで CI 相当のチェック');
    expect(prompt).toContain('- [ ] 必要なドキュメント');
    expect(prompt).toContain('- [ ] コミットメッセージが Conventional Commits に準拠');
  });

  it('Runner 向け DoD には PR テンプレート / レビュー承認の項目を含めない', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).not.toContain('PR テンプレート');
    expect(prompt).not.toContain('レビュー承認');
  });

  it('Issue body の本文が prompt に貼り付けられる', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain(
      'orchestration-mvp.md「Claude Code Runner Prompt Construction」セクションに従い',
    );
    expect(prompt).toContain('`buildPrompt(input): string`');
  });

  it('Issue body 必須セクション欠損時に MissingPromptSectionError が伝播する', () => {
    expect.assertions(2);
    try {
      buildPrompt(baseInput({ issueBody: fixture('issue-body-missing-constraints.md') }));
    } catch (error) {
      expect(error).toBeInstanceOf(MissingPromptSectionError);
      expect((error as MissingPromptSectionError).missingSections).toEqual(['constraints']);
    }
  });
});
