import path from 'node:path';

import { InvalidTaskKeyError, PathTraversalError } from './errors.js';

const FORBIDDEN_TASK_KEY_CHARS = ['\\', '\0'];

export function resolveWorkspaceRoot(repoRoot: string, workspaceRoot: string): string {
  if (!path.isAbsolute(repoRoot)) {
    throw new InvalidTaskKeyError(repoRoot, 'repoRoot は絶対パスである必要があります');
  }
  return path.resolve(repoRoot, workspaceRoot);
}

export function resolveWorkspacePath(workspaceRootAbs: string, taskKey: string): string {
  validateTaskKey(taskKey);

  const candidate = path.resolve(workspaceRootAbs, taskKey);
  const rel = path.relative(workspaceRootAbs, candidate);

  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathTraversalError(taskKey, workspaceRootAbs, candidate);
  }

  return candidate;
}

function validateTaskKey(taskKey: string): void {
  if (typeof taskKey !== 'string') {
    throw new InvalidTaskKeyError(String(taskKey), 'string ではない');
  }
  const trimmed = taskKey.trim();
  if (trimmed === '') {
    throw new InvalidTaskKeyError(taskKey, '空文字または whitespace のみ');
  }
  if (path.isAbsolute(taskKey)) {
    throw new InvalidTaskKeyError(taskKey, '絶対パスは指定できません');
  }
  for (const forbidden of FORBIDDEN_TASK_KEY_CHARS) {
    if (taskKey.includes(forbidden)) {
      throw new InvalidTaskKeyError(taskKey, `禁止文字 (${JSON.stringify(forbidden)}) を含む`);
    }
  }
}
