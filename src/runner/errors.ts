export class ClaudeNotInstalledError extends Error {
  public readonly code = 'claude_not_installed';

  constructor(public readonly command: string) {
    super(
      `Claude Code CLI ('${command}') が見つかりませんでした。Claude Code をインストールしてから再実行してください`,
    );
    this.name = 'ClaudeNotInstalledError';
  }
}

export class ClaudeRunnerSpawnError extends Error {
  constructor(
    public readonly command: string,
    public override readonly cause: unknown,
  ) {
    super(`Claude Code subprocess の起動に失敗しました ('${command}'): ${formatCause(cause)}`);
    this.name = 'ClaudeRunnerSpawnError';
  }
}

export class InvalidSessionIdError extends Error {
  constructor(public readonly sessionId: string) {
    super(`sessionId は UUID 形式で指定してください (受け取った値: '${sessionId}')`);
    this.name = 'InvalidSessionIdError';
  }
}

export class InvalidRunOptionsError extends Error {
  constructor(public readonly reason: string) {
    super(`runClaude のオプションが不正です: ${reason}`);
    this.name = 'InvalidRunOptionsError';
  }
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
