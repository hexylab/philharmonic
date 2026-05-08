import { GITHUB_TOKEN_ENV, GitHubTokenNotSetError } from './errors.js';

export { GITHUB_TOKEN_ENV };

export function getGitHubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[GITHUB_TOKEN_ENV];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitHubTokenNotSetError();
  }
  return value;
}
