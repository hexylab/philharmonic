export class ConfigFileNotFoundError extends Error {
  public readonly code = 'config_file_not_found';

  constructor(public readonly path: string) {
    super(`philharmonic.yaml が見つかりませんでした: ${path}`);
    this.name = 'ConfigFileNotFoundError';
  }
}

export class ConfigParseError extends Error {
  public readonly code = 'config_parse_error';

  constructor(
    public readonly path: string,
    public readonly reason: string,
    public readonly line: number | null,
  ) {
    super(formatParseMessage(path, reason, line));
    this.name = 'ConfigParseError';
  }
}

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export class ConfigValidationError extends Error {
  public readonly code = 'config_validation_error';

  constructor(
    public readonly path: string,
    public readonly issues: readonly ConfigValidationIssue[],
  ) {
    super(formatValidationMessage(path, issues));
    this.name = 'ConfigValidationError';
  }
}

export function formatConfigError(error: unknown): string {
  if (
    error instanceof ConfigFileNotFoundError ||
    error instanceof ConfigParseError ||
    error instanceof ConfigValidationError
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    return `設定の読み込みに失敗しました: ${error.message}`;
  }
  return `設定の読み込みに失敗しました: ${String(error)}`;
}

function formatParseMessage(path: string, reason: string, line: number | null): string {
  const location = line !== null ? `${path}:${line}` : path;
  return `philharmonic.yaml の YAML パースに失敗しました (${location}): ${reason}`;
}

function formatValidationMessage(path: string, issues: readonly ConfigValidationIssue[]): string {
  const lines = issues.map((issue) => {
    const fieldPath = issue.path.length === 0 ? '(root)' : issue.path;
    return `  - ${fieldPath}: ${issue.message}`;
  });
  return `philharmonic.yaml の検証に失敗しました (${path}):\n${lines.join('\n')}`;
}
