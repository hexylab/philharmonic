import { describe, expect, it } from 'vitest';

import { buildRunnerEnv } from '../../src/runner/index.js';

describe('buildRunnerEnv', () => {
  it('GitHub token 系の環境変数を除外する', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      GH_TOKEN: 'ghp_secret',
      GITHUB_TOKEN: 'gho_secret',
      GH_ENTERPRISE_TOKEN: 'ghe_secret',
      OCTOKIT_AUTH: 'oa_secret',
      OCTOKIT_API_URL: 'https://api.example.com',
      OTHER_VAR: 'kept',
    });

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.OCTOKIT_AUTH).toBeUndefined();
    expect(env.OCTOKIT_API_URL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.OTHER_VAR).toBe('kept');
  });

  it('undefined の値は除外する', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      EMPTY: undefined,
    });

    expect('EMPTY' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('引数省略時は process.env をベースにする', () => {
    const env = buildRunnerEnv();
    expect(typeof env).toBe('object');
  });
});
