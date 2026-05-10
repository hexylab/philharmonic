import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPrompt, type BuildPromptInput } from '../../src/prompt/build.js';

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
    project: { owner: 'hexylab', number: 1, statusField: 'Status' },
    statusTransitions: { inProgress: 'In Progress', inReview: 'In Review', failed: 'Failed' },
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('Context / Issue 本文 / Orchestrator フッタの順で連結される', () => {
    const prompt = buildPrompt(baseInput());

    const contextIdx = prompt.indexOf('# Context');
    const bodyIdx = prompt.indexOf('# Issue 本文');
    const footerIdx = prompt.indexOf('## Orchestrator からの追加指示');

    expect(contextIdx).toBeGreaterThanOrEqual(0);
    expect(contextIdx).toBeLessThan(bodyIdx);
    expect(bodyIdx).toBeLessThan(footerIdx);
  });

  it('Context にメタ情報が含まれる', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain('- Repository: hexylab/philharmonic');
    expect(prompt).toContain('- Base branch: main');
    expect(prompt).toContain('- Issue: #17 Issue body から prompt を組み立てる');
    expect(prompt).toContain('- Issue URL: https://github.com/hexylab/philharmonic/issues/17');
    expect(prompt).toContain('- Project: hexylab/projects/1 (Status field: `Status`)');
    expect(prompt).toContain(
      '- Workspace (worktree, absolute path): /home/runner/.philharmonic/worktrees/issue-17',
    );
    expect(prompt).toContain('`AGENTS.md` および `CLAUDE.md`');
  });

  it('status_transitions が custom 値ならフッタにそれが埋め込まれる', () => {
    const prompt = buildPrompt(
      baseInput({
        statusTransitions: { inProgress: 'Working', inReview: 'In Review', failed: 'Blocked' },
      }),
    );

    expect(prompt).toContain('Project Status を `Working` に遷移');
    expect(prompt).toContain('Project Status を `Blocked` に遷移');
    expect(prompt).not.toContain('Project Status を `In Progress` に遷移');
    expect(prompt).not.toContain('Project Status を `Failed` に遷移');
  });

  it('Issue body 全文がそのまま貼り付けられる (構造化抽出を行わない)', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain('## Goal');
    expect(prompt).toContain(
      'orchestration-mvp.md「Claude Code Runner Prompt Construction」セクションに従い',
    );
    expect(prompt).toContain('## Constraints');
    expect(prompt).toContain('Issue body の Markdown ヘッダ');
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('`buildPrompt(input): string`');
  });

  it('Orchestrator フッタが agent 委譲指示で末尾に追記される (ADR-0005)', () => {
    const prompt = buildPrompt(baseInput());

    expect(prompt).toContain('Project Status を `In Progress` に遷移');
    expect(prompt).toContain('`gh pr create`');
    expect(prompt).toContain('Project Status を `In Review` に遷移');
    expect(prompt).toContain('Project Status を `Failed` に遷移');
    expect(prompt).toContain('Conventional Commits');
    expect(prompt).toContain('GITHUB_TOKEN');
  });

  it('構造化セクション欠損でも throw しない (parseIssueBody は撤廃)', () => {
    expect(() =>
      buildPrompt(baseInput({ issueBody: fixture('issue-body-missing-constraints.md') })),
    ).not.toThrow();
  });

  it('Issue body が空文字でも prompt は組み立てられる', () => {
    const prompt = buildPrompt(baseInput({ issueBody: '' }));
    expect(prompt).toContain('# Context');
    expect(prompt).toContain('# Issue 本文');
    expect(prompt).toContain('## Orchestrator からの追加指示');
  });
});
