import { describe, expect, it, vi } from 'vitest';

import {
  HookExecutionError,
  HookTimeoutError,
  defaultHookExecutor,
  runHooksForEvent,
  type HookConfig,
  type HookContext,
  type HookExecutor,
} from '../../src/workspace/index.js';

const repoRoot = '/repo';

const baseContext: HookContext = {
  taskKey: 'issue-26',
  branch: 'feature/26-foo',
  workspacePath: '/repo/.philharmonic/worktrees/issue-26',
  baseRef: 'origin/main',
};

describe('runHooksForEvent', () => {
  it('hooks が空配列なら executor を呼ばない', async () => {
    const executor = vi.fn();
    await runHooksForEvent({
      event: 'after_create',
      hooks: [],
      context: baseContext,
      repoRoot,
      executor,
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('成功時は executor を逐次に呼ぶ', async () => {
    const executor = vi.fn(async () => undefined) as HookExecutor;
    const hooks: HookConfig[] = [
      { command: 'pnpm', args: ['install'], timeoutMs: 60_000, onFailure: 'fail' },
      { command: 'pnpm', args: ['build'], timeoutMs: 60_000, onFailure: 'fail' },
    ];

    await runHooksForEvent({
      event: 'after_create',
      hooks,
      context: baseContext,
      repoRoot,
      executor,
    });

    expect(executor).toHaveBeenCalledTimes(2);
    const first = vi.mocked(executor).mock.calls[0]?.[0];
    expect(first?.command).toBe('pnpm');
    expect(first?.args).toEqual(['install']);
    expect(first?.cwd).toBe(baseContext.workspacePath);
    expect(first?.event).toBe('after_create');
    expect(first?.env.PHILHARMONIC_EVENT).toBe('after_create');
    expect(first?.env.PHILHARMONIC_TASK_KEY).toBe('issue-26');
    expect(first?.env.PHILHARMONIC_BRANCH).toBe('feature/26-foo');
    expect(first?.env.PHILHARMONIC_BASE_REF).toBe('origin/main');
    expect(first?.env.PHILHARMONIC_REPO_ROOT).toBe('/repo');
  });

  it('extraEnv は env に merge される', async () => {
    const executor = vi.fn(async () => undefined) as HookExecutor;
    const hooks: HookConfig[] = [
      { command: 'echo', args: [], timeoutMs: 1_000, onFailure: 'fail' },
    ];

    await runHooksForEvent({
      event: 'after_run',
      hooks,
      context: {
        ...baseContext,
        extraEnv: {
          PHILHARMONIC_RUN_STATUS: 'success',
          PHILHARMONIC_ISSUE_NUMBER: '26',
        },
      },
      repoRoot,
      executor,
    });

    const call = vi.mocked(executor).mock.calls[0]?.[0];
    expect(call?.env.PHILHARMONIC_RUN_STATUS).toBe('success');
    expect(call?.env.PHILHARMONIC_ISSUE_NUMBER).toBe('26');
  });

  it('on_failure=fail の hook が失敗すると HookExecutionError を throw する', async () => {
    const error = new HookExecutionError('after_create', 'pnpm', 1, 'boom', '');
    const executor = vi.fn(async () => {
      throw error;
    }) as HookExecutor;
    const hooks: HookConfig[] = [
      { command: 'pnpm', args: ['install'], timeoutMs: 60_000, onFailure: 'fail' },
      { command: 'pnpm', args: ['build'], timeoutMs: 60_000, onFailure: 'fail' },
    ];

    await expect(
      runHooksForEvent({
        event: 'after_create',
        hooks,
        context: baseContext,
        repoRoot,
        executor,
      }),
    ).rejects.toBe(error);

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('on_failure=continue の hook が失敗しても後続 hook を続行する', async () => {
    const executor = vi
      .fn<Parameters<HookExecutor>, ReturnType<HookExecutor>>()
      .mockImplementationOnce(async () => {
        throw new HookExecutionError('after_create', 'flaky', 1, 'boom', '');
      })
      .mockImplementationOnce(async () => undefined) as unknown as HookExecutor;
    const hooks: HookConfig[] = [
      { command: 'flaky', args: [], timeoutMs: 60_000, onFailure: 'continue' },
      { command: 'next', args: [], timeoutMs: 60_000, onFailure: 'fail' },
    ];

    await runHooksForEvent({
      event: 'after_create',
      hooks,
      context: baseContext,
      repoRoot,
      executor,
    });

    expect(vi.mocked(executor)).toHaveBeenCalledTimes(2);
  });

  it('alwaysContinue=true なら on_failure=fail でも throw しない (before_remove 用)', async () => {
    const executor = vi.fn(async () => {
      throw new HookExecutionError('before_remove', 'cleanup', 1, 'fail', '');
    }) as HookExecutor;
    const hooks: HookConfig[] = [
      { command: 'cleanup', args: [], timeoutMs: 60_000, onFailure: 'fail' },
    ];

    await expect(
      runHooksForEvent({
        event: 'before_remove',
        hooks,
        context: baseContext,
        repoRoot,
        executor,
        alwaysContinue: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('HookTimeoutError も on_failure=fail なら伝播する', async () => {
    const error = new HookTimeoutError('before_run', 'slow', 5);
    const executor = vi.fn(async () => {
      throw error;
    }) as HookExecutor;
    const hooks: HookConfig[] = [{ command: 'slow', args: [], timeoutMs: 5, onFailure: 'fail' }];

    await expect(
      runHooksForEvent({
        event: 'before_run',
        hooks,
        context: baseContext,
        repoRoot,
        executor,
      }),
    ).rejects.toBe(error);
  });
});

describe('defaultHookExecutor', () => {
  it('成功時は resolve する (smoke test)', async () => {
    await expect(
      defaultHookExecutor({
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 10_000,
        killGracePeriodMs: 1_000,
        event: 'after_create',
      }),
    ).resolves.toBeUndefined();
  });

  it('非ゼロ exit は HookExecutionError として throw される', async () => {
    await expect(
      defaultHookExecutor({
        command: 'node',
        args: ['-e', 'process.exit(7)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 10_000,
        killGracePeriodMs: 1_000,
        event: 'after_create',
      }),
    ).rejects.toMatchObject({ name: 'HookExecutionError', exitCode: 7 });
  });

  it('timeout 超過は HookTimeoutError として throw される', async () => {
    await expect(
      defaultHookExecutor({
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 60_000)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 50,
        killGracePeriodMs: 100,
        event: 'before_run',
      }),
    ).rejects.toMatchObject({ name: 'HookTimeoutError', timeoutMs: 50 });
  }, 10_000);

  it('spawn 失敗 (PATH に無い) は HookExecutionError', async () => {
    await expect(
      defaultHookExecutor({
        command: '__philharmonic_nonexistent_cmd__',
        args: [],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        killGracePeriodMs: 100,
        event: 'after_create',
      }),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });
});
