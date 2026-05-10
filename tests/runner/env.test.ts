import { describe, expect, it } from 'vitest';

import { buildRunnerEnv } from '../../src/runner/index.js';

describe('buildRunnerEnv (allowlist 方式)', () => {
  it('基本 env (PATH / HOME / USER / SHELL / TZ / LANG / TERM / TMPDIR) は通す', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      USER: 'someone',
      SHELL: '/bin/bash',
      TZ: 'Asia/Tokyo',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: '/tmp',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.USER).toBe('someone');
    expect(env.SHELL).toBe('/bin/bash');
    expect(env.TZ).toBe('Asia/Tokyo');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.TMPDIR).toBe('/tmp');
  });

  it('LC_*, XDG_*, NODE_*, ANTHROPIC_*, CLAUDE_*, PHILHARMONIC_* prefix は通す', () => {
    const env = buildRunnerEnv({
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      XDG_CONFIG_HOME: '/home/user/.config',
      NODE_PATH: '/some/node_path',
      NODE_OPTIONS: '--no-warnings',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PHILHARMONIC_DEBUG: '1',
    });
    expect(env.LC_ALL).toBe('C');
    expect(env.LC_CTYPE).toBe('UTF-8');
    expect(env.XDG_CONFIG_HOME).toBe('/home/user/.config');
    expect(env.NODE_PATH).toBe('/some/node_path');
    expect(env.NODE_OPTIONS).toBe('--no-warnings');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.PHILHARMONIC_DEBUG).toBe('1');
  });

  it('GitHub token (GITHUB_TOKEN / GH_TOKEN) は agent 委譲のため allowlist で透過する (ADR-0005)', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      GH_TOKEN: 'ghp_secret',
      GITHUB_TOKEN: 'gho_secret',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GH_TOKEN).toBe('ghp_secret');
    expect(env.GITHUB_TOKEN).toBe('gho_secret');
  });

  it('GH_ENTERPRISE_TOKEN / OCTOKIT_* は引き続き allowlist 外 (orchestrator 用途のみ)', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      GH_ENTERPRISE_TOKEN: 'ghe_secret',
      OCTOKIT_AUTH: 'oa_secret',
      OCTOKIT_API_URL: 'https://api.example.com',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.OCTOKIT_AUTH).toBeUndefined();
    expect(env.OCTOKIT_API_URL).toBeUndefined();
  });

  it('代表的な secret env (AWS_*, NPM_TOKEN, SSH_AUTH_SOCK, OPENAI_API_KEY 等) は落ちる', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
      AWS_PROFILE: 'default',
      NPM_TOKEN: 'npm_xxx',
      NPM_CONFIG_USERCONFIG: '/home/user/.npmrc',
      SSH_AUTH_SOCK: '/tmp/ssh-agent',
      SSH_AGENT_PID: '1234',
      OPENAI_API_KEY: 'sk-openai',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/user/gcp.json',
      DOCKER_AUTH_CONFIG: '{}',
      KUBECONFIG: '/home/user/.kube/config',
      DATABASE_URL: 'postgres://...',
      MY_PROJECT_TOKEN: 'whatever',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.SSH_AGENT_PID).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.DOCKER_AUTH_CONFIG).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MY_PROJECT_TOKEN).toBeUndefined();
  });

  it('未知の任意 env (allowlist 外) は落ちる', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      OTHER_VAR: 'kept',
      RANDOM_VAR: 'value',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OTHER_VAR).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it('undefined の値は除外する', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      HOME: undefined,
    });
    expect('HOME' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('引数省略時は process.env をベースにする', () => {
    const env = buildRunnerEnv();
    expect(typeof env).toBe('object');
  });
});
