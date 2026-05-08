import { MissingPromptSectionError, type IssueBodySectionKey } from './errors.js';

export type ParsedIssueBody = {
  goal: string;
  constraints: string;
  acceptanceCriteria: string;
};

const REQUIRED_HEADERS: Record<IssueBodySectionKey, string> = {
  goal: 'Goal',
  constraints: 'Constraints',
  acceptance_criteria: 'Acceptance Criteria',
};

const HEADER_REGEX = /^##\s+(.+?)\s*$/;
const FENCE_REGEX = /^\s*```/;

export function parseIssueBody(body: string): ParsedIssueBody {
  const sections = extractSections(body);

  const missing: IssueBodySectionKey[] = [];
  const picked: Record<IssueBodySectionKey, string> = {
    goal: '',
    constraints: '',
    acceptance_criteria: '',
  };

  for (const key of Object.keys(REQUIRED_HEADERS) as IssueBodySectionKey[]) {
    const label = REQUIRED_HEADERS[key];
    const content = sections.get(label);
    if (content === undefined || content.trim().length === 0) {
      missing.push(key);
      continue;
    }
    picked[key] = content.trim();
  }

  if (missing.length > 0) {
    throw new MissingPromptSectionError(missing);
  }

  return {
    goal: picked.goal,
    constraints: picked.constraints,
    acceptanceCriteria: picked.acceptance_criteria,
  };
}

function extractSections(body: string): Map<string, string> {
  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const sections = new Map<string, string>();
  let currentLabel: string | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (currentLabel === null) return;
    sections.set(currentLabel, buffer.join('\n'));
    buffer = [];
  };

  for (const line of lines) {
    if (FENCE_REGEX.test(line)) {
      inFence = !inFence;
      if (currentLabel !== null) buffer.push(line);
      continue;
    }

    if (!inFence) {
      const headerMatch = HEADER_REGEX.exec(line);
      if (headerMatch !== null) {
        flush();
        currentLabel = headerMatch[1] ?? '';
        continue;
      }
    }

    if (currentLabel !== null) buffer.push(line);
  }
  flush();

  return sections;
}
