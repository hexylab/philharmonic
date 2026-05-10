export const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';
export const GITHUB_TOKEN_FALLBACK_ENV = 'GH_TOKEN';

export class GitHubTokenNotSetError extends Error {
  public readonly code = 'github_token_not_set';

  constructor() {
    super(
      `環境変数 ${GITHUB_TOKEN_ENV} / ${GITHUB_TOKEN_FALLBACK_ENV} が設定されていません。GitHub PAT を ${GITHUB_TOKEN_ENV} に設定するか、ホストで gh auth login を実行してから再実行してください`,
    );
    this.name = 'GitHubTokenNotSetError';
  }
}

export class GhCliNotFoundError extends Error {
  public readonly code = 'gh_cli_not_found';

  constructor() {
    super(
      `gh コマンドが見つかりません。GitHub CLI をインストール (https://cli.github.com/) するか、${GITHUB_TOKEN_ENV} を直接設定してから再実行してください`,
    );
    this.name = 'GhCliNotFoundError';
  }
}

export class GhCliNotAuthenticatedError extends Error {
  public readonly code = 'gh_cli_not_authenticated';

  constructor(stderrTail: string) {
    super(
      [
        'gh auth token から GitHub token を取得できませんでした。`gh auth login` で認証してから再実行してください',
        stderrTail.trim().length === 0 ? null : `gh stderr: ${stderrTail.trim()}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    this.name = 'GhCliNotAuthenticatedError';
  }
}

export type GitHubApiErrorOptions = {
  status: number | null;
  responseBody: unknown;
  method: string | null;
  url: string | null;
  cause?: unknown;
};

export class GitHubApiError extends Error {
  public readonly code = 'github_api_error';
  public readonly status: number | null;
  public readonly responseBody: unknown;
  public readonly method: string | null;
  public readonly url: string | null;

  constructor(message: string, options: GitHubApiErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GitHubApiError';
    this.status = options.status;
    this.responseBody = options.responseBody;
    this.method = options.method;
    this.url = options.url;
  }
}
