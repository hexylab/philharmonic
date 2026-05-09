import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnedProcess = {
  /**
   * subprocess の pid。spawn 失敗時は undefined のまま。process group 経由 kill
   * (`process.kill(-pid, signal)`) で使う。
   */
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): SpawnedProcess;
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): SpawnedProcess;
};

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

/**
 * 既定の spawn 実装。`detached: true` で子プロセスを新しい process group の leader
 * にする (Unix) ことで、後段で `process.kill(-pid, signal)` を呼んで孫プロセスまで
 * まとめて停止できるようにしている。
 *
 * `stdio` は `pipe` のままなので、parent プロセスは子の close を待ち続ける
 * (= `child.unref()` は呼ばない)。`detached` の主目的は process group の分離であり、
 * 子を独立に走らせ続けることではない。
 *
 * Windows では `detached` は新しい console window に紐づけるだけで process group
 * 概念がないため、process group kill は best-effort になる (Issue #49 では Unix を
 * 優先)。
 */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  }) as unknown as SpawnedProcess;
