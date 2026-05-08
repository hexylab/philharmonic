export type IssueBodySectionKey = 'goal' | 'constraints' | 'acceptance_criteria';

const SECTION_LABELS: Record<IssueBodySectionKey, string> = {
  goal: '## Goal',
  constraints: '## Constraints',
  acceptance_criteria: '## Acceptance Criteria',
};

export class MissingPromptSectionError extends Error {
  public readonly code = 'missing_prompt_section';

  constructor(public readonly missingSections: readonly IssueBodySectionKey[]) {
    super(formatMessage(missingSections));
    this.name = 'MissingPromptSectionError';
  }
}

function formatMessage(missing: readonly IssueBodySectionKey[]): string {
  const labels = missing.map((key) => SECTION_LABELS[key]).join(', ');
  return `Issue body から必須セクションを抽出できませんでした (missing: ${labels})`;
}
