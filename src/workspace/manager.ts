import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { GitCommandError, WorkspaceConflictError } from './errors.js';
import { defaultGitRunner, parseWorktreeList, type GitRunner } from './git.js';
import { resolveWorkspacePath, resolveWorkspaceRoot } from './paths.js';
import { sanitizeBranchName } from './sanitize.js';

export type WorkspaceManagerOptions = {
  repoRoot: string;
  workspaceRoot: string;
  runGit?: GitRunner;
};

export type CreateWorkspaceInput = {
  taskKey: string;
  branch: string;
  baseRef: string;
  reuse?: boolean;
};

export type CleanupWorkspaceInput = {
  taskKey: string;
  branch?: string;
  deleteBranch?: boolean;
};

export type Workspace = {
  taskKey: string;
  path: string;
  branch: string;
  reused: boolean;
};

export type WorkspaceManager = {
  resolveWorkspacePath(taskKey: string): string;
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  cleanupWorkspace(input: CleanupWorkspaceInput): Promise<void>;
};

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  const repoRoot = options.repoRoot;
  const workspaceRootAbs = resolveWorkspaceRoot(repoRoot, options.workspaceRoot);
  const runGit = options.runGit ?? defaultGitRunner;

  return {
    resolveWorkspacePath(taskKey) {
      return resolveWorkspacePath(workspaceRootAbs, taskKey);
    },

    async createWorkspace(input) {
      const reuse = input.reuse ?? true;
      const branch = sanitizeBranchName(input.branch);
      const worktreePath = resolveWorkspacePath(workspaceRootAbs, input.taskKey);

      await mkdir(workspaceRootAbs, { recursive: true });

      const existing = await findExistingWorktree(runGit, repoRoot, worktreePath);

      if (existing !== null) {
        if (!reuse) {
          throw new WorkspaceConflictError(
            input.taskKey,
            worktreePath,
            'worktree_path_in_use',
            `既存 worktree が登録されています (branch: ${existing.branch ?? 'detached'})`,
          );
        }
        if (existing.branch !== branch) {
          throw new WorkspaceConflictError(
            input.taskKey,
            worktreePath,
            'branch_mismatch',
            `期待 branch: ${branch}, 既存 branch: ${existing.branch ?? 'detached'}`,
          );
        }
        const dirExists = await pathExists(worktreePath);
        if (!dirExists) {
          throw new WorkspaceConflictError(
            input.taskKey,
            worktreePath,
            'worktree_path_missing',
            'git は worktree を認識しているがディレクトリが存在しない',
          );
        }
        return { taskKey: input.taskKey, path: worktreePath, branch, reused: true };
      }

      if (!reuse && (await branchExists(runGit, repoRoot, branch))) {
        throw new WorkspaceConflictError(
          input.taskKey,
          worktreePath,
          'branch_already_exists',
          `同名のローカルブランチ '${branch}' が既存`,
        );
      }

      await addWorktree(runGit, repoRoot, worktreePath, branch, input.baseRef);

      return { taskKey: input.taskKey, path: worktreePath, branch, reused: false };
    },

    async cleanupWorkspace(input) {
      const worktreePath = resolveWorkspacePath(workspaceRootAbs, input.taskKey);

      const existing = await findExistingWorktree(runGit, repoRoot, worktreePath);
      if (existing !== null) {
        await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
      }

      if (input.deleteBranch === true && input.branch !== undefined) {
        const branch = sanitizeBranchName(input.branch);
        if (await branchExists(runGit, repoRoot, branch)) {
          await runGit(['branch', '-D', branch], { cwd: repoRoot });
        }
      }
    },
  };
}

async function findExistingWorktree(
  runGit: GitRunner,
  repoRoot: string,
  worktreePath: string,
): Promise<{ branch: string | null } | null> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const entries = parseWorktreeList(stdout);
  const normalizedTarget = path.resolve(worktreePath);
  for (const entry of entries) {
    if (path.resolve(entry.path) === normalizedTarget) {
      return { branch: entry.branch };
    }
  }
  return null;
}

async function branchExists(runGit: GitRunner, repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot });
    return true;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return false;
    }
    throw error;
  }
}

async function addWorktree(
  runGit: GitRunner,
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  await runGit(['worktree', 'add', worktreePath, '-b', branch, baseRef], {
    cwd: repoRoot,
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
