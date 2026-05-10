import { describe, expect, it } from 'vitest';

import { ORCHESTRATOR_FOOTER, appendOrchestratorFooter } from '../../src/workflow/footer.js';

describe('appendOrchestratorFooter', () => {
  it('テンプレート出力の末尾の空白を畳んでフッタを連結する', () => {
    const out = appendOrchestratorFooter('main body\n\n');
    expect(out).toBe(`main body\n\n${ORCHESTRATOR_FOOTER}\n`);
  });

  it('テンプレートが空でもフッタが必ず付く', () => {
    const out = appendOrchestratorFooter('');
    expect(out).toBe(`\n\n${ORCHESTRATOR_FOOTER}\n`);
  });

  it('フッタには agent 委譲指示が含まれる (ADR-0005)', () => {
    expect(ORCHESTRATOR_FOOTER).toContain('## Orchestrator からの追加指示');
    expect(ORCHESTRATOR_FOOTER).toContain('Project Status を `In Progress` に遷移');
    expect(ORCHESTRATOR_FOOTER).toContain('`git push -u origin <branch>`');
    expect(ORCHESTRATOR_FOOTER).toContain('`gh pr create`');
    expect(ORCHESTRATOR_FOOTER).toContain('Project Status を `In Review` に遷移');
    expect(ORCHESTRATOR_FOOTER).toContain('Project Status を `Failed` に遷移');
    expect(ORCHESTRATOR_FOOTER).toContain('Conventional Commits');
    expect(ORCHESTRATOR_FOOTER).toContain('GITHUB_TOKEN');
  });
});
