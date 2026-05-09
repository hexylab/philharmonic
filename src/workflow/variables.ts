import { buildPrompt, parseIssueBody, type BuildPromptInput } from '../prompt/index.js';

export type WorkflowVariables = {
  repository: { owner: string; name: string };
  base_branch: string;
  issue: {
    number: number;
    title: string;
    url: string;
    body: string;
    goal: string;
    constraints: string;
    acceptance_criteria: string;
  };
  workspace_path: string;
  attempt: number;
  run_id: string;
};

export type BuildWorkflowVariablesInput = Omit<BuildPromptInput, 'issueBody'> & {
  issueBody: string;
  attempt: number;
  runId: string;
};

/**
 * Issue body と orchestration コンテキストから WorkflowVariables を生成する。
 *
 * Issue body の必須セクション (Goal / Constraints / Acceptance Criteria) はパース済みの値を
 * `issue.goal` / `issue.constraints` / `issue.acceptance_criteria` として公開する。
 * 必須セクション欠損時は `MissingPromptSectionError` が伝播する (parseIssueBody の挙動)。
 */
export function buildWorkflowVariables(input: BuildWorkflowVariablesInput): WorkflowVariables {
  const parsed = parseIssueBody(input.issueBody);
  return {
    repository: input.repository,
    base_branch: input.baseBranch,
    issue: {
      number: input.issueNumber,
      title: input.issueTitle,
      url: input.issueUrl,
      body: input.issueBody,
      goal: parsed.goal,
      constraints: parsed.constraints,
      acceptance_criteria: parsed.acceptanceCriteria,
    },
    workspace_path: input.workspacePath,
    attempt: input.attempt,
    run_id: input.runId,
  };
}

/**
 * テンプレート不在時のフォールバック。`buildPrompt` の出力をそのまま prompt として返す。
 *
 * `buildPrompt` は Constraints セクション末尾に Orchestrator 制約を埋め込む構造で出力するため、
 * テンプレート利用時 (`appendOrchestratorFooter`) と末尾整形が異なる点に注意。
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
