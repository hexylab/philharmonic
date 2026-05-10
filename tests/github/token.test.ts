import { describe, expect, it, vi } from 'vitest';

import {
  GhCliNotAuthenticatedError,
  GhCliNotFoundError,
  GitHubTokenNotSetError,
  getGitHubTokenFromEnv,
  resolveGitHubToken,
  type GhAuthTokenRunner,
} from '../../src/github/index.js';

describe('getGitHubTokenFromEnv (compat)', () => {
  it('GITHUB_TOKEN が設定されていればそのまま返す', () => {
    expect(getGitHubTokenFromEnv({ GITHUB_TOKEN: 'ghp_dummy' })).toBe('ghp_dummy');
  });

  it('GH_TOKEN にも fallback する (#68)', () => {
    expect(getGitHubTokenFromEnv({ GH_TOKEN: 'ghp_dummy' })).toBe('ghp_dummy');
  });

  it('GITHUB_TOKEN / GH_TOKEN が共に未設定なら GitHubTokenNotSetError を throw する', () => {
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

describe('resolveGitHubToken — source: env (#68)', () => {
  it('GITHUB_TOKEN があれば env 経由で返し、gh は呼ばない', async () => {
    const runGhAuthToken = vi.fn();
    const result = await resolveGitHubToken({
      source: 'env',
      env: { GITHUB_TOKEN: 'ghp_env' },
      runGhAuthToken: runGhAuthToken as unknown as GhAuthTokenRunner,
    });
    expect(result).toEqual({ token: 'ghp_env', origin: 'env' });
    expect(runGhAuthToken).not.toHaveBeenCalled();
  });

  it('GH_TOKEN にも fallback する', async () => {
    const result = await resolveGitHubToken({
      source: 'env',
      env: { GH_TOKEN: 'ghp_gh_env' },
      runGhAuthToken: vi.fn() as unknown as GhAuthTokenRunner,
    });
    expect(result).toEqual({ token: 'ghp_gh_env', origin: 'env' });
  });

  it('env が無ければ GitHubTokenNotSetError (gh には fallback しない)', async () => {
    const runGhAuthToken = vi.fn();
    await expect(
      resolveGitHubToken({
        source: 'env',
        env: {},
        runGhAuthToken: runGhAuthToken as unknown as GhAuthTokenRunner,
      }),
    ).rejects.toBeInstanceOf(GitHubTokenNotSetError);
    expect(runGhAuthToken).not.toHaveBeenCalled();
  });
});

describe('resolveGitHubToken — source: gh (#68)', () => {
  it('gh auth token が成功すれば trim 済み token を返す', async () => {
    const runGhAuthToken = vi.fn(async () => ({
      stdout: 'gho_from_gh\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await resolveGitHubToken({
      source: 'gh',
      env: { GITHUB_TOKEN: 'env_should_be_ignored' },
      runGhAuthToken,
    });
    expect(result).toEqual({ token: 'gho_from_gh', origin: 'gh' });
    expect(runGhAuthToken).toHaveBeenCalledTimes(1);
  });

  it('gh が ENOENT で起動できなければ GhCliNotFoundError', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const runGhAuthToken = vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: -1,
      spawnError: enoent as NodeJS.ErrnoException,
    }));
    await expect(
      resolveGitHubToken({ source: 'gh', env: {}, runGhAuthToken }),
    ).rejects.toBeInstanceOf(GhCliNotFoundError);
  });

  it('gh が exit !=0 (未ログイン等) なら GhCliNotAuthenticatedError', async () => {
    const runGhAuthToken = vi.fn(async () => ({
      stdout: '',
      stderr: 'You are not logged in',
      exitCode: 1,
    }));
    await expect(
      resolveGitHubToken({ source: 'gh', env: {}, runGhAuthToken }),
    ).rejects.toBeInstanceOf(GhCliNotAuthenticatedError);
  });

  it('gh が exit 0 でも空 stdout なら GhCliNotAuthenticatedError', async () => {
    const runGhAuthToken = vi.fn(async () => ({
      stdout: '   \n',
      stderr: '',
      exitCode: 0,
    }));
    await expect(
      resolveGitHubToken({ source: 'gh', env: {}, runGhAuthToken }),
    ).rejects.toBeInstanceOf(GhCliNotAuthenticatedError);
  });
});

describe('resolveGitHubToken — source: auto (#68)', () => {
  it('GITHUB_TOKEN があれば env 経路で返し、gh は呼ばない', async () => {
    const runGhAuthToken = vi.fn();
    const result = await resolveGitHubToken({
      source: 'auto',
      env: { GITHUB_TOKEN: 'env_token' },
      runGhAuthToken: runGhAuthToken as unknown as GhAuthTokenRunner,
    });
    expect(result).toEqual({ token: 'env_token', origin: 'env' });
    expect(runGhAuthToken).not.toHaveBeenCalled();
  });

  it('env が空なら gh に fallback する', async () => {
    const runGhAuthToken = vi.fn(async () => ({
      stdout: 'gho_fallback',
      stderr: '',
      exitCode: 0,
    }));
    const result = await resolveGitHubToken({ source: 'auto', env: {}, runGhAuthToken });
    expect(result).toEqual({ token: 'gho_fallback', origin: 'gh' });
    expect(runGhAuthToken).toHaveBeenCalledTimes(1);
  });

  it('env も gh も無ければ GhCliNotFoundError (env では下りないが gh が原因)', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const runGhAuthToken = vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: -1,
      spawnError: enoent as NodeJS.ErrnoException,
    }));
    await expect(
      resolveGitHubToken({ source: 'auto', env: {}, runGhAuthToken }),
    ).rejects.toBeInstanceOf(GhCliNotFoundError);
  });
});
