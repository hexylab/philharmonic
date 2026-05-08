import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../config/index.js';
import type { GitHubClient, Issue } from '../github/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import { buildPrompt } from '../prompt/index.js';
import {
  createRunLog,
  generateRunId,
  writeMetadata,
  writeSummary,
  type RunLog,
  type RunLogStatus,
} from '../runlog/index.js';
import { runClaude, type RunResult } from '../runner/index.js';
import { defaultGitRunner, type GitRunner, type WorkspaceManager } from '../workspace/index.js';

import { BootstrapError, type FailureReason } from './errors.js';
import { buildFailureCommentBody, buildPullRequestBody, summarizeRunResult } from './format.js';
import { countCommitsAhead, fetchBaseBranch, pushBranch } from './git.js';
import { parseRepositoryNameWithOwner } from './repository.js';
import { DEFAULT_DISPATCH_STATUSES, isAcceptableIssue, selectFirstByStatus } from './select.js';
import { buildIssueSlug } from './slug.js';
import { resolveStatusOptions, type StatusOptionMap } from './status.js';

const DEFAULT_REMOTE = 'origin';

export type RunOnceLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export type RunOnceClock = () => Date;

export type RunOnceDeps = {
  config: Config;
  repoRoot: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  runnerLogsRoot: string;
  remote?: string;
  dispatchStatuses?: readonly string[];
  runClaude?: typeof runClaude;
  gitRunner?: GitRunner;
  logger?: RunOnceLogger;
  clock?: RunOnceClock;
  generateRunId?: () => string;
};

export type RunOnceResult =
  | { kind: 'no_candidate' }
  | {
      kind: 'success';
      runId: string;
      issueNumber: number;
      prNumber: number;
      branch: string;
    }
  | {
      kind: 'failed';
      runId: string;
      issueNumber: number;
      reason: FailureReason;
      branch: string | null;
    };

const noopLogger: RunOnceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const logger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const remote = deps.remote ?? DEFAULT_REMOTE;
  const dispatchStatuses = deps.dispatchStatuses ?? DEFAULT_DISPATCH_STATUSES;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const runner = deps.runClaude ?? runClaude;
  const idGen = deps.generateRunId ?? generateRunId;

  // 1. Candidate Selection
  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const selected = await selectAcceptableCandidate({
    candidates,
    dispatchStatuses,
    githubClient: deps.githubClient,
    agentUserLogin: deps.config.agentUserLogin,
    logger,
  });
  if (selected === null) {
    logger.info('no candidate', { dispatchStatuses });
    return { kind: 'no_candidate' };
  }

  const { candidate, issue, repository } = selected;
  const runId = idGen();
  const startedAt = clock();
  const runLog = await createRunLog({ runId, runsRoot: deps.runnerLogsRoot });

  logger.info('candidate selected', {
    runId,
    issueNumber: candidate.issueNumber,
    repository: candidate.repositoryNameWithOwner,
  });

  // 2. Project metadata + status options
  let statusOptions: StatusOptionMap;
  let projectId: string;
  let statusFieldId: string;
  try {
    const metadata = await deps.projectsClient.fetchProjectMetadata({
      owner: deps.config.owner,
      projectNumber: deps.config.projectNumber,
      statusFieldName: deps.config.statusField,
    });
    statusOptions = resolveStatusOptions(metadata);
    projectId = metadata.projectId;
    statusFieldId = metadata.statusFieldId;
  } catch (error) {
    throw new BootstrapError(
      'metadata_load_failed',
      `Project metadata の取得に失敗しました: ${describeError(error)}`,
      { cause: error },
    );
  }

  // 3. Status Update: Todo → In Progress
  try {
    await deps.githubClient.updateProjectV2ItemStatus({
      projectId,
      itemId: candidate.itemId,
      fieldId: statusFieldId,
      optionId: statusOptions['In Progress'],
    });
  } catch (error) {
    throw new BootstrapError(
      'status_transition_to_in_progress_failed',
      `Status を In Progress に遷移できませんでした: ${describeError(error)}`,
      { cause: error },
    );
  }

  const branch = `feature/${candidate.issueNumber}-${buildIssueSlug(candidate.issueTitle)}`;
  const taskKey = `issue-${candidate.issueNumber}`;
  const baseRef = `${remote}/${deps.config.baseBranch}`;
  const failureContext: FailureContext = {
    runId,
    runLog,
    candidate,
    issue,
    repository,
    branch,
    projectId,
    statusFieldId,
    statusOptions,
    startedAt,
    githubClient: deps.githubClient,
    logger,
    clock,
  };

  // 4. Workspace Provisioning
  let workspacePath: string;
  try {
    await fetchBaseBranch(gitRunner, deps.repoRoot, remote, deps.config.baseBranch);
    const workspace = await deps.workspaceManager.createWorkspace({
      taskKey,
      branch,
      baseRef,
      reuse: false,
    });
    workspacePath = workspace.path;
  } catch (error) {
    return await markFailed(failureContext, 'workspace_provisioning', error);
  }

  // 5. Prompt Construction
  const prompt = buildPrompt({
    repository,
    baseBranch: deps.config.baseBranch,
    issueNumber: candidate.issueNumber,
    issueTitle: candidate.issueTitle,
    issueUrl: candidate.issueUrl,
    issueBody: issue.body ?? '',
    workspacePath,
  });
  await writeFile(path.join(runLog.dir, 'prompt.md'), prompt, 'utf8');

  // 6. Runner Execution
  let run: RunResult;
  try {
    run = await runner({
      prompt,
      workspacePath,
      sessionId: runId,
      timeoutMs: deps.config.timeoutMs,
      killGracePeriodMs: deps.config.killGracePeriodMs,
      logDir: runLog.dir,
    });
  } catch (error) {
    return await markFailed(failureContext, 'runner_error', error);
  }

  // 7. Result Triage
  if (run.status === 'timeout') {
    return await markFailed(failureContext, 'timeout', null, run);
  }
  if (run.status === 'failed') {
    return await markFailed(failureContext, 'runner_error', null, run);
  }

  let commits: number;
  try {
    commits = await countCommitsAhead(gitRunner, workspacePath, baseRef);
  } catch (error) {
    return await markFailed(failureContext, 'no_changes', error, run);
  }
  if (commits === 0) {
    return await markFailed(failureContext, 'no_changes', null, run);
  }

  // 8. PR Submission
  try {
    await pushBranch(gitRunner, workspacePath, branch, remote);
  } catch (error) {
    return await markFailed(failureContext, 'push', error, run);
  }

  let prNumber: number;
  try {
    const acceptanceCriteria = extractAcceptanceCriteria(issue.body ?? '');
    const pr = await deps.githubClient.createPullRequest({
      owner: repository.owner,
      repo: repository.name,
      base: deps.config.baseBranch,
      head: branch,
      title: candidate.issueTitle,
      body: buildPullRequestBody({
        issueNumber: candidate.issueNumber,
        acceptanceCriteria,
        runId,
        durationMs: run.durationMs,
        totalCostUsd: run.totalCostUsd,
        finalText: run.finalText,
        numTurns: run.numTurns,
      }),
    });
    prNumber = pr.number;
  } catch (error) {
    return await markFailed(failureContext, 'pr_create', error, run);
  }

  // 8.3 Status Update: In Progress → In Review
  try {
    await deps.githubClient.updateProjectV2ItemStatus({
      projectId,
      itemId: candidate.itemId,
      fieldId: statusFieldId,
      optionId: statusOptions['In Review'],
    });
  } catch (error) {
    logger.warn('Status を In Review に遷移できませんでした (PR は作成済み)', {
      runId,
      error: describeError(error),
    });
  }

  // 8.4 worktree cleanup
  try {
    await deps.workspaceManager.cleanupWorkspace({ taskKey, branch, deleteBranch: true });
  } catch (error) {
    logger.warn('worktree のクリーンアップに失敗しました', {
      runId,
      error: describeError(error),
    });
  }

  await persistRun(failureContext, {
    status: 'success',
    failureReason: null,
    branch,
    prNumber,
    durationMs: run.durationMs,
    totalCostUsd: run.totalCostUsd,
    finalText: run.finalText,
    finishedAt: clock(),
  });

  logger.info('run completed successfully', {
    runId,
    issueNumber: candidate.issueNumber,
    prNumber,
    branch,
  });

  return {
    kind: 'success',
    runId,
    issueNumber: candidate.issueNumber,
    prNumber,
    branch,
  };
}

type FailureContext = {
  runId: string;
  runLog: RunLog;
  candidate: Candidate;
  issue: Issue;
  repository: { owner: string; name: string };
  branch: string;
  projectId: string;
  statusFieldId: string;
  statusOptions: StatusOptionMap;
  startedAt: Date;
  githubClient: GitHubClient;
  logger: RunOnceLogger;
  clock: RunOnceClock;
};

async function markFailed(
  ctx: FailureContext,
  reason: FailureReason,
  error: unknown,
  run?: RunResult,
): Promise<RunOnceResult> {
  const finishedAt = ctx.clock();
  const durationMs = run?.durationMs ?? finishedAt.getTime() - ctx.startedAt.getTime();
  const totalCostUsd = run?.totalCostUsd ?? null;
  const summary = run !== undefined ? summarizeRunResult(run) : null;
  const detail = error !== undefined && error !== null ? describeError(error) : null;

  ctx.logger.error('run failed', {
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    reason,
    detail,
  });

  try {
    await ctx.githubClient.commentIssue({
      owner: ctx.repository.owner,
      repo: ctx.repository.name,
      issueNumber: ctx.candidate.issueNumber,
      body: buildFailureCommentBody({
        reason,
        runId: ctx.runId,
        durationMs,
        totalCostUsd,
        runnerSummary: summary,
        detail,
      }),
    });
  } catch (commentError) {
    ctx.logger.warn('Issue 失敗コメントの投稿に失敗しました', {
      runId: ctx.runId,
      error: describeError(commentError),
    });
  }

  try {
    await ctx.githubClient.updateProjectV2ItemStatus({
      projectId: ctx.projectId,
      itemId: ctx.candidate.itemId,
      fieldId: ctx.statusFieldId,
      optionId: ctx.statusOptions['Failed'],
    });
  } catch (statusError) {
    ctx.logger.warn('Status を Failed に遷移できませんでした', {
      runId: ctx.runId,
      error: describeError(statusError),
    });
  }

  await persistRun(ctx, {
    status: 'failed',
    failureReason: reason,
    branch: ctx.branch,
    prNumber: null,
    durationMs,
    totalCostUsd,
    finalText: run?.finalText ?? null,
    finishedAt,
  });

  return {
    kind: 'failed',
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    reason,
    branch: ctx.branch,
  };
}

type PersistInput = {
  status: RunLogStatus;
  failureReason: FailureReason | null;
  branch: string | null;
  prNumber: number | null;
  durationMs: number;
  totalCostUsd: number | null;
  finalText: string | null;
  finishedAt: Date;
};

async function persistRun(ctx: FailureContext, input: PersistInput): Promise<void> {
  await writeMetadata(ctx.runLog, {
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    status: input.status,
    failureReason: input.failureReason,
    totalCostUsd: input.totalCostUsd,
    branch: input.branch,
    prNumber: input.prNumber,
  });
  await writeSummary(ctx.runLog, {
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    status: input.status,
    finalText: input.finalText,
    failureReason: input.failureReason,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.durationMs,
    totalCostUsd: input.totalCostUsd,
  });
}

type SelectInput = {
  candidates: readonly Candidate[];
  dispatchStatuses: readonly string[];
  githubClient: GitHubClient;
  agentUserLogin: string | null;
  logger: RunOnceLogger;
};

type SelectResult = {
  candidate: Candidate;
  issue: Issue;
  repository: { owner: string; name: string };
};

async function selectAcceptableCandidate(input: SelectInput): Promise<SelectResult | null> {
  let remaining: readonly Candidate[] = input.candidates;
  while (remaining.length > 0) {
    const candidate = selectFirstByStatus({
      candidates: remaining,
      dispatchStatuses: input.dispatchStatuses,
    });
    if (candidate === null) return null;
    const repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    const issue = await input.githubClient.getIssue({
      owner: repository.owner,
      repo: repository.name,
      issueNumber: candidate.issueNumber,
    });
    if (issue.state === 'open') {
      const acceptable = isAcceptableIssue({
        labels: issue.labels,
        assignees: issue.assignees,
        agentUserLogin: input.agentUserLogin,
      });
      if (acceptable.ok) {
        return { candidate, issue, repository };
      }
      input.logger.info(`skip candidate (${acceptable.reason})`, {
        issueNumber: candidate.issueNumber,
      });
    } else {
      input.logger.info('skip candidate (issue closed)', {
        issueNumber: candidate.issueNumber,
      });
    }
    remaining = remaining.filter((c) => c.itemId !== candidate.itemId);
  }
  return null;
}

function extractAcceptanceCriteria(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headerIndex = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/.test(line));
  if (headerIndex === -1) return '';
  const collected: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^##\s+/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n').trim();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
