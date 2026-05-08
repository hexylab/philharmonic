import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GitCommandError } from './errors.js';

const execFileAsync = promisify(execFile);

export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultGitRunner: GitRunner = async (args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], {
      cwd: opts.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    throw new GitCommandError(
      args,
      exitCode,
      typeof e.stderr === 'string' ? e.stderr : '',
      typeof e.stdout === 'string' ? e.stdout : '',
      opts.cwd,
    );
  }
};

export type WorktreeEntry = {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const lines = porcelain.split('\n');
  for (const line of lines) {
    if (line === '') {
      if (current?.path !== undefined) {
        entries.push(finalize(current));
      }
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current?.path !== undefined) {
        entries.push(finalize(current));
      }
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (current === null) continue;
    if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('branch ')) {
      current.branch = stripRefsHeads(line.slice('branch '.length));
    }
  }
  if (current?.path !== undefined) {
    entries.push(finalize(current));
  }
  return entries;
}

function finalize(partial: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: partial.path ?? '',
    branch: partial.branch ?? null,
    bare: partial.bare ?? false,
    detached: partial.detached ?? false,
  };
}

function stripRefsHeads(ref: string): string {
  const prefix = 'refs/heads/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}
