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
import { StreamEventParser, type ResultEvent } from './stream.js';

export type PermissionMode = 'auto' | 'bypass';

export type RunStatus = 'success' | 'failed' | 'timeout' | 'stalled';

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
  /**
   * Multi-turn loop の上限ターン数 (#25)。`1` (既定) で従来動作。
   * Runner は `error_max_turns` で打ち切られた場合のみ次ターンへ進む。
   */
  maxTurns?: number;
  /**
   * 2 ターン目以降の `claude -p <prompt>` に渡す継続用 prompt (#25)。
   * `maxTurns === 1` のときは未使用。
   */
  continuationPrompt?: string;
  /**
   * stdout からの無音許容時間 (ms)。`0` 以下で stall detection を無効化する (#25)。
   */
  stallTimeoutMs?: number;
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
  /**
   * subprocess の stdout に新しい chunk が来たタイミングで呼ばれる。stall 判定の基準点を
   * tracker / snapshot に伝えるために使う (#87)。activity 1 回ごとに 1 度呼ばれる。
   */
  onActivity?: (at: Date) => void;
  /**
   * subprocess を spawn して pid が確定した直後に呼ばれる (#105)。watchdog の orphaned 判定
   * (`process.kill(pid, 0)` で alive 確認) で使うため tracker に渡す。multi-turn では turn
   * ごとに新 pid に切り替わるので turn の数だけ呼ばれる。pid が取れない (= 即時 spawn 失敗) は
   * 呼ばれない。
   */
  onSpawn?: (pid: number) => void;
};

export type RunResult = {
  status: RunStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  durationApiMs: number | null;
  numTurns: number | null;
  /** Runner が起動した外側ターン数 (1〜maxTurns) */
  turns: number;
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
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONTINUATION_PROMPT = 'Please continue working on the task.';
const DEFAULT_COMMAND = 'claude';
const STDERR_TAIL_LIMIT_BYTES = 8 * 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionArg =
  | { mode: 'session-id'; uuid: string }
  | { mode: 'resume'; uuid: string }
  | { mode: 'none' };

type TurnOutcome = {
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
};

export async function runClaude(options: RunClaudeOptions): Promise<RunResult> {
  validateOptions(options);

  const command = options.command ?? DEFAULT_COMMAND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const continuationPrompt = options.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT;
  const env = options.env ?? buildRunnerEnv();
  const spawnFn = options.spawn ?? defaultSpawn;
  const killGroup = options.killProcessGroup ?? defaultKillProcessGroup;
  const permissionMode: PermissionMode = options.permissionMode ?? 'auto';

  const logPaths = await prepareLogDir(options.logDir);
  const streamLog = logPaths !== null ? createWriteStream(logPaths.stream, { flags: 'a' }) : null;
  const stderrLog = logPaths !== null ? createWriteStream(logPaths.stderr, { flags: 'a' }) : null;

  let baseLogger = options.logger;
  let resolvedSessionId: string | null = options.sessionId ?? null;
  const aggregate = createAggregator();
  let lastOutcome: TurnOutcome | null = null;

  try {
    for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex += 1) {
      const sessionArg = buildSessionArg(turnIndex, resolvedSessionId, options.sessionId);
      const turnPrompt = turnIndex === 1 ? options.prompt : continuationPrompt;

      let outcome: TurnOutcome;
      try {
        outcome = await runTurn({
          command,
          prompt: turnPrompt,
          permissionMode,
          sessionArg,
          workspacePath: options.workspacePath,
          env,
          spawnFn,
          killGroup,
          timeoutMs,
          killGracePeriodMs,
          stallTimeoutMs,
          streamLog,
          stderrLog,
          onActivity: options.onActivity,
          onSpawn: options.onSpawn,
          // baseLogger は system event 受信時に sessionId 付きに差し替わる。
          // getLogger は呼び出しごとに最新の baseLogger を child するので、
          // sessionId 切替後の intra-turn ログにも sessionId が付与される (#25)。
          getLogger: () => baseLogger?.child({ turn: turnIndex }),
          onSystemSessionId: (sid) => {
            if (resolvedSessionId === null) {
              resolvedSessionId = sid;
              if (baseLogger !== undefined) {
                baseLogger = baseLogger.child({ sessionId: sid });
              }
            }
          },
        });
      } catch (error) {
        // spawn 失敗系 (ClaudeNotInstalledError 等) はそのまま throw
        baseLogger?.error('runner spawn failed', {
          command,
          turn: turnIndex,
          error: describeError(error),
        });
        throw error;
      }

      lastOutcome = outcome;
      aggregate.add(outcome);

      baseLogger?.info('runner turn finished', {
        turn: turnIndex,
        status: outcome.status,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        numTurns: outcome.numTurns,
        totalCostUsd: outcome.totalCostUsd,
      });

      if (!shouldContinue(outcome, turnIndex, maxTurns, resolvedSessionId)) {
        break;
      }
      baseLogger?.info('runner continuing to next turn', {
        turn: turnIndex,
        nextTurn: turnIndex + 1,
        sessionId: resolvedSessionId,
      });
    }
  } finally {
    await closeLogStreams(streamLog, stderrLog);
  }

  if (lastOutcome === null) {
    // maxTurns < 1 は validateOptions で弾いているのでここには来ない。
    throw new InvalidRunOptionsError('maxTurns は 1 以上で指定してください');
  }

  const result: RunResult = {
    status: lastOutcome.status,
    exitCode: lastOutcome.exitCode,
    signal: lastOutcome.signal,
    durationMs: aggregate.totalDurationMs,
    durationApiMs: aggregate.totalDurationApiMs,
    numTurns: aggregate.totalNumTurns,
    turns: aggregate.turns,
    sessionId: lastOutcome.sessionId ?? resolvedSessionId,
    resultSubtype: lastOutcome.resultSubtype,
    stopReason: lastOutcome.stopReason,
    isError: lastOutcome.isError,
    finalText: lastOutcome.finalText,
    totalCostUsd: aggregate.totalCostUsd,
    usage: aggregate.totalUsage,
    rawStderrTail: lastOutcome.rawStderrTail,
    resultEventReceived: lastOutcome.resultEventReceived,
    logPaths,
  };

  baseLogger?.info('runner finished', {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    turns: result.turns,
    totalCostUsd: result.totalCostUsd,
  });

  return result;
}

type RunTurnInput = {
  command: string;
  prompt: string;
  permissionMode: PermissionMode;
  sessionArg: SessionArg;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  killGroup: KillProcessGroupFn;
  timeoutMs: number;
  killGracePeriodMs: number;
  stallTimeoutMs: number;
  streamLog: WriteStream | null;
  stderrLog: WriteStream | null;
  onActivity?: (at: Date) => void;
  onSpawn?: (pid: number) => void;
  /**
   * 呼び出すたびに最新の logger (sessionId 反映済み) を返す getter。
   * runTurn の内部で `input.getLogger()?.info(...)` のように使う。
   */
  getLogger: () => Logger | undefined;
  onSystemSessionId: (sessionId: string) => void;
};

async function runTurn(input: RunTurnInput): Promise<TurnOutcome> {
  const args = buildArgs(input.prompt, input.permissionMode, input.sessionArg);
  const startedAt = Date.now();

  let child: SpawnedProcess;
  try {
    child = input.spawnFn(input.command, args, {
      cwd: input.workspacePath,
      env: input.env,
    });
  } catch (error) {
    input.getLogger()?.error('runner spawn failed', {
      command: input.command,
      error: describeError(error),
    });
    throw toSpawnError(error, input.command);
  }

  input.getLogger()?.info('runner started', {
    command: input.command,
    permissionMode: input.permissionMode,
    timeoutMs: input.timeoutMs,
    stallTimeoutMs: input.stallTimeoutMs,
    sessionMode: input.sessionArg.mode,
  });

  if (typeof child.pid === 'number' && child.pid > 0) {
    input.onSpawn?.(child.pid);
  }

  const parser = new StreamEventParser();
  let lastResult: ResultEvent | null = null;
  let stderrTail = '';
  let killReason: 'timeout' | 'stalled' | null = null;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  const sendSignalToTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        input.killGroup(pid, signal);
        return;
      } catch (error) {
        input.getLogger()?.warn('process group kill failed, falling back to direct kill', {
          signal,
          pid,
          error: describeError(error),
        });
      }
    }
    child.kill(signal);
  };

  return await new Promise<TurnOutcome>((resolve, reject) => {
    let killTimer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;

    const triggerKill = (reason: 'timeout' | 'stalled'): void => {
      if (killReason !== null) return;
      killReason = reason;
      input
        .getLogger()
        ?.warn(
          reason === 'timeout'
            ? 'runner timeout reached, sending SIGTERM to process group'
            : 'runner stall detected, sending SIGTERM to process group',
          {
            timeoutMs: reason === 'timeout' ? input.timeoutMs : input.stallTimeoutMs,
            pid: child.pid ?? null,
          },
        );
      sendSignalToTree('SIGTERM');
      killTimer = setTimeout(() => {
        input
          .getLogger()
          ?.warn('runner did not exit after SIGTERM, sending SIGKILL to process group', {
            killGracePeriodMs: input.killGracePeriodMs,
            pid: child.pid ?? null,
          });
        sendSignalToTree('SIGKILL');
      }, input.killGracePeriodMs);
    };

    const timeoutTimer: NodeJS.Timeout = setTimeout(() => triggerKill('timeout'), input.timeoutMs);

    const stallEnabled = input.stallTimeoutMs > 0 && Number.isFinite(input.stallTimeoutMs);
    const rescheduleStall = (): void => {
      if (!stallEnabled) return;
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => triggerKill('stalled'), input.stallTimeoutMs);
    };
    rescheduleStall();

    child.stdout?.on('data', (chunk: string) => {
      rescheduleStall();
      input.onActivity?.(new Date());
      if (input.streamLog !== null) input.streamLog.write(chunk);
      const events = parser.push(chunk);
      for (const event of events) {
        if (event.type === 'result') {
          lastResult = event;
        } else if (event.type === 'system' && event.sessionId !== undefined) {
          input.onSystemSessionId(event.sessionId);
        }
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      if (input.stderrLog !== null) input.stderrLog.write(chunk);
      stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_LIMIT_BYTES);
    });

    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (stallTimer !== null) clearTimeout(stallTimer);
      action();
    };

    child.on('error', (err) => {
      input.getLogger()?.error('runner error event', { error: describeError(err) });
      settle(() => reject(toSpawnError(err, input.command)));
    });

    child.on('close', (code, signal) => {
      const trailing = parser.flush();
      for (const event of trailing) {
        if (event.type === 'result') lastResult = event;
      }

      const durationMs = Date.now() - startedAt;
      const status: RunStatus =
        killReason === 'timeout'
          ? 'timeout'
          : killReason === 'stalled'
            ? 'stalled'
            : code === 0 && lastResult !== null && lastResult.isError !== true
              ? 'success'
              : 'failed';

      const outcome: TurnOutcome = {
        status,
        exitCode: code,
        signal,
        durationMs,
        durationApiMs: lastResult?.durationApiMs ?? null,
        numTurns: lastResult?.numTurns ?? null,
        sessionId: lastResult?.sessionId ?? null,
        resultSubtype: lastResult?.subtype ?? null,
        stopReason: lastResult?.stopReason ?? null,
        isError: lastResult?.isError ?? false,
        finalText: lastResult?.finalText ?? null,
        totalCostUsd: lastResult?.totalCostUsd ?? null,
        usage: lastResult?.usage ?? null,
        rawStderrTail: stderrTail,
        resultEventReceived: lastResult !== null,
      };
      settle(() => resolve(outcome));
    });
  });
}

function shouldContinue(
  outcome: TurnOutcome,
  currentTurn: number,
  maxTurns: number,
  sessionId: string | null,
): boolean {
  if (currentTurn >= maxTurns) return false;
  if (sessionId === null) return false;
  if (!outcome.resultEventReceived) return false;
  return outcome.resultSubtype === 'error_max_turns';
}

function buildSessionArg(
  turnIndex: number,
  resolvedSessionId: string | null,
  optionsSessionId: string | undefined,
): SessionArg {
  if (turnIndex === 1) {
    if (optionsSessionId !== undefined) {
      return { mode: 'session-id', uuid: optionsSessionId };
    }
    return { mode: 'none' };
  }
  // 2 ターン目以降は必ず resume。session_id が無い場合は shouldContinue で弾かれて
  // ここには到達しない。
  if (resolvedSessionId === null) {
    throw new Error('internal: resume requires a resolved sessionId');
  }
  return { mode: 'resume', uuid: resolvedSessionId };
}

function createAggregator() {
  let totalDurationMs = 0;
  let totalDurationApiMs: number | null = null;
  let totalNumTurns: number | null = null;
  let totalCostUsd: number | null = null;
  let totalUsage: { inputTokens: number; outputTokens: number } | null = null;
  let turns = 0;

  return {
    add(outcome: TurnOutcome) {
      turns += 1;
      totalDurationMs += outcome.durationMs;
      if (outcome.durationApiMs !== null) {
        totalDurationApiMs = (totalDurationApiMs ?? 0) + outcome.durationApiMs;
      }
      if (outcome.numTurns !== null) {
        totalNumTurns = (totalNumTurns ?? 0) + outcome.numTurns;
      }
      if (outcome.totalCostUsd !== null) {
        totalCostUsd = (totalCostUsd ?? 0) + outcome.totalCostUsd;
      }
      if (outcome.usage !== null) {
        totalUsage = {
          inputTokens: (totalUsage?.inputTokens ?? 0) + outcome.usage.inputTokens,
          outputTokens: (totalUsage?.outputTokens ?? 0) + outcome.usage.outputTokens,
        };
      }
    },
    get totalDurationMs() {
      return totalDurationMs;
    },
    get totalDurationApiMs() {
      return totalDurationApiMs;
    },
    get totalNumTurns() {
      return totalNumTurns;
    },
    get totalCostUsd() {
      return totalCostUsd;
    },
    get totalUsage() {
      return totalUsage;
    },
    get turns() {
      return turns;
    },
  };
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
  if (
    options.maxTurns !== undefined &&
    (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)
  ) {
    throw new InvalidRunOptionsError('maxTurns は 1 以上の整数で指定してください');
  }
  if (
    options.stallTimeoutMs !== undefined &&
    (!Number.isFinite(options.stallTimeoutMs) || options.stallTimeoutMs < 0)
  ) {
    throw new InvalidRunOptionsError('stallTimeoutMs は 0 以上で指定してください');
  }
  if (
    options.continuationPrompt !== undefined &&
    (typeof options.continuationPrompt !== 'string' || options.continuationPrompt.length === 0)
  ) {
    throw new InvalidRunOptionsError('continuationPrompt は空でない文字列で指定してください');
  }
  if (options.sessionId !== undefined && !UUID_REGEX.test(options.sessionId)) {
    throw new InvalidSessionIdError(options.sessionId);
  }
}

function buildArgs(prompt: string, permissionMode: PermissionMode, session: SessionArg): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  if (session.mode === 'session-id') {
    args.push('--session-id', session.uuid);
  } else if (session.mode === 'resume') {
    args.push('--resume', session.uuid);
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const defaultKillProcessGroup: KillProcessGroupFn = (pid, signal) => {
  // Unix: process.kill に負の pid を渡すと process group 全体に signal を送る。
  // detached:true で起動した子はその pid が group leader なので、孫まで届く。
  process.kill(-pid, signal);
};
