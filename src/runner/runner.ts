import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger/index.js';

import { buildRunnerEnv } from './env.js';
import {
  ClaudeNotInstalledError,
  ClaudeRunnerSpawnError,
  InvalidRunOptionsError,
  InvalidSessionIdError,
} from './errors.js';
import { defaultSpawn, type SpawnFn, type SpawnedProcess } from './spawn.js';
import { StreamEventParser, type ResultEvent, type StreamEvent } from './stream.js';

export type PermissionMode = 'auto' | 'bypass';

export type RunStatus = 'success' | 'failed' | 'timeout';

/**
 * Process tree kill 用の関数型。`pid` は spawn された subprocess の pid (process group leader)。
 * 既定実装では `process.kill(-pid, signal)` を呼んで process group 全体に signal を送る。
 * Unix では子の `detached: true` 起動とセットで効く。
 */
export type KillProcessGroupFn = (pid: number, signal: NodeJS.Signals) => void;

export type RunClaudeOptions = {
  prompt: string;
  workspacePath: string;
  permissionMode?: PermissionMode;
  sessionId?: string;
  timeoutMs?: number;
  killGracePeriodMs?: number;
  logDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  command?: string;
  logger?: Logger;
  /**
   * テスト用 DI: process group 全体に signal を送る関数。
   * 既定は `process.kill(-pid, signal)`。失敗時は単体 kill にフォールバックする。
   */
  killProcessGroup?: KillProcessGroupFn;
};

export type RunResult = {
  status: RunStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  durationApiMs: number | null;
  numTurns: number | null;
  sessionId: string | null;
  resultSubtype: string | null;
  stopReason: string | null;
  isError: boolean;
  finalText: string | null;
  totalCostUsd: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  rawStderrTail: string;
  resultEventReceived: boolean;
  logPaths: { stream: string; stderr: string } | null;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;
const DEFAULT_COMMAND = 'claude';
const STDERR_TAIL_LIMIT_BYTES = 8 * 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runClaude(options: RunClaudeOptions): Promise<RunResult> {
  validateOptions(options);

  const command = options.command ?? DEFAULT_COMMAND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
  const env = options.env ?? buildRunnerEnv();
  const spawnFn = options.spawn ?? defaultSpawn;
  const killGroup = options.killProcessGroup ?? defaultKillProcessGroup;
  const args = buildArgs(options);
  const logPaths = await prepareLogDir(options.logDir);
  const streamLog = logPaths !== null ? createWriteStream(logPaths.stream, { flags: 'a' }) : null;
  const stderrLog = logPaths !== null ? createWriteStream(logPaths.stderr, { flags: 'a' }) : null;
  let runLogger = options.logger;

  const startedAt = Date.now();
  let child: SpawnedProcess;
  try {
    child = spawnFn(command, args, { cwd: options.workspacePath, env });
  } catch (error) {
    await closeLogStreams(streamLog, stderrLog);
    runLogger?.error('runner spawn failed', {
      command,
      error: describeSpawnError(error),
    });
    throw toSpawnError(error, command);
  }

  runLogger?.info('runner started', {
    command,
    permissionMode: options.permissionMode ?? 'auto',
    timeoutMs,
  });

  const parser = new StreamEventParser();
  let lastResult: ResultEvent | null = null;
  let systemSessionId: string | null = null;
  let stderrTail = '';
  let timedOut = false;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', (chunk: string) => {
    if (streamLog !== null) streamLog.write(chunk);
    const events = parser.push(chunk);
    handleEvents(events, (e) => {
      if (e.type === 'result') lastResult = e;
      else if (e.type === 'system' && systemSessionId === null && e.sessionId !== undefined) {
        systemSessionId = e.sessionId;
        if (runLogger !== undefined) {
          runLogger = runLogger.child({ sessionId: e.sessionId });
        }
      }
    });
  });

  child.stderr?.on('data', (chunk: string) => {
    if (stderrLog !== null) stderrLog.write(chunk);
    stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_LIMIT_BYTES);
  });

  const sendSignalToTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        killGroup(pid, signal);
        return;
      } catch (error) {
        runLogger?.warn('process group kill failed, falling back to direct kill', {
          signal,
          pid,
          error: describeSpawnError(error),
        });
      }
    }
    child.kill(signal);
  };

  return new Promise<RunResult>((resolve, reject) => {
    let killTimer: NodeJS.Timeout | null = null;
    const timeoutTimer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      runLogger?.warn('runner timeout reached, sending SIGTERM to process group', {
        timeoutMs,
        pid: child.pid ?? null,
      });
      sendSignalToTree('SIGTERM');
      killTimer = setTimeout(() => {
        runLogger?.warn('runner did not exit after SIGTERM, sending SIGKILL to process group', {
          killGracePeriodMs,
          pid: child.pid ?? null,
        });
        sendSignalToTree('SIGKILL');
      }, killGracePeriodMs);
    }, timeoutMs);

    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      void closeLogStreams(streamLog, stderrLog).then(action, action);
    };

    child.on('error', (err) => {
      runLogger?.error('runner error event', { error: describeSpawnError(err) });
      settle(() => reject(toSpawnError(err, command)));
    });

    child.on('close', (code, signal) => {
      const trailing = parser.flush();
      handleEvents(trailing, (e) => {
        if (e.type === 'result') lastResult = e;
      });

      const durationMs = Date.now() - startedAt;
      const status: RunStatus = timedOut
        ? 'timeout'
        : code === 0 && lastResult !== null && lastResult.isError !== true
          ? 'success'
          : 'failed';
      const result: RunResult = {
        status,
        exitCode: code,
        signal,
        durationMs,
        durationApiMs: lastResult?.durationApiMs ?? null,
        numTurns: lastResult?.numTurns ?? null,
        sessionId: lastResult?.sessionId ?? systemSessionId,
        resultSubtype: lastResult?.subtype ?? null,
        stopReason: lastResult?.stopReason ?? null,
        isError: lastResult?.isError ?? false,
        finalText: lastResult?.finalText ?? null,
        totalCostUsd: lastResult?.totalCostUsd ?? null,
        usage: lastResult?.usage ?? null,
        rawStderrTail: stderrTail,
        resultEventReceived: lastResult !== null,
        logPaths,
      };
      runLogger?.info('runner finished', {
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        totalCostUsd: result.totalCostUsd,
      });
      settle(() => resolve(result));
    });
  });
}

function validateOptions(options: RunClaudeOptions): void {
  if (typeof options.prompt !== 'string' || options.prompt.length === 0) {
    throw new InvalidRunOptionsError('prompt は空でない文字列で指定してください');
  }
  if (typeof options.workspacePath !== 'string' || options.workspacePath.length === 0) {
    throw new InvalidRunOptionsError('workspacePath は絶対パスで指定してください');
  }
  if (!path.isAbsolute(options.workspacePath)) {
    throw new InvalidRunOptionsError('workspacePath は絶対パスで指定してください');
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new InvalidRunOptionsError('timeoutMs は正の数で指定してください');
  }
  if (
    options.killGracePeriodMs !== undefined &&
    (!Number.isFinite(options.killGracePeriodMs) || options.killGracePeriodMs < 0)
  ) {
    throw new InvalidRunOptionsError('killGracePeriodMs は 0 以上で指定してください');
  }
  if (options.sessionId !== undefined && !UUID_REGEX.test(options.sessionId)) {
    throw new InvalidSessionIdError(options.sessionId);
  }
}

function buildArgs(options: RunClaudeOptions): string[] {
  const permissionMode: PermissionMode = options.permissionMode ?? 'auto';
  const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose'];
  if (permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  if (options.sessionId !== undefined) {
    args.push('--session-id', options.sessionId);
  }
  return args;
}

async function prepareLogDir(
  logDir: string | undefined,
): Promise<{ stream: string; stderr: string } | null> {
  if (logDir === undefined) return null;
  await mkdir(logDir, { recursive: true });
  return {
    stream: path.join(logDir, 'stream.jsonl'),
    stderr: path.join(logDir, 'stderr.log'),
  };
}

async function closeLogStreams(
  streamLog: WriteStream | null,
  stderrLog: WriteStream | null,
): Promise<void> {
  await Promise.all([closeStream(streamLog), closeStream(stderrLog)]);
}

function closeStream(stream: WriteStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    stream.end(() => resolve());
  });
}

function handleEvents(events: StreamEvent[], visit: (event: StreamEvent) => void): void {
  for (const event of events) visit(event);
}

function appendTail(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}

function toSpawnError(error: unknown, command: string): Error {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    return new ClaudeNotInstalledError(command);
  }
  return new ClaudeRunnerSpawnError(command, error);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function describeSpawnError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const defaultKillProcessGroup: KillProcessGroupFn = (pid, signal) => {
  // Unix: process.kill に負の pid を渡すと process group 全体に signal を送る。
  // detached:true で起動した子はその pid が group leader なので、孫まで届く。
  process.kill(-pid, signal);
};
