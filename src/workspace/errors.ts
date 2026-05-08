export class PathTraversalError extends Error {
  constructor(
    public readonly taskKey: string,
    public readonly workspaceRoot: string,
    public readonly resolvedPath: string,
  ) {
    super(
      `task key '${taskKey}' は workspace root '${workspaceRoot}' 配下に解決されませんでした (resolved: '${resolvedPath}')`,
    );
    this.name = 'PathTraversalError';
  }
}

export class InvalidTaskKeyError extends Error {
  constructor(
    public readonly taskKey: string,
    public readonly reason: string,
  ) {
    super(`task key '${taskKey}' は不正です: ${reason}`);
    this.name = 'InvalidTaskKeyError';
  }
}

export class InvalidBranchNameError extends Error {
  constructor(
    public readonly branch: string,
    public readonly reason: string,
  ) {
    super(`branch name '${branch}' は不正です: ${reason}`);
    this.name = 'InvalidBranchNameError';
  }
}

export class WorkspaceConflictError extends Error {
  constructor(
    public readonly taskKey: string,
    public readonly conflictPath: string,
    public readonly reason:
      | 'worktree_path_in_use'
      | 'branch_already_exists'
      | 'branch_mismatch'
      | 'worktree_path_missing',
    public readonly detail?: string,
  ) {
    super(
      `workspace '${taskKey}' で衝突が発生しました (reason: ${reason}, path: ${conflictPath})${
        detail !== undefined ? `: ${detail}` : ''
      }`,
    );
    this.name = 'WorkspaceConflictError';
  }
}

export class GitCommandError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly stdout: string,
    public readonly cwd: string,
  ) {
    const argsLabel = args.join(' ');
    super(
      `git ${argsLabel} が失敗しました (exitCode: ${exitCode ?? 'null'}, cwd: ${cwd}): ${stderr.trim()}`,
    );
    this.name = 'GitCommandError';
  }
}
