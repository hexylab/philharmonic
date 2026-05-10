/**
 * テンプレート出力の末尾に Orchestrator が無条件で連結する agent 委譲指示フッタ (ADR-0005)。
 *
 * agent (Claude Code + `gh` CLI) が Status 遷移 / commit / push / PR 作成 / 必要に応じ Issue
 * コメントまでを行うため、ユーザのテンプレート編集が `WORKFLOW.md` を最小限に書き換えても
 * これらの指示が落ちないように Orchestrator 側で footer を強制する。
 *
 * 遷移先 Status 名は `philharmonic.yaml` の `status_transitions` で設定された値をそのまま
 * 埋め込む。orchestrator は値を解釈せず、Project の Status options に存在するかは
 * agent が確認する (構造化バリデーションは行わない)。
 *
 * 仕様: docs/specs/workflow.md / docs/adr/0005-thin-orchestrator-agent-delegation.md
 */

export type StatusTransitions = {
  /** Todo → これに遷移 (agent が prompt 受領直後に flip) */
  inProgress: string;
  /** PR 作成成功時に遷移する Status 名 */
  inReview: string;
  /** 失敗判定時に遷移する Status 名 */
  failed: string;
};

export const ORCHESTRATOR_FOOTER_HEADER = '## Orchestrator からの追加指示';

export function buildOrchestratorFooterLines(transitions: StatusTransitions): string[] {
  return [
    `- 着手直後に Project Status を \`${transitions.inProgress}\` に遷移する (\`gh project item-edit\` 等を使用)`,
    '- 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit する',
    '- 作業完了後は `git push -u origin <branch>` で push する',
    '- `gh pr create` で対応 Issue に紐づく Pull Request を作成し、本文に `Closes #<番号>` を含める',
    `- PR 作成成功後は Project Status を \`${transitions.inReview}\` に遷移する`,
    `- 失敗時は Project Status を \`${transitions.failed}\` に遷移し、Issue に失敗の理由をコメントする (token / 機微情報を貼らない)`,
    '- GitHub の認証は環境変数 `GITHUB_TOKEN` / `GH_TOKEN` (Orchestrator が allowlist で透過) または host の `gh auth` を使う',
  ];
}

export function buildOrchestratorFooter(transitions: StatusTransitions): string {
  return [ORCHESTRATOR_FOOTER_HEADER, '', ...buildOrchestratorFooterLines(transitions)].join('\n');
}

export function appendOrchestratorFooter(rendered: string, transitions: StatusTransitions): string {
  const trimmed = rendered.replace(/\s+$/u, '');
  return `${trimmed}\n\n${buildOrchestratorFooter(transitions)}\n`;
}
