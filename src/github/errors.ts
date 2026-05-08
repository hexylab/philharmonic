export const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';

export class GitHubTokenNotSetError extends Error {
  public readonly code = 'github_token_not_set';

  constructor() {
    super(
      `環境変数 ${GITHUB_TOKEN_ENV} が設定されていません。GitHub PAT を ${GITHUB_TOKEN_ENV} に設定してから再実行してください`,
    );
    this.name = 'GitHubTokenNotSetError';
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
