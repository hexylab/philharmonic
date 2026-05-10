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
  type ResolveGitHubTokenInput,
  type ResolveGitHubTokenResult,
} from '../github/index.js';
import { parseRepositoryNameWithOwner } from '../orchestrator/index.js';
import { createProjectsClient, type Candidate, type ProjectsClient } from '../projects/index.js';
import {
  createWorkspaceManager,
  defaultGitRunner,
  executeStaleCleanup,
  listIssueWorktrees,
  planStaleWorktreeCleanup,
  type GitRunner,
  type HookConfigMap,
  type IssueWorktree,
  type ListIssueWorktreesInput,
  type StaleCleanupCandidate,
  type StaleCleanupPlan,
  type StaleCleanupSkip,
  type WorkspaceManager,
} from '../workspace/index.js';

import { configHooksToHookConfigMap } from './hooks.js';

export type CleanStaleCommandDeps = {
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
  listIssueWorktrees?: (input: ListIssueWorktreesInput) => Promise<IssueWorktree[]>;
  serveLockExists?: (repoRoot: string) => Promise<boolean>;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<CleanStaleCommandDeps> = {
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
  listIssueWorktrees: (input) => listIssueWorktrees(input),
  serveLockExists: defaultServeLockExists,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code) as never,
};

type CleanStaleOptions = {
  config?: string;
  dryRun: boolean;
  force: boolean;
  terminalStatus?: string[];
};

export function createCleanStaleCommand(deps: CleanStaleCommandDeps = {}): Command {
  const resolved: Required<CleanStaleCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('clean-stale');
  cmd
    .description(
      'terminal state (Done 等) や closed Issue に対応する stale worktree を、safety 条件を満たす場合のみ cleanup する',
    )
    .option(
      '-c, --config <path>',
      '設定ファイルのパス (省略時は cwd の .philharmonic/philharmonic.yaml、不在なら legacy philharmonic.yaml に fallback)',
    )
    .option('--dry-run', '削除対象を表示するだけで実際には削除しない', false)
    .option(
      '--terminal-status <status>',
      'terminal とみなす Project Status (繰り返し指定可。省略時は config の terminal_statuses)',
      collectTerminalStatus,
    )
    .option('--force', 'serve daemon が動作中 (serve.lock 存在) でも続行する', false)
    .action(async (options: CleanStaleOptions) => {
      await runCleanStale(options, resolved);
    });
  return cmd;
}

async function runCleanStale(
  options: CleanStaleOptions,
  deps: Required<CleanStaleCommandDeps>,
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

  if (!options.force) {
    let locked = false;
    try {
      locked = await deps.serveLockExists(cwd);
    } catch (error) {
      deps.stderr.write(`failed to check serve.lock: ${describeError(error)}\n`);
      deps.exit(1);
      return;
    }
    if (locked) {
      deps.stderr.write(
        `aborting: .philharmonic/serve.lock が存在します (serve daemon が動作中の可能性)。` +
          ` --force を付けて続行してください。\n`,
      );
      deps.exit(1);
      return;
    }
  }

  let token: string;
  try {
    const resolvedToken = await deps.resolveGitHubToken({ source: config.github.tokenSource });
    token = resolvedToken.token;
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
  deps.setEnv(GITHUB_TOKEN_ENV, token);

  const githubClient = deps.createGitHubClient(token);
  const projectsClient = deps.createProjectsClient(token);

  const terminalStatuses =
    options.terminalStatus !== undefined && options.terminalStatus.length > 0
      ? options.terminalStatus
      : config.terminalStatuses;

  let worktrees: IssueWorktree[];
  let candidates: readonly Candidate[];
  try {
    worktrees = await deps.listIssueWorktrees({
      runGit: deps.runGit,
      repoRoot: cwd,
      workspaceRoot: config.workspaceRoot,
    });
    candidates = await projectsClient.fetchProjectCandidates({
      owner: config.owner,
      projectNumber: config.projectNumber,
      statusFieldName: config.statusField,
    });
  } catch (error) {
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  const plan = await planStaleWorktreeCleanup({
    worktrees,
    candidates,
    terminalStatuses,
    githubClient,
    parseRepository: parseRepositoryNameWithOwner,
  });

  writePlan(deps.stdout, plan, options.dryRun, terminalStatuses);

  if (options.dryRun) {
    deps.stdout.write('\ndry-run: no changes applied\n');
    return;
  }

  if (plan.cleanups.length === 0) {
    deps.stdout.write('\nnothing to remove\n');
    return;
  }

  const workspaceManager = deps.createWorkspaceManager({
    repoRoot: cwd,
    workspaceRoot: config.workspaceRoot,
    hooks: configHooksToHookConfigMap(config.hooks),
  });

  const result = await executeStaleCleanup({
    plan: { cleanups: plan.cleanups, skips: [] },
    workspaceManager,
  });

  for (const outcome of result.outcomes) {
    const c = outcome.candidate;
    if (outcome.kind === 'removed') {
      deps.stdout.write(
        `removed ${c.worktree.taskKey} status=${c.status ?? '(none)'} reason=${c.reason} path=${c.worktree.path}\n`,
      );
    } else {
      deps.stderr.write(`failed ${c.worktree.taskKey}: ${outcome.error}\n`);
    }
  }

  deps.stdout.write(
    `\ndone removed=${result.removed} failed=${result.failed} skipped=${plan.skips.length}\n`,
  );
  if (result.failed > 0) {
    deps.exit(1);
  }
}

function writePlan(
  stdout: NodeJS.WritableStream,
  plan: StaleCleanupPlan,
  dryRun: boolean,
  terminalStatuses: readonly string[],
): void {
  const header = dryRun ? 'dry-run plan' : 'plan';
  stdout.write(`${header} (terminal_statuses=${terminalStatuses.join(',')}):\n`);
  if (plan.cleanups.length === 0) {
    stdout.write('  cleanups: (none)\n');
  } else {
    stdout.write(`  cleanups: ${plan.cleanups.length}\n`);
    for (const c of plan.cleanups) {
      stdout.write(`    ${formatCleanup(c)}\n`);
    }
  }
  if (plan.skips.length === 0) {
    stdout.write('  skips:    (none)\n');
  } else {
    stdout.write(`  skips:    ${plan.skips.length}\n`);
    for (const s of plan.skips) {
      stdout.write(`    ${formatSkip(s)}\n`);
    }
  }
}

function formatCleanup(c: StaleCleanupCandidate): string {
  const branch = c.worktree.branch ?? '(detached)';
  const branchAction = c.branchDeletable ? 'will delete' : 'skip delete';
  return `${c.worktree.taskKey} status=${c.status ?? '(none)'} reason=${c.reason} branch=${branch} (${branchAction}) path=${c.worktree.path}`;
}

function formatSkip(s: StaleCleanupSkip): string {
  const branch = s.worktree.branch ?? '(detached)';
  const suffix =
    s.openPullRequests.length > 0
      ? ` openPRs=${s.openPullRequests.map((pr) => `#${pr.number}`).join(',')}`
      : '';
  return `${s.worktree.taskKey} status=${s.status ?? '(none)'} reason=${s.reason} branch=${branch}${suffix}`;
}

function collectTerminalStatus(value: string, previous: string[] | undefined): string[] {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new InvalidArgumentError('--terminal-status は空文字以外で指定してください');
  }
  return [...(previous ?? []), trimmed];
}

async function defaultServeLockExists(repoRoot: string): Promise<boolean> {
  const lockPath = path.resolve(repoRoot, '.philharmonic', 'serve.lock');
  const { access } = await import('node:fs/promises');
  try {
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
