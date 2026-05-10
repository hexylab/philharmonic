import { describe, expect, it } from 'vitest';

import {
  appendOrchestratorFooter,
  buildOrchestratorFooter,
  type StatusTransitions,
} from '../../src/workflow/footer.js';

const DEFAULT_TRANSITIONS: StatusTransitions = {
  inProgress: 'In Progress',
  inReview: 'In Review',
  failed: 'Failed',
};

const CUSTOM_TRANSITIONS: StatusTransitions = {
  inProgress: 'Working',
  inReview: 'In Review',
  failed: 'Blocked',
};

describe('appendOrchestratorFooter', () => {
  it('テンプレート出力の末尾の空白を畳んでフッタを連結する', () => {
    const out = appendOrchestratorFooter('main body\n\n', DEFAULT_TRANSITIONS);
    expect(out).toBe(`main body\n\n${buildOrchestratorFooter(DEFAULT_TRANSITIONS)}\n`);
  });

  it('テンプレートが空でもフッタが必ず付く', () => {
    const out = appendOrchestratorFooter('', DEFAULT_TRANSITIONS);
    expect(out).toBe(`\n\n${buildOrchestratorFooter(DEFAULT_TRANSITIONS)}\n`);
  });

  it('フッタには agent 委譲指示が含まれる (ADR-0005)', () => {
    const footer = buildOrchestratorFooter(DEFAULT_TRANSITIONS);
    expect(footer).toContain('## Orchestrator からの追加指示');
    expect(footer).toContain('Project Status を `In Progress` に遷移');
    expect(footer).toContain('`git push -u origin <branch>`');
    expect(footer).toContain('`gh pr create`');
    expect(footer).toContain('Project Status を `In Review` に遷移');
    expect(footer).toContain('Project Status を `Failed` に遷移');
    expect(footer).toContain('Conventional Commits');
    expect(footer).toContain('GITHUB_TOKEN');
  });

  it('status_transitions の値がそのまま埋め込まれる (custom Status 名でも動く)', () => {
    const footer = buildOrchestratorFooter(CUSTOM_TRANSITIONS);
    expect(footer).toContain('Project Status を `Working` に遷移');
    expect(footer).toContain('Project Status を `Blocked` に遷移');
    // default の `In Progress` / `Failed` は出ない
    expect(footer).not.toContain('Project Status を `In Progress` に遷移');
    expect(footer).not.toContain('Project Status を `Failed` に遷移');
  });
});
