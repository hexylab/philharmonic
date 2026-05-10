import { buildPrompt, type BuildPromptInput } from '../prompt/index.js';

export type WorkflowVariables = {
  repository: { owner: string; name: string };
  base_branch: string;
  issue: {
    number: number;
    title: string;
    url: string;
    body: string;
  };
  workspace_path: string;
  run_id: string;
};

export type BuildWorkflowVariablesInput = BuildPromptInput & {
  runId: string;
};

/**
 * Issue body と orchestration コンテキストから WorkflowVariables を生成する (ADR-0005)。
 *
 * Issue body の構造化抽出 (`## Goal` / `## Constraints` / `## Acceptance Criteria`) は撤廃し、
 * `issue.body` に本文をそのまま渡す。`attempt` 変数も自動 retry 撤廃に伴い削除。
 */
export function buildWorkflowVariables(input: BuildWorkflowVariablesInput): WorkflowVariables {
  return {
    repository: input.repository,
    base_branch: input.baseBranch,
    issue: {
      number: input.issueNumber,
      title: input.issueTitle,
      url: input.issueUrl,
      body: input.issueBody,
    },
    workspace_path: input.workspacePath,
    run_id: input.runId,
  };
}

/**
 * テンプレート不在時のフォールバック。`buildPrompt` の出力をそのまま prompt として返す。
 */
export function renderFallbackPrompt(input: BuildWorkflowVariablesInput): string {
  return buildPrompt({
    repository: input.repository,
    baseBranch: input.baseBranch,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    issueBody: input.issueBody,
    workspacePath: input.workspacePath,
  });
}
