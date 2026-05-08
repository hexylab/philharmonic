import { parseIssueBody } from './parse.js';

export type BuildPromptInput = {
  repository: { owner: string; name: string };
  baseBranch: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  workspacePath: string;
};

const ORCHESTRATOR_CONSTRAINTS_HEADER = '## Orchestrator からの追加制約';
const ORCHESTRATOR_CONSTRAINTS = [
  '- `git push` を実行しないこと (push は Orchestrator が行う)',
  '- Pull Request を作成しないこと (PR 作成は Orchestrator が行う)',
  '- GitHub token を期待しないこと (token は Runner プロセスに渡されない)',
  '- 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit すること',
];

const RUNNER_DEFINITION_OF_DONE = [
  '- [ ] Issue の Acceptance Criteria をすべて満たしている',
  '- [ ] ローカルで CI 相当のチェック (`format` / `lint` / `unit-test`) が green である',
  '- [ ] 必要なドキュメント (`docs/adr/` の ADR、`docs/specs/` の仕様書) を作成・更新している',
  '- [ ] コミットメッセージが Conventional Commits に準拠している',
];

export function buildPrompt(input: BuildPromptInput): string {
  const parsed = parseIssueBody(input.issueBody);

  const context = [
    '# Context',
    '',
    `- Repository: ${input.repository.owner}/${input.repository.name}`,
    `- Base branch: ${input.baseBranch}`,
    `- Issue: #${input.issueNumber} ${input.issueTitle}`,
    `- Issue URL: ${input.issueUrl}`,
    `- Workspace (worktree, absolute path): ${input.workspacePath}`,
    '- 必ずリポジトリの `AGENTS.md` および `CLAUDE.md` を参照してから着手すること',
  ].join('\n');

  const goal = ['# Goal', '', parsed.goal].join('\n');

  const constraints = [
    '# Constraints',
    '',
    parsed.constraints,
    '',
    ORCHESTRATOR_CONSTRAINTS_HEADER,
    '',
    ...ORCHESTRATOR_CONSTRAINTS,
  ].join('\n');

  const acceptanceCriteria = ['# Acceptance Criteria', '', parsed.acceptanceCriteria].join('\n');

  const definitionOfDone = [
    '# Definition of Done (Runner 向け)',
    '',
    ...RUNNER_DEFINITION_OF_DONE,
  ].join('\n');

  return [context, goal, constraints, acceptanceCriteria, definitionOfDone].join('\n\n') + '\n';
}
