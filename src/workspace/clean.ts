import { stat } from 'node:fs/promises';
import path from 'node:path';

import { type GitRunner, parseWorktreeList } from './git.js';
import { resolveWorkspaceRoot } from './paths.js';

export type IssueWorktree = {
  taskKey: string;
  path: string;
  branch: string | null;
  mtimeMs: number;
};

export type StatFn = (target: string) => Promise<{ mtimeMs: number }>;

export type ListIssueWorktreesInput = {
  runGit: GitRunner;
  repoRoot: string;
  workspaceRoot: string;
  statFn?: StatFn;
};

const ISSUE_TASK_KEY_PATTERN = /^issue-[1-9][0-9]*$/;

export async function listIssueWorktrees(input: ListIssueWorktreesInput): Promise<IssueWorktree[]> {
  const { runGit, repoRoot } = input;
  const workspaceRootAbs = resolveWorkspaceRoot(repoRoot, input.workspaceRoot);
  const statFn: StatFn = input.statFn ?? defaultStatFn;

  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const entries = parseWorktreeList(stdout);

  const result: IssueWorktree[] = [];
  for (const entry of entries) {
    const entryPath = path.resolve(entry.path);
    const rel = path.relative(workspaceRootAbs, entryPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const taskKey = path.basename(entryPath);
    if (!ISSUE_TASK_KEY_PATTERN.test(taskKey)) continue;

    let mtimeMs: number;
    try {
      const stats = await statFn(entryPath);
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }

    result.push({ taskKey, path: entryPath, branch: entry.branch, mtimeMs });
  }
  return result;
}

export type SelectExpiredOptions = {
  now: Date;
  retentionDays: number;
};

export function selectExpiredWorktrees(
  worktrees: readonly IssueWorktree[],
  options: SelectExpiredOptions,
): IssueWorktree[] {
  const retentionMs = options.retentionDays * 24 * 60 * 60 * 1000;
  const threshold = options.now.getTime() - retentionMs;
  return worktrees.filter((wt) => wt.mtimeMs <= threshold);
}

const defaultStatFn: StatFn = async (target) => {
  const stats = await stat(target);
  return { mtimeMs: stats.mtimeMs };
};
