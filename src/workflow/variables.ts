import { buildPrompt, type BuildPromptInput } from '../prompt/index.js';

import type { StatusTransitions } from './footer.js';

export type WorkflowVariables = {
  repository: { owner: string; name: string };
  base_branch: string;
  issue: {
    number: number;
    title: string;
    url: string;
    body: string;
  };
  project: {
    owner: string;
    number: number;
    status_field: string;
  };
  status_transitions: {
    in_progress: string;
    in_review: string;
    failed: string;
  };
  workspace_path: string;
  run_id: string;
};

export type BuildWorkflowVariablesInput = BuildPromptInput & {
  runId: string;
  project: {
    owner: string;
    number: number;
    statusField: string;
  };
  statusTransitions: StatusTransitions;
};

/**
 * Issue body と orchestration コンテキストから WorkflowVariables を生成する (ADR-0005)。
 *
 * Issue body の構造化抽出 (`## Goal` / `## Constraints` / `## Acceptance Criteria`) は撤廃し、
 * `issue.body` に本文をそのまま渡す。Project の owner / number / status field と
 * `status_transitions` の Status 名は `philharmonic.yaml` の設定をそのままテンプレートに公開する。
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
    project: {
      owner: input.project.owner,
      number: input.project.number,
      status_field: input.project.statusField,
    },
    status_transitions: {
      in_progress: input.statusTransitions.inProgress,
      in_review: input.statusTransitions.inReview,
      failed: input.statusTransitions.failed,
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
    project: input.project,
    statusTransitions: input.statusTransitions,
  });
}
