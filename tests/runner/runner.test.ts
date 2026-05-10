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

  it('env に GitHub token (GITHUB_TOKEN / GH_TOKEN) を agent 委譲のため透過する (ADR-0005, default env 使用時)', async () => {
    const { spawn, calls } = createSpawnFn();
    const originalGh = process.env.GH_TOKEN;
    const originalGithub = process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'gh-token-value';
    process.env.GITHUB_TOKEN = 'github-token-value';
    let call: SpawnCall;
    try {
      const promise = runClaude(baseOptions({ spawn, env: undefined }));
      call = await waitForSpawn(calls);
      call.child.emit('close', 0, null);
      await promise;
    } finally {
      if (originalGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGh;
      if (originalGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithub;
    }

    expect(call.options.env.GH_TOKEN).toBe('gh-token-value');
    expect(call.options.env.GITHUB_TOKEN).toBe('github-token-value');
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

  it('child.pid がある場合は process group kill (killProcessGroup) を使う', async () => {
    const { spawn, calls } = createSpawnFn();
    const killGroup = vi.fn();
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 1000,
        killGracePeriodMs: 200,
        killProcessGroup: killGroup,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;
    // FakeChild に pid を仕込む (実 spawn と同じ挙動)
    (child as unknown as { pid: number }).pid = 12345;

    expect(killGroup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(killGroup).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(killGroup).toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', null, 'SIGKILL');
    const result = await promise;
    expect(result.status).toBe('timeout');
    expect(killGroup).toHaveBeenCalledTimes(2);
  });

  it('killProcessGroup が throw したら child.kill にフォールバックする', async () => {
    const { spawn, calls } = createSpawnFn();
    const killGroup = vi.fn(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 1000,
        killGracePeriodMs: 200,
        killProcessGroup: killGroup,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;
    (child as unknown as { pid: number }).pid = 12345;

    await vi.advanceTimersByTimeAsync(1000);
    expect(killGroup).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(200);
    expect(killGroup).toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    await promise;
  });

  it('child.pid が undefined のときは child.kill にフォールバック', async () => {
    const { spawn, calls } = createSpawnFn();
    const killGroup = vi.fn();
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 1000,
        killGracePeriodMs: 200,
        killProcessGroup: killGroup,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;
    // pid は仕込まない (undefined)

    await vi.advanceTimersByTimeAsync(1000);
    expect(killGroup).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(200);
    expect(killGroup).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    await promise;
  });
});

// stall detection / multi-turn のテスト用 helper
const FIXED_SESSION_ID = '11111111-1111-4111-8111-111111111111';

function makeSystemLine(sessionId: string): string {
  return `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;
}

function makeResultLine(input: {
  sessionId: string;
  subtype: 'success' | 'error_max_turns';
  isError: boolean;
  numTurns: number;
  totalCostUsd: number;
  resultText: string;
}): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: input.subtype,
    is_error: input.isError,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: input.numTurns,
    result: input.resultText,
    stop_reason: input.subtype === 'success' ? 'end_turn' : 'max_turns',
    session_id: input.sessionId,
    total_cost_usd: input.totalCostUsd,
    usage: { input_tokens: 10, output_tokens: 5 },
  })}\n`;
}

describe('runClaude — stall detection (#25)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stallTimeoutMs の間 stdout が無音だと SIGTERM を送り status=stalled になる', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 60_000,
        stallTimeoutMs: 1_000,
        killGracePeriodMs: 100,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;

    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    const result = await promise;

    expect(result.status).toBe('stalled');
    expect(result.signal).toBe('SIGKILL');
  });

  it('stdout に data が届くたびに stall timer が reschedule される', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 60_000,
        stallTimeoutMs: 1_000,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;

    // 800ms 経過 → まだ kill されない
    await vi.advanceTimersByTimeAsync(800);
    expect(child.kill).not.toHaveBeenCalled();

    // data 受信 (parser に system event を渡す) → stall timer reschedule
    child.stdout.write(makeSystemLine(FIXED_SESSION_ID));
    await vi.advanceTimersByTimeAsync(800);
    expect(child.kill).not.toHaveBeenCalled();

    // 直近の data から 1000ms 経過 → SIGTERM
    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', null, 'SIGTERM');
    const result = await promise;
    expect(result.status).toBe('stalled');
  });

  it('onActivity が stdout chunk ごとに呼ばれる (#87)', async () => {
    const { spawn, calls } = createSpawnFn();
    const onActivity = vi.fn();
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 60_000,
        stallTimeoutMs: 0,
        onActivity,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;

    child.stdout.write(makeSystemLine(FIXED_SESSION_ID));
    child.stdout.write(
      makeResultLine({
        sessionId: FIXED_SESSION_ID,
        subtype: 'success',
        isError: false,
        numTurns: 1,
        totalCostUsd: 0.01,
        resultText: 'ok',
      }),
    );
    child.stdout.end();
    child.emit('close', 0, null);
    const result = await promise;

    expect(result.status).toBe('success');
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(onActivity.mock.calls[0]![0]).toBeInstanceOf(Date);
  });

  it('stallTimeoutMs=0 で stall detection が無効化される', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(
      baseOptions({
        spawn,
        timeoutMs: 60_000,
        stallTimeoutMs: 0,
      }),
    );
    const call = await waitForSpawn(calls);
    const child = call.child;

    // 30 秒経過しても何も起きない
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill).not.toHaveBeenCalled();

    // 自然完了
    child.stdout.write(
      makeSystemLine(FIXED_SESSION_ID) +
        makeResultLine({
          sessionId: FIXED_SESSION_ID,
          subtype: 'success',
          isError: false,
          numTurns: 1,
          totalCostUsd: 0.01,
          resultText: 'ok',
        }),
    );
    child.stdout.end();
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.status).toBe('success');
  });
});

describe('runClaude — multi-turn loop (#25)', () => {
  it('maxTurns=1 (default) では 1 回しか spawn しない (回帰)', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn }));

    const call = await waitForSpawn(calls);
    call.child.stdout.write(
      makeSystemLine(FIXED_SESSION_ID) +
        makeResultLine({
          sessionId: FIXED_SESSION_ID,
          subtype: 'success',
          isError: false,
          numTurns: 1,
          totalCostUsd: 0.01,
          resultText: 'done',
        }),
    );
    call.child.stdout.end();
    call.child.emit('close', 0, null);
    const result = await promise;

    expect(calls).toHaveLength(1);
    expect(result.status).toBe('success');
    expect(result.turns).toBe(1);
  });

  it('error_max_turns で打ち切られたら --resume <UUID> で次ターンに進む', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(
      baseOptions({
        spawn,
        sessionId: FIXED_SESSION_ID,
        maxTurns: 2,
      }),
    );

    // 1 ターン目: error_max_turns で完了
    const call1 = await waitForSpawn(calls);
    expect(call1.args).toContain('--session-id');
    expect(call1.args).toContain(FIXED_SESSION_ID);
    expect(call1.args).not.toContain('--resume');

    call1.child.stdout.write(
      makeSystemLine(FIXED_SESSION_ID) +
        makeResultLine({
          sessionId: FIXED_SESSION_ID,
          subtype: 'error_max_turns',
          isError: true,
          numTurns: 50,
          totalCostUsd: 1.5,
          resultText: '',
        }),
    );
    call1.child.stdout.end();
    call1.child.emit('close', 0, null);

    // 2 ターン目: --resume で再開
    for (let i = 0; i < 50 && calls.length < 2; i++) await Promise.resolve();
    expect(calls).toHaveLength(2);
    const call2 = calls[1]!;
    expect(call2.args).toContain('--resume');
    expect(call2.args).toContain(FIXED_SESSION_ID);
    expect(call2.args).not.toContain('--session-id');
    // continuationPrompt が渡されている (元の prompt は使わない)
    const promptIndex = call2.args.indexOf('-p');
    expect(call2.args[promptIndex + 1]).not.toBe('say hi');

    call2.child.stdout.write(
      makeSystemLine(FIXED_SESSION_ID) +
        makeResultLine({
          sessionId: FIXED_SESSION_ID,
          subtype: 'success',
          isError: false,
          numTurns: 3,
          totalCostUsd: 0.5,
          resultText: 'finally done',
        }),
    );
    call2.child.stdout.end();
    call2.child.emit('close', 0, null);

    const result = await promise;
    expect(result.status).toBe('success');
    expect(result.turns).toBe(2);
    // session_id は両ターンで保持される (Acceptance Criteria 3)
    expect(result.sessionId).toBe(FIXED_SESSION_ID);
    // numTurns / totalCostUsd は加算される
    expect(result.numTurns).toBe(53);
    expect(result.totalCostUsd).toBeCloseTo(2.0, 6);
    // finalText は最終ターンのもの
    expect(result.finalText).toBe('finally done');
  });

  it('maxTurns=2 でも 1 ターン目が success なら loop に入らない', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(baseOptions({ spawn, maxTurns: 2 }));

    const call = await waitForSpawn(calls);
    call.child.stdout.write(
      makeSystemLine(FIXED_SESSION_ID) +
        makeResultLine({
          sessionId: FIXED_SESSION_ID,
          subtype: 'success',
          isError: false,
          numTurns: 1,
          totalCostUsd: 0.01,
          resultText: 'done',
        }),
    );
    call.child.stdout.end();
    call.child.emit('close', 0, null);

    const result = await promise;
    expect(calls).toHaveLength(1);
    expect(result.turns).toBe(1);
  });

  it('maxTurns 上限に達したらそれ以上 resume しない', async () => {
    const { spawn, calls } = createSpawnFn();
    const promise = runClaude(
      baseOptions({
        spawn,
        sessionId: FIXED_SESSION_ID,
        maxTurns: 2,
      }),
    );

    // 1 ターン目 + 2 ターン目 とも error_max_turns
    for (let turn = 0; turn < 2; turn++) {
      for (let i = 0; i < 50 && calls.length <= turn; i++) await Promise.resolve();
      const call = calls[turn]!;
      call.child.stdout.write(
        makeSystemLine(FIXED_SESSION_ID) +
          makeResultLine({
            sessionId: FIXED_SESSION_ID,
            subtype: 'error_max_turns',
            isError: true,
            numTurns: 50,
            totalCostUsd: 1.0,
            resultText: '',
          }),
      );
      call.child.stdout.end();
      call.child.emit('close', 0, null);
    }

    const result = await promise;
    expect(calls).toHaveLength(2); // 3 ターン目には進まない
    expect(result.turns).toBe(2);
    expect(result.status).toBe('failed');
    expect(result.resultSubtype).toBe('error_max_turns');
  });

  it('InvalidRunOptionsError: maxTurns に小数を渡すと検証エラー', async () => {
    await expect(runClaude(baseOptions({ maxTurns: 1.5 }))).rejects.toBeInstanceOf(
      InvalidRunOptionsError,
    );
  });

  it('InvalidRunOptionsError: stallTimeoutMs に負数を渡すと検証エラー', async () => {
    await expect(runClaude(baseOptions({ stallTimeoutMs: -1 }))).rejects.toBeInstanceOf(
      InvalidRunOptionsError,
    );
  });
});
