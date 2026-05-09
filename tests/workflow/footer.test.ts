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

  it('フッタには 4 つの安全制約と Conventional Commits リンクが含まれる', () => {
    expect(ORCHESTRATOR_FOOTER).toContain('## Orchestrator からの追加制約');
    expect(ORCHESTRATOR_FOOTER).toContain('`git push` を実行しないこと');
    expect(ORCHESTRATOR_FOOTER).toContain('Pull Request を作成しないこと');
    expect(ORCHESTRATOR_FOOTER).toContain('GitHub token を期待しないこと');
    expect(ORCHESTRATOR_FOOTER).toContain('Conventional Commits');
  });
});
