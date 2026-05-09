import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../config/index.js';
import type { GitHubClient, Issue } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import {
  createRunLog,
  generateRunId,
  writeMetadata,
  writeSummary,
  type RunLog,
  type RunLogStatus,
} from '../runlog/index.js';
import { runClaude, type RunResult } from '../runner/index.js';
import type { WorkflowSource } from '../workflow/index.js';
import { defaultGitRunner, type GitRunner, type WorkspaceManager } from '../workspace/index.js';

import { BootstrapError, type FailureReason } from './errors.js';
import { buildFailureCommentBody, buildPullRequestBody, summarizeRunResult } from './format.js';
import { countCommitsAhead, fetchBaseBranch, pushBranch } from './git.js';
import { dispatchPool } from './pool.js';
import { parseRepositoryNameWithOwner, type Repository } from './repository.js';
import { DEFAULT_DISPATCH_STATUSES, isAcceptableIssue, selectFirstByStatus } from './select.js';
import { buildIssueSlug } from './slug.js';
import { resolveStatusOptions, type StatusOptionMap } from './status.js';

const DEFAULT_REMOTE = 'origin';

export type RunOnceClock = () => Date;

export type ResolveAttempt = (issueNumber: number) => Promise<number> | number;

export type RunOnceDeps = {
  config: Config;
  repoRoot: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  workflowSource: WorkflowSource;
  runnerLogsRoot: string;
  remote?: string;
  dispatchStatuses?: readonly string[];
  resolveAttempt?: ResolveAttempt;
  runClaude?: typeof runClaude;
  gitRunner?: GitRunner;
  logger?: Logger;
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

const noopLogger: Logger = {
  level: 'info',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const baseLogger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const remote = deps.remote ?? DEFAULT_REMOTE;
  const dispatchStatuses =
    deps.dispatchStatuses ?? deps.config.dispatchStatuses ?? DEFAULT_DISPATCH_STATUSES;

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
    logger: baseLogger,
  });
  if (selected === null) {
    baseLogger.info('no candidate', { dispatchStatuses });
    return { kind: 'no_candidate' };
  }

  const { candidate, issue, repository } = selected;

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

  // 4-9. Workspace 作成以降は dispatchSelected に委譲する
  return await dispatchSelected({
    config: deps.config,
    repoRoot: deps.repoRoot,
    candidate,
    issue,
    repository,
    projectId,
    statusFieldId,
    statusOptions,
    githubClient: deps.githubClient,
    workspaceManager: deps.workspaceManager,
    workflowSource: deps.workflowSource,
    runnerLogsRoot: deps.runnerLogsRoot,
    remote,
    resolveAttempt: deps.resolveAttempt,
    runClaude: deps.runClaude,
    gitRunner: deps.gitRunner,
    baseLogger,
    clock,
    generateRunId: deps.generateRunId,
  });
}

export type RunConcurrentDeps = RunOnceDeps & {
  maxConcurrent: number;
};

export type ConcurrentDispatchOutcome = {
  slot: number;
  result: Extract<RunOnceResult, { kind: 'success' | 'failed' }>;
};

/**
 * 1 tick で `maxConcurrent` 件まで並列 dispatch する。
 *
 * - 候補は acceptable filter を通った先頭 N 件だけを pick する (1 tick の処理上限が予測しやすい)
 * - 各 dispatch は独立した Promise として走り、相互に状態を汚染しない
 * - dispatch 中の予期せぬ例外は worker 内で握って `failed` として結果配列に落とす
 *   (BootstrapError 相当の Status update 失敗は warn ログのみ出して該当 Issue だけ skip)
 * - 結果配列は dispatch 完了順で返す (slot ごとに完了タイミングが違うため)
 *
 * 仕様: docs/specs/serve-daemon.md#並列-dispatch-24
 */
export async function runConcurrent(deps: RunConcurrentDeps): Promise<ConcurrentDispatchOutcome[]> {
  const baseLogger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const remote = deps.remote ?? DEFAULT_REMOTE;
  const dispatchStatuses =
    deps.dispatchStatuses ?? deps.config.dispatchStatuses ?? DEFAULT_DISPATCH_STATUSES;
  const { maxConcurrent } = deps;

  if (maxConcurrent < 1) {
    throw new Error(`runConcurrent: maxConcurrent must be >= 1 (got ${maxConcurrent})`);
  }

  // 1. Candidate Selection (上から最大 N 件 acceptable な candidate を pick)
  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const selected = await selectAcceptableCandidates({
    candidates,
    dispatchStatuses,
    githubClient: deps.githubClient,
    agentUserLogin: deps.config.agentUserLogin,
    logger: baseLogger,
    limit: maxConcurrent,
  });
  if (selected.length === 0) {
    baseLogger.info('no candidate', { dispatchStatuses });
    return [];
  }

  // 2. Project metadata + status options (1 回だけ取得)
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

  // 3. Status: Todo → In Progress を逐次に試みる (失敗は warn だけで skip)
  //    並列で叩いてもいいが、結果集計とログがシンプルになるので先に直列で確定させる。
  const dispatchable: SelectResult[] = [];
  for (const task of selected) {
    try {
      await deps.githubClient.updateProjectV2ItemStatus({
        projectId,
        itemId: task.candidate.itemId,
        fieldId: statusFieldId,
        optionId: statusOptions['In Progress'],
      });
      dispatchable.push(task);
    } catch (error) {
      baseLogger.warn('concurrent dispatch status_transition skipped', {
        issueNumber: task.candidate.issueNumber,
        error: describeError(error),
      });
    }
  }
  if (dispatchable.length === 0) return [];

  baseLogger.info('concurrent tick', {
    maxConcurrent,
    dispatched: dispatchable.length,
  });

  // 4. dispatchSelected を slot pool で並列実行
  return await dispatchPool({
    tasks: dispatchable,
    maxConcurrent,
    worker: async (task, slot): Promise<ConcurrentDispatchOutcome> => {
      try {
        const result = await dispatchSelected({
          config: deps.config,
          repoRoot: deps.repoRoot,
          candidate: task.candidate,
          issue: task.issue,
          repository: task.repository,
          projectId,
          statusFieldId,
          statusOptions,
          githubClient: deps.githubClient,
          workspaceManager: deps.workspaceManager,
          workflowSource: deps.workflowSource,
          runnerLogsRoot: deps.runnerLogsRoot,
          remote,
          resolveAttempt: deps.resolveAttempt,
          runClaude: deps.runClaude,
          gitRunner: deps.gitRunner,
          baseLogger,
          clock,
          generateRunId: deps.generateRunId,
        });
        return { slot, result };
      } catch (error) {
        // dispatchSelected は通常 markFailed 経由で `failed` を return するため、
        // ここに来るのは想定外の throw のみ。daemon を落とさず failed として記録する。
        baseLogger.warn('dispatch error', {
          slot,
          issueNumber: task.candidate.issueNumber,
          error: describeError(error),
        });
        return {
          slot,
          result: {
            kind: 'failed',
            runId: 'unknown',
            issueNumber: task.candidate.issueNumber,
            reason: 'runner_error',
            branch: null,
          },
        };
      }
    },
  });
}

export type DispatchSelectedDeps = {
  config: Config;
  repoRoot: string;
  candidate: Candidate;
  issue: Issue;
  repository: Repository;
  projectId: string;
  statusFieldId: string;
  statusOptions: StatusOptionMap;
  githubClient: GitHubClient;
  workspaceManager: WorkspaceManager;
  workflowSource: WorkflowSource;
  runnerLogsRoot: string;
  remote?: string;
  resolveAttempt?: ResolveAttempt;
  runClaude?: typeof runClaude;
  gitRunner?: GitRunner;
  baseLogger?: Logger;
  clock?: RunOnceClock;
  generateRunId?: () => string;
};

/**
 * Project Item が選択され、Status が `In Progress` の状態から先を実行する。
 *
 * - `runOnce` は Todo → In Progress 遷移後にこの関数を呼ぶ
 * - `recovery` は既に `In Progress` の Item を引き取って直接呼ぶ (Todo→IP は不要)
 */
export async function dispatchSelected(
  deps: DispatchSelectedDeps,
): Promise<Extract<RunOnceResult, { kind: 'success' | 'failed' }>> {
  const baseLogger = deps.baseLogger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const remote = deps.remote ?? DEFAULT_REMOTE;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const runner = deps.runClaude ?? runClaude;
  const idGen = deps.generateRunId ?? generateRunId;

  const { candidate, issue, repository } = deps;
  const runId = idGen();
  const startedAt = clock();
  const runLog = await createRunLog({ runId, runsRoot: deps.runnerLogsRoot });
  const logger = baseLogger.child({ runId, issueNumber: candidate.issueNumber });

  logger.info('candidate selected', {
    repository: candidate.repositoryNameWithOwner,
  });

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
    projectId: deps.projectId,
    statusFieldId: deps.statusFieldId,
    statusOptions: deps.statusOptions,
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
  //    WORKFLOW.md があれば Liquid テンプレート (上位レイヤ)、無ければ buildPrompt フォールバック (下位レイヤ)
  //    spec: docs/specs/workflow.md / docs/adr/0003-prompt-templating.md
  let attempt: number;
  try {
    attempt = deps.resolveAttempt ? await deps.resolveAttempt(candidate.issueNumber) : 1;
  } catch (error) {
    return await markFailed(failureContext, 'runner_error', error);
  }
  let prompt: string;
  try {
    prompt = await deps.workflowSource.render({
      repository,
      baseBranch: deps.config.baseBranch,
      issueNumber: candidate.issueNumber,
      issueTitle: candidate.issueTitle,
      issueUrl: candidate.issueUrl,
      issueBody: issue.body ?? '',
      workspacePath,
      attempt,
      runId,
    });
  } catch (error) {
    return await markFailed(failureContext, 'runner_error', error);
  }
  await writeFile(path.join(runLog.dir, 'prompt.md'), prompt, 'utf8');

  // 6. Runner Execution
  if (deps.config.permissionMode === 'bypass') {
    logger.warn(
      'permission_mode=bypass で Claude Code を起動します。--dangerously-skip-permissions の副作用は worktree 外 (ホスト全体) にも及び得るため、git worktree + 非特権ユーザによる隔離を必ず確認してください',
    );
  }
  let run: RunResult;
  try {
    run = await runner({
      prompt,
      workspacePath,
      sessionId: runId,
      permissionMode: deps.config.permissionMode,
      timeoutMs: deps.config.timeoutMs,
      killGracePeriodMs: deps.config.killGracePeriodMs,
      maxTurns: deps.config.agent.maxTurns,
      stallTimeoutMs: deps.config.agent.stallTimeoutMs,
      logDir: runLog.dir,
      logger,
    });
  } catch (error) {
    return await markFailed(failureContext, 'runner_error', error);
  }

  // 7. Result Triage
  if (run.status === 'timeout') {
    return await markFailed(failureContext, 'timeout', null, run);
  }
  if (run.status === 'stalled') {
    return await markFailed(failureContext, 'stalled', null, run);
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
      projectId: deps.projectId,
      itemId: candidate.itemId,
      fieldId: deps.statusFieldId,
      optionId: deps.statusOptions['In Review'],
    });
  } catch (error) {
    logger.warn('Status を In Review に遷移できませんでした (PR は作成済み)', {
      error: describeError(error),
    });
  }

  // 8.4 worktree cleanup
  try {
    await deps.workspaceManager.cleanupWorkspace({ taskKey, branch, deleteBranch: true });
  } catch (error) {
    logger.warn('worktree のクリーンアップに失敗しました', {
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
  logger: Logger;
  clock: RunOnceClock;
};

async function markFailed(
  ctx: FailureContext,
  reason: FailureReason,
  error: unknown,
  run?: RunResult,
): Promise<Extract<RunOnceResult, { kind: 'failed' }>> {
  const finishedAt = ctx.clock();
  const durationMs = run?.durationMs ?? finishedAt.getTime() - ctx.startedAt.getTime();
  const totalCostUsd = run?.totalCostUsd ?? null;
  const summary = run !== undefined ? summarizeRunResult(run) : null;
  const detail = error !== undefined && error !== null ? describeError(error) : null;

  ctx.logger.error('run failed', {
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
  logger: Logger;
};

type SelectResult = {
  candidate: Candidate;
  issue: Issue;
  repository: { owner: string; name: string };
};

async function selectAcceptableCandidate(input: SelectInput): Promise<SelectResult | null> {
  const results = await selectAcceptableCandidates({ ...input, limit: 1 });
  return results[0] ?? null;
}

async function selectAcceptableCandidates(
  input: SelectInput & { limit: number },
): Promise<SelectResult[]> {
  const acceptable: SelectResult[] = [];
  let remaining: readonly Candidate[] = input.candidates;
  while (remaining.length > 0 && acceptable.length < input.limit) {
    const candidate = selectFirstByStatus({
      candidates: remaining,
      dispatchStatuses: input.dispatchStatuses,
    });
    if (candidate === null) break;
    const repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    const issue = await input.githubClient.getIssue({
      owner: repository.owner,
      repo: repository.name,
      issueNumber: candidate.issueNumber,
    });
    if (issue.state === 'open') {
      const result = isAcceptableIssue({
        labels: issue.labels,
        assignees: issue.assignees,
        agentUserLogin: input.agentUserLogin,
      });
      if (result.ok) {
        acceptable.push({ candidate, issue, repository });
      } else {
        input.logger.info(`skip candidate (${result.reason})`, {
          issueNumber: candidate.issueNumber,
        });
      }
    } else {
      input.logger.info('skip candidate (issue closed)', {
        issueNumber: candidate.issueNumber,
      });
    }
    remaining = remaining.filter((c) => c.itemId !== candidate.itemId);
  }
  return acceptable;
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
