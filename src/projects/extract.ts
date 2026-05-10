import type {
  Candidate,
  IssueContent,
  ProjectItem,
  ProjectItemContent,
  ProjectItemFieldValue,
  ProjectItemsResponse,
} from './schema.js';

export const DEFAULT_STATUS_FIELD_NAME = 'Status';

export class ProjectNotFoundError extends Error {
  constructor(
    public readonly owner: string,
    public readonly projectNumber: number,
    public readonly reason: 'owner_not_found' | 'project_not_found',
  ) {
    super(
      reason === 'owner_not_found'
        ? `owner '${owner}' が見つかりません`
        : `Project number '${projectNumber}' が見つかりません`,
    );
    this.name = 'ProjectNotFoundError';
  }
}

export type ExtractCandidatesInput = {
  response: ProjectItemsResponse;
  owner: string;
  projectNumber: number;
  statusFieldName?: string;
};

export type ExtractedProjectContext = {
  projectId: string;
  candidates: Candidate[];
};

export function extractCandidates(input: ExtractCandidatesInput): Candidate[] {
  return extractProjectContext(input).candidates;
}

/**
 * Project candidates と一緒に project ID も返す。`philharmonic retry` (#88) のように
 * `gh project item-edit --project-id <id>` で project ID を別途必要とする経路で使う。
 */
export function extractProjectContext(input: ExtractCandidatesInput): ExtractedProjectContext {
  const { response, owner, projectNumber } = input;
  const statusFieldName = input.statusFieldName ?? DEFAULT_STATUS_FIELD_NAME;

  const repositoryOwner = response.repositoryOwner;
  if (repositoryOwner === null) {
    throw new ProjectNotFoundError(owner, projectNumber, 'owner_not_found');
  }

  const project = repositoryOwner.projectV2;
  if (project === null) {
    throw new ProjectNotFoundError(owner, projectNumber, 'project_not_found');
  }

  const candidates: Candidate[] = [];
  for (const item of project.items.nodes) {
    const candidate = toCandidate(item, statusFieldName);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return { projectId: project.id, candidates };
}

function toCandidate(item: ProjectItem, statusFieldName: string): Candidate | null {
  if (!isIssueContent(item.content)) {
    return null;
  }
  const content = item.content;

  const status = pickStatus(item.fieldValues.nodes, statusFieldName);

  return {
    itemId: item.id,
    issueNumber: content.number,
    issueTitle: content.title,
    issueUrl: content.url,
    issueState: content.state,
    repositoryNameWithOwner: content.repository.nameWithOwner,
    status,
  };
}

function isIssueContent(content: ProjectItemContent): content is IssueContent {
  return content !== null && content.__typename === 'Issue' && 'number' in content;
}

function pickStatus(
  fieldValues: readonly ProjectItemFieldValue[],
  statusFieldName: string,
): string | null {
  for (const value of fieldValues) {
    if (value.__typename !== 'ProjectV2ItemFieldSingleSelectValue') {
      continue;
    }
    if (!('field' in value) || value.field.name !== statusFieldName) {
      continue;
    }
    return value.name;
  }
  return null;
}
