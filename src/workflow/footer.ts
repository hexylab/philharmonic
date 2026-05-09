/**
 * テンプレート出力の末尾に Orchestrator が無条件で連結する安全制約フッタ。
 *
 * `WORKFLOW.md` を最小限に書き換えた場合に push しない / PR 作らない / token 期待しない /
 * Conventional Commits の制約が落ちないように、ユーザのテンプレート編集に依存させない。
 *
 * 仕様: docs/specs/workflow.md / docs/adr/0003-prompt-templating.md
 */
export const ORCHESTRATOR_FOOTER = [
  '## Orchestrator からの追加制約',
  '',
  '- `git push` を実行しないこと (push は Orchestrator が行う)',
  '- Pull Request を作成しないこと (PR 作成は Orchestrator が行う)',
  '- GitHub token を期待しないこと (token は Runner プロセスに渡されない)',
  '- 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit すること',
].join('\n');

export function appendOrchestratorFooter(rendered: string): string {
  const trimmed = rendered.replace(/\s+$/u, '');
  return `${trimmed}\n\n${ORCHESTRATOR_FOOTER}\n`;
}
