import { Command, InvalidArgumentError } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  type Config,
} from '../config/index.js';
import {
  createWorkspaceManager,
  defaultGitRunner,
  type GitRunner,
  type IssueWorktree,
  type ListIssueWorktreesInput,
  type WorkspaceManager,
  listIssueWorktrees,
  selectExpiredWorktrees,
} from '../workspace/index.js';

export type CleanCommandDeps = {
  cwd?: () => string;
  now?: () => Date;
  loadConfig?: (configPath?: string, options?: { cwd?: string }) => Promise<Config>;
  listIssueWorktrees?: (input: ListIssueWorktreesInput) => Promise<IssueWorktree[]>;
  createWorkspaceManager?: (input: { repoRoot: string; workspaceRoot: string }) => WorkspaceManager;
  runGit?: GitRunner;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<CleanCommandDeps> = {
  cwd: () => process.cwd(),
  now: () => new Date(),
  loadConfig: (configPath, options) => loadConfig(configPath, options),
  listIssueWorktrees: (input) => listIssueWorktrees(input),
  createWorkspaceManager: (input) => createWorkspaceManager(input),
  runGit: defaultGitRunner,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code) as never,
};

type CleanOptions = {
  config?: string;
  retentionDays?: number;
  dryRun: boolean;
};

export function createCleanCommand(deps: CleanCommandDeps = {}): Command {
  const resolved: Required<CleanCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('clean');
  cmd
    .description(
      'retention 経過済みの issue-* worktree とローカルブランチを掃除する (失敗 worktree のクリーンアップ用)',
    )
    .option('-c, --config <path>', '設定ファイルのパス (省略時は cwd の philharmonic.yaml)')
    .option(
      '--retention-days <days>',
      'mtime からの経過日数の閾値 (省略時は philharmonic.yaml の clean_retention_days)',
      parseRetentionDays,
    )
    .option('--dry-run', '削除対象を表示するだけで実際には削除しない', false)
    .action(async (options: CleanOptions) => {
      await runClean(options, resolved);
    });
  return cmd;
}

async function runClean(options: CleanOptions, deps: Required<CleanCommandDeps>): Promise<void> {
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

  const retentionDays = options.retentionDays ?? config.cleanRetentionDays;
  const repoRoot = cwd;

  let candidates: IssueWorktree[];
  try {
    candidates = await deps.listIssueWorktrees({
      runGit: deps.runGit,
      repoRoot,
      workspaceRoot: config.workspaceRoot,
    });
  } catch (error) {
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  const expired = selectExpiredWorktrees(candidates, { now: deps.now(), retentionDays });

  if (expired.length === 0) {
    deps.stdout.write(`no worktrees to clean (retention=${retentionDays}d)\n`);
    return;
  }

  if (options.dryRun) {
    deps.stdout.write(`dry-run: ${expired.length} worktree(s) would be removed\n`);
    for (const wt of expired) {
      deps.stdout.write(`  ${formatCandidate(wt, deps.now())}\n`);
    }
    return;
  }

  const manager = deps.createWorkspaceManager({
    repoRoot,
    workspaceRoot: config.workspaceRoot,
  });

  let removed = 0;
  let failed = 0;
  for (const wt of expired) {
    try {
      const deleteBranch = shouldDeleteBranch(wt.taskKey, wt.branch);
      if (wt.branch !== null && !deleteBranch) {
        deps.stderr.write(
          `skip branch delete for ${wt.taskKey}: branch '${wt.branch}' does not match feature/<issue>- pattern\n`,
        );
      }
      await manager.cleanupWorkspace({
        taskKey: wt.taskKey,
        branch: deleteBranch ? (wt.branch ?? undefined) : undefined,
        deleteBranch,
      });
      deps.stdout.write(`removed ${formatCandidate(wt, deps.now())}\n`);
      removed += 1;
    } catch (error) {
      deps.stderr.write(`failed to remove ${wt.taskKey}: ${describeError(error)}\n`);
      failed += 1;
    }
  }

  deps.stdout.write(`done removed=${removed} failed=${failed}\n`);
  if (failed > 0) {
    deps.exit(1);
  }
}

const TASK_KEY_PATTERN = /^issue-([1-9][0-9]*)$/;

export function shouldDeleteBranch(taskKey: string, branch: string | null): boolean {
  if (branch === null) return false;
  const match = TASK_KEY_PATTERN.exec(taskKey);
  if (match === null) return false;
  return branch.startsWith(`feature/${match[1]}-`);
}

function formatCandidate(wt: IssueWorktree, now: Date): string {
  const ageDays = Math.floor((now.getTime() - wt.mtimeMs) / (24 * 60 * 60 * 1000));
  const branch = wt.branch ?? '(detached)';
  return `${wt.taskKey} branch=${branch} age=${ageDays}d path=${wt.path}`;
}

function parseRetentionDays(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError('--retention-days は 0 以上の数値で指定してください');
  }
  return n;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
