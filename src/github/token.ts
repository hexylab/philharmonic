import { spawn } from 'node:child_process';

import {
  GITHUB_TOKEN_ENV,
  GITHUB_TOKEN_FALLBACK_ENV,
  GhCliNotAuthenticatedError,
  GhCliNotFoundError,
  GitHubTokenNotSetError,
} from './errors.js';

export { GITHUB_TOKEN_ENV, GITHUB_TOKEN_FALLBACK_ENV };

export type GitHubTokenSource = 'env' | 'gh' | 'auto';

export type GhAuthTokenRunner = () => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  spawnError?: NodeJS.ErrnoException;
}>;

export type ResolveGitHubTokenInput = {
  source: GitHubTokenSource;
  env?: NodeJS.ProcessEnv;
  runGhAuthToken?: GhAuthTokenRunner;
};

export type ResolveGitHubTokenResult = {
  token: string;
  /** 実際にどこから token を取れたか。logger 等での表示用 (token 自体は出さない) */
  origin: 'env' | 'gh';
};

/**
 * env / gh / auto のいずれかの方針で GitHub token を解決する。
 *
 * - env: `GITHUB_TOKEN` または `GH_TOKEN` を読む。空なら `GitHubTokenNotSetError`
 * - gh: `gh auth token` の stdout を採用する。失敗時は `GhCliNotFoundError` か `GhCliNotAuthenticatedError`
 * - auto: env を試し、空なら gh に fallback する
 *
 * 取得した token は呼び出し側で `process.env.GITHUB_TOKEN` に書き戻すことを想定している
 * (Runner subprocess へは `buildRunnerEnv` の allowlist 経由で透過するため)。
 */
export async function resolveGitHubToken(
  input: ResolveGitHubTokenInput,
): Promise<ResolveGitHubTokenResult> {
  const { source, env = process.env, runGhAuthToken = defaultGhAuthTokenRunner } = input;

  switch (source) {
    case 'env': {
      const token = readTokenFromEnv(env);
      if (token === null) throw new GitHubTokenNotSetError();
      return { token, origin: 'env' };
    }
    case 'gh': {
      const token = await readTokenFromGhCli(runGhAuthToken);
      return { token, origin: 'gh' };
    }
    case 'auto': {
      const fromEnv = readTokenFromEnv(env);
      if (fromEnv !== null) return { token: fromEnv, origin: 'env' };
      const token = await readTokenFromGhCli(runGhAuthToken);
      return { token, origin: 'gh' };
    }
  }
}

/**
 * 既存呼び出し側のために残す compat シム。env のみから token を取る。
 *
 * 新規コードは `resolveGitHubToken({ source: 'env' })` を使う。
 */
export function getGitHubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const token = readTokenFromEnv(env);
  if (token === null) throw new GitHubTokenNotSetError();
  return token;
}

function readTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  const primary = env[GITHUB_TOKEN_ENV];
  if (typeof primary === 'string' && primary.trim().length > 0) return primary;
  const fallback = env[GITHUB_TOKEN_FALLBACK_ENV];
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback;
  return null;
}

async function readTokenFromGhCli(runGhAuthToken: GhAuthTokenRunner): Promise<string> {
  const result = await runGhAuthToken();
  if (result.spawnError !== undefined) {
    if (result.spawnError.code === 'ENOENT') throw new GhCliNotFoundError();
    throw result.spawnError;
  }
  if (result.exitCode !== 0) {
    throw new GhCliNotAuthenticatedError(result.stderr);
  }
  const token = result.stdout.trim();
  if (token.length === 0) throw new GhCliNotAuthenticatedError(result.stderr);
  return token;
}

const defaultGhAuthTokenRunner: GhAuthTokenRunner = () =>
  new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ stdout, stderr, exitCode: -1, spawnError: error });
    });
    child.once('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
