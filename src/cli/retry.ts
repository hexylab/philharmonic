import { stat } from 'node:fs/promises';
import path from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  type Config,
  type LoadConfigOptions,
} from '../config/index.js';
import {
  GITHUB_TOKEN_ENV,
  GhCliNotAuthenticatedError,
  GhCliNotFoundError,
  GitHubTokenNotSetError,
  createGitHubClient,
  resolveGitHubToken,
  type GitHubClient,
  type Issue,
  type OpenPullRequest,
  type ResolveGitHubTokenInput,
  type ResolveGitHubTokenResult,
} from '../github/index.js';
import { parseRepositoryNameWithOwner } from '../orchestrator/index.js';
import {
  GhCommandError,
  StatusOptionNotFoundError,
  createProjectsClient,
  defaultGhRunner,
  updateProjectItemStatus,
  type GhRunner,
  type ProjectsClient,
} from '../projects/index.js';
import {
  createWorkspaceManager,
  defaultGitRunner,
  listIssueWorktrees,
  type GitRunner,
  type HookConfigMap,
  type IssueWorktree,
  type ListIssueWorktreesInput,
  type WorkspaceManager,
} from '../workspace/index.js';

import { shouldDeleteBranch } from './clean.js';
import { configHooksToHookConfigMap } from './hooks.js';

export type RetryCommandDeps = {
  cwd?: () => string;
  loadConfig?: (configPath?: string, options?: LoadConfigOptions) => Promise<Config>;
  resolveGitHubToken?: (input: ResolveGitHubTokenInput) => Promise<ResolveGitHubTokenResult>;
  setEnv?: (key: string, value: string) => void;
  createGitHubClient?: (token: string) => GitHubClient;
  createProjectsClient?: (token: string) => ProjectsClient;
  createWorkspaceManager?: (input: {
    repoRoot: string;
    workspaceRoot: string;
    hooks?: HookConfigMap;
  }) => WorkspaceManager;
  runGit?: GitRunner;
  runGh?: GhRunner;
  listIssueWorktrees?: (input: ListIssueWorktreesInput) => Promise<IssueWorktree[]>;
  pathExists?: (target: string) => Promise<boolean>;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<RetryCommandDeps> = {
  cwd: () => process.cwd(),
  loadConfig: (configPath, options) => loadConfig(configPath, options),
  resolveGitHubToken: (input) => resolveGitHubToken(input),
  setEnv: (key, value) => {
    process.env[key] = value;
  },
  createGitHubClient: (token) => createGitHubClient({ token }),
  createProjectsClient: (token) => createProjectsClient({ token }),
  createWorkspaceManager: (input) => createWorkspaceManager(input),
  runGit: defaultGitRunner,
  runGh: defaultGhRunner,
  listIssueWorktrees: (input) => listIssueWorktrees(input),
  pathExists: defaultPathExists,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code) as never,
};

type RetryOptions = {
  config?: string;
  dryRun: boolean;
  targetStatus?: string;
  force: boolean;
};

type RetryPlan = {
  issueNumber: number;
  issueTitle: string;
  itemId: string;
  projectId: string;
  currentStatus: string | null;
  targetStatus: string;
  willChangeStatus: boolean;
  worktreePath: string;
  worktreeExists: boolean;
  branch: string | null;
  branchDeletable: boolean;
  openPullRequests: readonly OpenPullRequest[];
};

export function createRetryCommand(deps: RetryCommandDeps = {}): Command {
  const resolved: Required<RetryCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('retry');
  cmd
    .description(
      '指定 Issue の Project Status を dispatch 対象状態に戻し、stale な worktree を cleanup して serve の次 tick で再 dispatch 可能にする',
    )
    .argument('<issue-number>', '再実行したい Issue 番号', parseIssueNumber)
    .option('--dry-run', '副作用ゼロで plan を表示するだけ', false)
    .option(
      '--target-status <status>',
      '書き戻し先の Project Status 名 (省略時は dispatch_statuses[0]、通常 Todo)',
    )
    .option('--force', 'open PR が存在していても続行する', false)
    .option(
      '-c, --config <path>',
      '設定ファイルのパス (省略時は cwd の .philharmonic/philharmonic.yaml、不在なら legacy philharmonic.yaml に fallback)',
    )
    .action(async (issueNumber: number, options: RetryOptions) => {
      await runRetry(issueNumber, options, resolved);
    });
  return cmd;
}

async function runRetry(
  issueNumber: number,
  options: RetryOptions,
  deps: Required<RetryCommandDeps>,
): Promise<void> {
  const cwd = deps.cwd();

  let config: Config;
  try {
    config = await deps.loadConfig(options.config, { cwd });
  } catch (error) {
    if (
      error instanceof ConfigFileNotFoundError ||
      error instanceof ConfigParseError ||
      error instanceof ConfigValidationError
    ) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  let token: string;
  try {
    const resolved = await deps.resolveGitHubToken({ source: config.github.tokenSource });
    token = resolved.token;
  } catch (error) {
    if (
      error instanceof GitHubTokenNotSetError ||
      error instanceof GhCliNotFoundError ||
      error instanceof GhCliNotAuthenticatedError
    ) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }
  // gh subprocess (project field-list / item-edit) も同じ token を env で拾えるようにする
  deps.setEnv(GITHUB_TOKEN_ENV, token);

  const githubClient = deps.createGitHubClient(token);
  const projectsClient = deps.createProjectsClient(token);

  const targetStatus = resolveTargetStatus(options.targetStatus, config.dispatchStatuses);

  let plan: RetryPlan;
  try {
    plan = await buildPlan({
      issueNumber,
      cwd,
      config,
      targetStatus,
      githubClient,
      projectsClient,
      runGit: deps.runGit,
      listIssueWorktrees: deps.listIssueWorktrees,
      pathExists: deps.pathExists,
    });
  } catch (error) {
    if (error instanceof RetryAbortError) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  writePlan(deps.stdout, plan, options.dryRun, options.force);

  if (plan.openPullRequests.length > 0 && !options.force) {
    deps.stderr.write(
      `aborting: ${plan.openPullRequests.length} open PR(s) reference this issue. ` +
        `merge/close them or pass --force to override.\n`,
    );
    deps.exit(1);
    return;
  }

  if (options.dryRun) {
    deps.stdout.write('\ndry-run: no changes applied\n');
    return;
  }

  if (!plan.worktreeExists && !plan.willChangeStatus) {
    deps.stdout.write(`\nnothing to do for issue=#${plan.issueNumber} (already at target)\n`);
    return;
  }

  const workspaceManager = deps.createWorkspaceManager({
    repoRoot: cwd,
    workspaceRoot: config.workspaceRoot,
    hooks: configHooksToHookConfigMap(config.hooks),
  });

  if (plan.worktreeExists) {
    try {
      await workspaceManager.cleanupWorkspace({
        taskKey: `issue-${plan.issueNumber}`,
        branch: plan.branchDeletable ? (plan.branch ?? undefined) : undefined,
        deleteBranch: plan.branchDeletable,
      });
      deps.stdout.write(`\nremoved worktree ${plan.worktreePath}\n`);
    } catch (error) {
      deps.stderr.write(`failed to cleanup worktree: ${describeError(error)}\n`);
      deps.exit(1);
      return;
    }
  }

  if (plan.willChangeStatus) {
    try {
      await updateProjectItemStatus(deps.runGh, {
        owner: config.owner,
        projectNumber: config.projectNumber,
        projectId: plan.projectId,
        itemId: plan.itemId,
        statusFieldName: config.statusField,
        targetStatus: plan.targetStatus,
      });
      deps.stdout.write(
        `updated status ${plan.currentStatus ?? '(none)'} -> ${plan.targetStatus}\n`,
      );
    } catch (error) {
      if (error instanceof StatusOptionNotFoundError || error instanceof GhCommandError) {
        deps.stderr.write(`failed to update status: ${error.message}\n`);
        deps.exit(1);
        return;
      }
      deps.stderr.write(`failed to update status: ${describeError(error)}\n`);
      deps.exit(1);
      return;
    }
  }

  deps.stdout.write(`done issue=#${plan.issueNumber}\n`);
}

type BuildPlanInput = {
  issueNumber: number;
  cwd: string;
  config: Config;
  targetStatus: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  runGit: GitRunner;
  listIssueWorktrees: (input: ListIssueWorktreesInput) => Promise<IssueWorktree[]>;
  pathExists: (target: string) => Promise<boolean>;
};

async function buildPlan(input: BuildPlanInput): Promise<RetryPlan> {
  const context = await input.projectsClient.fetchProjectContext({
    owner: input.config.owner,
    projectNumber: input.config.projectNumber,
    statusFieldName: input.config.statusField,
  });

  const candidate = context.candidates.find((c) => c.issueNumber === input.issueNumber);
  if (candidate === undefined) {
    throw new RetryAbortError(
      `issue #${input.issueNumber} is not in project ${input.config.owner}/#${input.config.projectNumber}`,
    );
  }

  const repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);

  const issue: Issue = await input.githubClient.getIssue({
    owner: repository.owner,
    repo: repository.name,
    issueNumber: input.issueNumber,
  });
  if (issue.state !== 'open') {
    throw new RetryAbortError(`issue #${input.issueNumber} is closed; cannot retry a closed issue`);
  }

  const branchPrefix = `feature/${input.issueNumber}-`;
  const openPullRequests = await input.githubClient.listOpenPullRequests({
    owner: repository.owner,
    repo: repository.name,
    headBranchPrefix: branchPrefix,
  });

  const taskKey = `issue-${input.issueNumber}`;
  const worktrees = await input.listIssueWorktrees({
    runGit: input.runGit,
    repoRoot: input.cwd,
    workspaceRoot: input.config.workspaceRoot,
  });
  const worktreeEntry = worktrees.find((wt) => wt.taskKey === taskKey);

  const workspacePath = worktreeEntry?.path ?? resolveExpectedWorkspacePath(input);
  const worktreeExists = worktreeEntry !== undefined ? true : await input.pathExists(workspacePath);
  const branch = worktreeEntry?.branch ?? null;
  const branchDeletable = shouldDeleteBranch(taskKey, branch);

  return {
    issueNumber: input.issueNumber,
    issueTitle: candidate.issueTitle,
    itemId: candidate.itemId,
    projectId: context.projectId,
    currentStatus: candidate.status,
    targetStatus: input.targetStatus,
    willChangeStatus: candidate.status !== input.targetStatus,
    worktreePath: workspacePath,
    worktreeExists,
    branch,
    branchDeletable,
    openPullRequests,
  };
}

function resolveExpectedWorkspacePath(input: BuildPlanInput): string {
  // worktree が git worktree list に居なくても、ディレクトリだけ残っているケースを拾うため
  // expected path で fs.stat する。WorkspaceManager 経由で生成する path と同じ規則
  // (workspace/paths.ts の resolveWorkspacePath / resolveWorkspaceRoot に揃える)。
  const taskKey = `issue-${input.issueNumber}`;
  return path.resolve(input.cwd, input.config.workspaceRoot, taskKey);
}

function writePlan(
  stdout: NodeJS.WritableStream,
  plan: RetryPlan,
  dryRun: boolean,
  force: boolean,
): void {
  const header = dryRun
    ? `dry-run plan for issue #${plan.issueNumber}`
    : `plan for issue #${plan.issueNumber}`;
  stdout.write(`${header}\n`);
  stdout.write(`  title:          ${plan.issueTitle}\n`);
  stdout.write(`  current status: ${plan.currentStatus ?? '(none)'}\n`);
  if (plan.willChangeStatus) {
    stdout.write(
      `  target status:  ${plan.targetStatus}  (will update via gh project item-edit)\n`,
    );
  } else {
    stdout.write(`  target status:  ${plan.targetStatus}  (no change)\n`);
  }
  if (plan.worktreeExists) {
    stdout.write(`  worktree:       ${plan.worktreePath}  (will cleanup)\n`);
  } else {
    stdout.write(`  worktree:       ${plan.worktreePath}  (none)\n`);
  }
  if (plan.branch !== null) {
    if (plan.branchDeletable) {
      stdout.write(`  branch:         ${plan.branch}  (will delete)\n`);
    } else {
      stdout.write(
        `  branch:         ${plan.branch}  (skip delete: does not match feature/${plan.issueNumber}-)\n`,
      );
    }
  } else {
    stdout.write(`  branch:         (detached or not in worktree list)\n`);
  }
  if (plan.openPullRequests.length === 0) {
    stdout.write(`  open PRs:       none\n`);
  } else {
    const noun = plan.openPullRequests.length === 1 ? 'open PR' : 'open PRs';
    const suffix = force ? ' (continuing because --force)' : ' (use --force to override)';
    stdout.write(`  open PRs:       ${plan.openPullRequests.length} ${noun}${suffix}\n`);
    for (const pr of plan.openPullRequests) {
      stdout.write(`    - #${pr.number} head=${pr.headRef} ${pr.htmlUrl}\n`);
    }
  }
}

function resolveTargetStatus(
  cliValue: string | undefined,
  dispatchStatuses: readonly string[],
): string {
  if (cliValue !== undefined) {
    const trimmed = cliValue.trim();
    if (trimmed === '') {
      throw new InvalidArgumentError('--target-status は空文字以外で指定してください');
    }
    return trimmed;
  }
  return dispatchStatuses[0] ?? 'Todo';
}

function parseIssueNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('issue-number は正の整数で指定してください');
  }
  return parsed;
}

class RetryAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryAbortError';
  }
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
