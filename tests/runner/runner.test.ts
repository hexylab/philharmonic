import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeNotInstalledError,
  ClaudeRunnerSpawnError,
  InvalidRunOptionsError,
  InvalidSessionIdError,
  runClaude,
  type RunClaudeOptions,
  type SpawnFn,
  type SpawnedProcess,
} from '../../src/runner/index.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  closed = false;
}

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/runner/${name}`, import.meta.url)),
    'utf8',
  );
}

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: { cwd: string; env: NodeJS.ProcessEnv };
  child: FakeChild;
};

function createSpawnFn(): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child as unknown as SpawnedProcess;
  };
  return { spawn, calls };
}

async function waitForSpawn(calls: SpawnCall[]): Promise<SpawnCall> {
  for (let i = 0; i < 20 && calls.length === 0; i++) {
    await Promise.resolve();
  }
  if (calls.length === 0) throw new Error('spawn was not called');
  return calls[0]!;
}

function baseOptions(overrides: Partial<RunClaudeOptions> = {}): RunClaudeOptions {
  return {
    prompt: 'say hi',
    workspacePath: '/tmp/test-ws',
    env: { PATH: '/usr/bin' },
    command: 'claude-test-bin',
    ...overrides,
  };
}

describe('runClaude — input validation', () => {
  it('prompt が空文字なら InvalidRunOptionsError', async () => {
    await expect(runClaude(baseOptions({ prompt: '' }))).rejects.toBeInstanceOf(
      InvalidRunOptionsError,
    );
  });

  it('workspacePath が相対パスなら InvalidRunOptionsError', async () => {
    await expect(runClaude(baseOptions({ workspacePath: 'relative/path' }))).rejects.toBeInstanceOf(
      InvalidRunOptionsError,
    );
  });

  it('sessionId が UUID 形式でなければ InvalidSessionIdError', async () => {
    await expect(runClaude(baseOptions({ sessionId: 'not-a-uuid' }))).rejects.toBeInstanceOf(
      InvalidSessionIdError,
    );
  });

  it('timeoutMs が 0 以下なら InvalidRunOptionsError', async () => {
    await expect(runClaude(baseOptions({ timeoutMs: 0 }))).rejects.toBeInstanceOf(
      InvalidRunOptionsError,
    );
  });
});

describe('runClaude — spawn arguments', () => {
  it('auto モード (デフォルト) では --permission-mode acceptEdits を渡す', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));

    const call = await waitForSpawn(calls);
    call.child.emit('close', 0, null);
    await promise;

    expect(calls).toHaveLength(1);
    expect(call.command).toBe('claude-test-bin');
    expect(call.args).toEqual([
      '-p',
      'say hi',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('auto モード時は --dangerously-skip-permissions を渡さない', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn, permissionMode: 'auto' }));
    const call = await waitForSpawn(calls);
    call.child.emit('close', 0, null);
    await promise;

    expect(call.args).not.toContain('--dangerously-skip-permissions');
  });

  it('bypass モードでは --dangerously-skip-permissions を渡し、--permission-mode フラグは付けない', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn, permissionMode: 'bypass' }));
    const call = await waitForSpawn(calls);
    call.child.emit('close', 0, null);
    await promise;

    expect(call.args).toContain('--dangerously-skip-permissions');
    expect(call.args).not.toContain('--permission-mode');
    expect(call.args).not.toContain('acceptEdits');
  });

  it('sessionId 指定時は --session-id <UUID> を末尾に追加する', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(
      baseOptions({ spawn, sessionId: '11111111-1111-4111-8111-111111111111' }),
    );
    const call = await waitForSpawn(calls);
    call.child.emit('close', 0, null);
    await promise;

    expect(call.args).toContain('--session-id');
    expect(call.args).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('subprocess の cwd に workspacePath が渡る', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn, workspacePath: '/abs/ws' }));
    const call = await waitForSpawn(calls);
    call.child.emit('close', 0, null);
    await promise;

    expect(call.options.cwd).toBe('/abs/ws');
  });

  it('env に GitHub token 系を含めない (default env 使用時)', async () => {
    const { spawn, calls } = createSpawnFn();
    const original = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'should-be-removed';
    let call: SpawnCall;
    try {
      const promise = runClaude(baseOptions({ spawn, env: undefined }));
      call = await waitForSpawn(calls);
      call.child.emit('close', 0, null);
      await promise;
    } finally {
      if (original === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = original;
    }

    expect(call.options.env.GH_TOKEN).toBeUndefined();
  });
});

describe('runClaude — claude not installed', () => {
  it('spawn が同期で ENOENT を throw した場合 ClaudeNotInstalledError', async () => {
    const enoent = Object.assign(new Error("spawn 'claude' ENOENT"), { code: 'ENOENT' });
    const spawn: SpawnFn = () => {
      throw enoent;
    };

    await expect(runClaude(baseOptions({ spawn }))).rejects.toBeInstanceOf(ClaudeNotInstalledError);
  });

  it("error event で code='ENOENT' が来た場合も ClaudeNotInstalledError", async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    call.child.emit('error', enoent);

    await expect(promise).rejects.toBeInstanceOf(ClaudeNotInstalledError);
  });

  it('ENOENT 以外の spawn エラーは ClaudeRunnerSpawnError に変換', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    call.child.emit('error', eperm);

    await expect(promise).rejects.toBeInstanceOf(ClaudeRunnerSpawnError);
  });
});

describe('runClaude — result aggregation', () => {
  it('正常な stream-json を流すと status=success と result event 由来のフィールドが入る', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    const child = call.child;

    child.stdout.write(fixture('stream-success.jsonl'));
    child.stdout.end();
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe('74fb7504-6563-4222-bafb-cf9a161003bb');
    expect(result.finalText).toBe('hello');
    expect(result.totalCostUsd).toBeCloseTo(0.25337325, 6);
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 6 });
    expect(result.numTurns).toBe(1);
    expect(result.stopReason).toBe('end_turn');
    expect(result.resultSubtype).toBe('success');
    expect(result.isError).toBe(false);
    expect(result.resultEventReceived).toBe(true);
  });

  it('exit != 0 なら status=failed', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    const child = call.child;

    child.stderr.write('boom\n');
    child.emit('close', 1, null);

    const result = await promise;
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.rawStderrTail).toContain('boom');
    expect(result.resultEventReceived).toBe(false);
  });

  it('result event が来ずに exit 0 でも status=failed (resultEventReceived=false)', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    const child = call.child;

    child.stdout.write(fixture('stream-no-result.jsonl'));
    child.stdout.end();
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.status).toBe('failed');
    expect(result.resultEventReceived).toBe(false);
    expect(result.sessionId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('result.is_error=true なら exit 0 でも status=failed', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    const child = call.child;

    child.stdout.write(fixture('stream-error.jsonl'));
    child.stdout.end();
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.status).toBe('failed');
    expect(result.isError).toBe(true);
    expect(result.resultSubtype).toBe('error_max_turns');
  });
});

describe('runClaude — logger integration (#28)', () => {
  type LogCall = { level: string; message: string; fields: Record<string, unknown> };

  function makeFakeLogger(initialBindings: Record<string, unknown> = {}) {
    const calls: LogCall[] = [];
    const make = (bindings: Record<string, unknown>) => {
      const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
        calls.push({ level, message: msg, fields: { ...bindings, ...fields } });
      };
      return {
        level: 'debug' as const,
        debug: log('debug'),
        info: log('info'),
        warn: log('warn'),
        error: log('error'),
        child: (extra: Record<string, unknown>) => make({ ...bindings, ...extra }),
      };
    };
    return { logger: make(initialBindings), calls };
  }

  it('logger 未指定でも例外を起こさず通常完了する', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));
    const call = await waitForSpawn(calls);
    call.child.stdout.write(fixture('stream-success.jsonl'));
    call.child.stdout.end();
    call.child.emit('close', 0, null);
    await promise;
  });

  it('runner started / finished のログが logger 経由で出る', async () => {
    const { spawn, calls } = createSpawnFn();
    const { logger, calls: logCalls } = makeFakeLogger({ runId: 'r1' });
    const promise = runClaude(baseOptions({ spawn, logger }));
    const call = await waitForSpawn(calls);
    call.child.stdout.write(fixture('stream-success.jsonl'));
    call.child.stdout.end();
    call.child.emit('close', 0, null);
    await promise;

    const messages = logCalls.map((c) => c.message);
    expect(messages).toContain('runner started');
    expect(messages).toContain('runner finished');
  });

  it('system event の session_id を取得して以降のログに付与する', async () => {
    const { spawn, calls } = createSpawnFn();
    const { logger, calls: logCalls } = makeFakeLogger({ runId: 'r1' });
    const promise = runClaude(baseOptions({ spawn, logger }));
    const call = await waitForSpawn(calls);
    call.child.stdout.write(fixture('stream-success.jsonl'));
    call.child.stdout.end();
    call.child.emit('close', 0, null);
    await promise;

    const finishedCall = logCalls.find((c) => c.message === 'runner finished');
    expect(finishedCall).toBeDefined();
    expect(finishedCall?.fields.runId).toBe('r1');
    expect(finishedCall?.fields.sessionId).toBe('74fb7504-6563-4222-bafb-cf9a161003bb');
  });

  it('spawn が同期で失敗したときは runner spawn failed をログに残す', async () => {
    const enoent = Object.assign(new Error("spawn 'claude' ENOENT"), { code: 'ENOENT' });
    const spawn: SpawnFn = () => {
      throw enoent;
    };
    const { logger, calls: logCalls } = makeFakeLogger({ runId: 'r1' });
    await expect(runClaude(baseOptions({ spawn, logger }))).rejects.toBeInstanceOf(
      ClaudeNotInstalledError,
    );
    const messages = logCalls.map((c) => c.message);
    expect(messages).toContain('runner spawn failed');
  });
});

describe('runClaude — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeoutMs 経過で SIGTERM、killGracePeriodMs 後に SIGKILL を送る', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn, timeoutMs: 1000, killGracePeriodMs: 200 }));
    const call = await waitForSpawn(calls);
    const child = call.child;

    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    const result = await promise;

    expect(result.status).toBe('timeout');
    expect(result.signal).toBe('SIGKILL');
  });
});
