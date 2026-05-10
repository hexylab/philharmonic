import { ORCHESTRATOR_FOOTER_HEADER, ORCHESTRATOR_FOOTER_LINES } from '../workflow/footer.js';

export type BuildPromptInput = {
  repository: { owner: string; name: string };
  baseBranch: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  workspacePath: string;
};

/**
 * Issue body を構造化抽出せずそのまま prompt に貼り付けるフォールバック実装 (ADR-0005)。
 *
 * - `## Goal` / `## Constraints` / `## Acceptance Criteria` の必須セクションは撤廃
 * - footer は `workflow/footer.ts` の単一ソースを利用 (テンプレート経路と同一文言)
 *
 * spec: docs/specs/prompt-construction.md
 */
export function buildPrompt(input: BuildPromptInput): string {
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

  const issueBody = ['# Issue 本文', '', normalizeBody(input.issueBody)].join('\n');

  const footer = [ORCHESTRATOR_FOOTER_HEADER, '', ...ORCHESTRATOR_FOOTER_LINES].join('\n');

  return [context, issueBody, footer].join('\n\n') + '\n';
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}
