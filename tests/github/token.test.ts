import { describe, expect, it } from 'vitest';

import { GitHubTokenNotSetError, getGitHubTokenFromEnv } from '../../src/github/index.js';

describe('getGitHubTokenFromEnv', () => {
  it('GITHUB_TOKEN が設定されていればそのまま返す', () => {
    expect(getGitHubTokenFromEnv({ GITHUB_TOKEN: 'ghp_dummy' })).toBe('ghp_dummy');
  });

  it('GITHUB_TOKEN が未設定なら GitHubTokenNotSetError を throw する', () => {
    expect(() => getGitHubTokenFromEnv({})).toThrowError(GitHubTokenNotSetError);
  });

  it('GITHUB_TOKEN が空文字列でも GitHubTokenNotSetError を throw する', () => {
    expect(() => getGitHubTokenFromEnv({ GITHUB_TOKEN: '' })).toThrowError(GitHubTokenNotSetError);
  });

  it('GITHUB_TOKEN が空白のみでも GitHubTokenNotSetError を throw する', () => {
    expect(() => getGitHubTokenFromEnv({ GITHUB_TOKEN: '   ' })).toThrowError(
      GitHubTokenNotSetError,
    );
  });
});
