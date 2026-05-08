import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnedProcess = {
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

export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as SpawnedProcess;
