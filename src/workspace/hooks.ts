import { spawn } from 'node:child_process';

import type { Logger } from '../logger/index.js';

export const HOOK_EVENTS = ['after_create', 'before_run', 'after_run', 'before_remove'] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookFailureMode = 'continue' | 'fail';

export type HookConfig = {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  onFailure: HookFailureMode;
};

export type HookConfigMap = Record<HookEvent, readonly HookConfig[]>;

export type HookContext = {
  taskKey: string;
  branch: string;
  workspacePath: string;
  baseRef?: string;
  /**
   * orchestrator が `before_run` / `after_run` 等から渡す追加 env 変数。
   * 例: `PHILHARMONIC_RUN_ID`, `PHILHARMONIC_ISSUE_NUMBER`, `PHILHARMONIC_RUN_STATUS`
   */
  extraEnv?: Record<string, string>;
};

/**
 * hook 実行の単発インターフェース。テストではこれを差し替えてプロセス起動を回避する。
 *
 * - 失敗 (非ゼロ exit / spawn error) は {@link HookExecutionError} を throw する
 * - timeout 超過は {@link HookTimeoutError} を throw する
 */
export type HookExecutor = (input: HookExecutorInput) => Promise<void>;

export type HookExecutorInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGracePeriodMs: number;
  event: HookEvent;
};

export class HookExecutionError extends Error {
  constructor(
    public readonly event: HookEvent,
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly stdout: string,
    cause?: unknown,
  ) {
    super(
      `hook '${event}' (${command}) が失敗しました (exitCode: ${exitCode ?? 'null'}): ${stderr.trim() || '(stderr 出力なし)'}`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'HookExecutionError';
  }
}

export class HookTimeoutError extends Error {
  constructor(
    public readonly event: HookEvent,
    public readonly command: string,
    public readonly timeoutMs: number,
  ) {
    super(`hook '${event}' (${command}) が timeout (${timeoutMs}ms) を超えました`);
    this.name = 'HookTimeoutError';
  }
}

export const DEFAULT_HOOK_KILL_GRACE_PERIOD_MS = 5_000;

const STDOUT_TAIL_BYTES = 8 * 1024;

/**
 * `node:child_process.spawn` ベースの default hook executor。
 *
 * - `shell: false` で起動 (引数は配列で安全に渡る)
 * - timeout 到達で SIGTERM → `killGracePeriodMs` 経過後 SIGKILL
 * - stdout / stderr は末尾 8KiB だけ捕捉してエラーメッセージに流す
 */
export const defaultHookExecutor: HookExecutor = (input) =>
  new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new HookExecutionError(input.event, input.command, null, '', '', error));
      return;
    }

    let stdoutTail = '';
    let stderrTail = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, input.killGracePeriodMs);
    }, input.timeoutMs);

    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      reject(
        new HookExecutionError(input.event, input.command, null, stderrTail, stdoutTail, error),
      );
    });

    child.once('close', (code: number | null) => {
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (timedOut) {
        reject(new HookTimeoutError(input.event, input.command, input.timeoutMs));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new HookExecutionError(input.event, input.command, code, stderrTail, stdoutTail));
    });
  });

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= STDOUT_TAIL_BYTES) return next;
  return next.slice(next.length - STDOUT_TAIL_BYTES);
}

export type RunHooksInput = {
  event: HookEvent;
  hooks: readonly HookConfig[];
  context: HookContext;
  repoRoot: string;
  executor?: HookExecutor;
  killGracePeriodMs?: number;
  /**
   * `before_remove` のときは true を渡す。`on_failure: fail` でも throw せず warn のみ
   * (孤児 worktree 防止のため、cleanup を必ず続行する) — spec: workspace-manager.md
   */
  alwaysContinue?: boolean;
  logger?: Logger;
  parentEnv?: NodeJS.ProcessEnv;
};

/**
 * 1 イベント分の hook 配列を**配列順に逐次実行**する。
 *
 * - 失敗時の挙動は各 hook の `onFailure` に従う
 * - `alwaysContinue: true` のときは全 hook を warn 扱いで続行する (`before_remove` 用)
 */
export async function runHooksForEvent(input: RunHooksInput): Promise<void> {
  if (input.hooks.length === 0) return;
  const executor = input.executor ?? defaultHookExecutor;
  const killGracePeriodMs = input.killGracePeriodMs ?? DEFAULT_HOOK_KILL_GRACE_PERIOD_MS;
  const env = buildHookEnv(input.event, input.context, input.repoRoot, input.parentEnv);

  for (const [index, hook] of input.hooks.entries()) {
    const startedAt = Date.now();
    try {
      await executor({
        command: hook.command,
        args: hook.args,
        cwd: input.context.workspacePath,
        env,
        timeoutMs: hook.timeoutMs,
        killGracePeriodMs,
        event: input.event,
      });
      input.logger?.debug('hook succeeded', {
        event: input.event,
        command: hook.command,
        index,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const isHookError = error instanceof HookExecutionError || error instanceof HookTimeoutError;
      const message = error instanceof Error ? error.message : String(error);
      const continueOnFailure = input.alwaysContinue === true || hook.onFailure === 'continue';

      if (continueOnFailure) {
        input.logger?.warn('hook failed (continue mode)', {
          event: input.event,
          command: hook.command,
          index,
          alwaysContinue: input.alwaysContinue === true,
          onFailure: hook.onFailure,
          error: message,
        });
        continue;
      }

      input.logger?.error('hook failed', {
        event: input.event,
        command: hook.command,
        index,
        error: message,
      });
      if (isHookError) throw error;
      throw new HookExecutionError(input.event, hook.command, null, '', '', error);
    }
  }
}

function buildHookEnv(
  event: HookEvent,
  context: HookContext,
  repoRoot: string,
  parentEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...(parentEnv ?? process.env),
    PHILHARMONIC_EVENT: event,
    PHILHARMONIC_TASK_KEY: context.taskKey,
    PHILHARMONIC_BRANCH: context.branch,
    PHILHARMONIC_WORKSPACE_PATH: context.workspacePath,
    PHILHARMONIC_REPO_ROOT: repoRoot,
  };
  if (context.baseRef !== undefined) {
    base.PHILHARMONIC_BASE_REF = context.baseRef;
  }
  if (context.extraEnv !== undefined) {
    for (const [key, value] of Object.entries(context.extraEnv)) {
      base[key] = value;
    }
  }
  return base;
}

export const EMPTY_HOOK_CONFIG_MAP: HookConfigMap = {
  after_create: [],
  before_run: [],
  after_run: [],
  before_remove: [],
};
