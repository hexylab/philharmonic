import { describe, expect, it } from 'vitest';

import {
  configSchema,
  DEFAULT_BASE_BRANCH,
  DEFAULT_CLEAN_RETENTION_DAYS,
  DEFAULT_DISPATCH_STATUSES,
  DEFAULT_KILL_GRACE_PERIOD_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_BACKOFF_MS,
  DEFAULT_STATUS_FIELD,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ROOT,
} from '../../src/config/index.js';

describe('configSchema', () => {
  it('owner / project_number だけでデフォルトが補完される', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });

    expect(parsed).toEqual({
      owner: 'hexylab',
      projectNumber: 1,
      baseBranch: DEFAULT_BASE_BRANCH,
      statusField: DEFAULT_STATUS_FIELD,
      agentUserLogin: null,
      permissionMode: DEFAULT_PERMISSION_MODE,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      killGracePeriodMs: DEFAULT_KILL_GRACE_PERIOD_MS,
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      dispatchStatuses: [...DEFAULT_DISPATCH_STATUSES],
      cleanRetentionDays: DEFAULT_CLEAN_RETENTION_DAYS,
      logLevel: DEFAULT_LOG_LEVEL,
      polling: { intervalMs: DEFAULT_POLLING_INTERVAL_MS },
      retry: {
        maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
        maxBackoffMs: DEFAULT_RETRY_MAX_BACKOFF_MS,
      },
    });
  });

  it('log_level は debug / info / warn / error のみ許可する', () => {
    expect(
      configSchema.safeParse({ owner: 'hexylab', project_number: 1, log_level: 'trace' }).success,
    ).toBe(false);
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const parsed = configSchema.parse({
        owner: 'hexylab',
        project_number: 1,
        log_level: level,
      });
      expect(parsed.logLevel).toBe(level);
    }
  });

  it('log_level 未指定時はデフォルト (info) が補完される', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.logLevel).toBe(DEFAULT_LOG_LEVEL);
  });

  it('snake_case 入力を camelCase に正規化する', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 42,
      base_branch: 'develop',
      status_field: 'Workflow',
      agent_user_login: 'philharmonic-bot',
      permission_mode: 'bypass',
      timeout_ms: 60_000,
      kill_grace_period_ms: 1_000,
      workspace_root: '.tmp/worktrees',
      dispatch_statuses: ['Ready for Agent', 'Todo'],
      clean_retention_days: 14,
    });

    expect(parsed.owner).toBe('hexylab');
    expect(parsed.projectNumber).toBe(42);
    expect(parsed.baseBranch).toBe('develop');
    expect(parsed.statusField).toBe('Workflow');
    expect(parsed.agentUserLogin).toBe('philharmonic-bot');
    expect(parsed.permissionMode).toBe('bypass');
    expect(parsed.timeoutMs).toBe(60_000);
    expect(parsed.killGracePeriodMs).toBe(1_000);
    expect(parsed.workspaceRoot).toBe('.tmp/worktrees');
    expect(parsed.dispatchStatuses).toEqual(['Ready for Agent', 'Todo']);
    expect(parsed.cleanRetentionDays).toBe(14);
  });

  it('owner が空文字だと検証エラーになる', () => {
    const result = configSchema.safeParse({ owner: '', project_number: 1 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['owner']);
    }
  });

  it('project_number が 0 以下だと検証エラーになる', () => {
    const result = configSchema.safeParse({ owner: 'hexylab', project_number: 0 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['project_number']);
    }
  });

  it('project_number が小数だと検証エラーになる', () => {
    const result = configSchema.safeParse({ owner: 'hexylab', project_number: 1.5 });

    expect(result.success).toBe(false);
  });

  it('未知のキーは strict 設定で拒否する', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      unknown_field: 'x',
    });

    expect(result.success).toBe(false);
  });

  it('permission_mode は auto / bypass のみ許可する', () => {
    expect(
      configSchema.safeParse({ owner: 'hexylab', project_number: 1, permission_mode: 'plan' })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ owner: 'hexylab', project_number: 1, permission_mode: 'auto' })
        .success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ owner: 'hexylab', project_number: 1, permission_mode: 'bypass' })
        .success,
    ).toBe(true);
  });

  it('agent_user_login は null も明示指定もどちらも許可する', () => {
    const explicitNull = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent_user_login: null,
    });
    expect(explicitNull.agentUserLogin).toBeNull();

    const explicitLogin = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent_user_login: 'bot-x',
    });
    expect(explicitLogin.agentUserLogin).toBe('bot-x');
  });

  it('timeout_ms が 0 以下だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      timeout_ms: 0,
    });

    expect(result.success).toBe(false);
  });

  it('kill_grace_period_ms は 0 を許可する (即 SIGKILL 相当)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      kill_grace_period_ms: 0,
    });

    expect(parsed.killGracePeriodMs).toBe(0);
  });

  it('dispatch_statuses 未指定時は ["Todo"] が補完される (#38 互換性)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.dispatchStatuses).toEqual(['Todo']);
  });

  it('dispatch_statuses が空配列だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      dispatch_statuses: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['dispatch_statuses']);
    }
  });

  it('dispatch_statuses に空文字を含むと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      dispatch_statuses: ['Todo', ''],
    });

    expect(result.success).toBe(false);
  });

  it('dispatch_statuses に複数 Status を指定できる (#38)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      dispatch_statuses: ['Ready for Agent', 'Todo'],
    });
    expect(parsed.dispatchStatuses).toEqual(['Ready for Agent', 'Todo']);
  });

  it('clean_retention_days 未指定時はデフォルト値 (7) が補完される', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.cleanRetentionDays).toBe(DEFAULT_CLEAN_RETENTION_DAYS);
  });

  it('clean_retention_days は 0 を許可する (即時削除相当)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      clean_retention_days: 0,
    });
    expect(parsed.cleanRetentionDays).toBe(0);
  });

  it('clean_retention_days が負数だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      clean_retention_days: -1,
    });
    expect(result.success).toBe(false);
  });

  it('polling キーが完全に未指定でもデフォルト (30000) が補完される', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.polling).toEqual({ intervalMs: DEFAULT_POLLING_INTERVAL_MS });
  });

  it('polling: {} だけ指定でもデフォルト interval_ms が補完される', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      polling: {},
    });
    expect(parsed.polling).toEqual({ intervalMs: DEFAULT_POLLING_INTERVAL_MS });
  });

  it('polling.interval_ms を明示指定すると camelCase で取り出せる', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      polling: { interval_ms: 5000 },
    });
    expect(parsed.polling).toEqual({ intervalMs: 5000 });
  });

  it('polling.interval_ms が 0 以下だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      polling: { interval_ms: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['polling', 'interval_ms']);
    }
  });

  it('polling.interval_ms が下限 (1000ms) 未満だと検証エラーになる (Issue #49 hardening)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      polling: { interval_ms: 999 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['polling', 'interval_ms']);
      expect(result.error.issues[0]?.message).toContain('1000');
    }
  });

  it('polling.interval_ms = 1000 は受理される (下限ぴったり)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      polling: { interval_ms: 1000 },
    });
    expect(parsed.polling).toEqual({ intervalMs: 1000 });
  });

  it('polling 配下の未知キーは strict で拒否する', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      polling: { interval_ms: 5000, jitter_ms: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it('retry キーが完全に未指定でもデフォルト値が補完される', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.retry).toEqual({
      maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
      maxBackoffMs: DEFAULT_RETRY_MAX_BACKOFF_MS,
    });
  });

  it('retry: {} だけ指定でもデフォルト値が補完される', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      retry: {},
    });
    expect(parsed.retry).toEqual({
      maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
      maxBackoffMs: DEFAULT_RETRY_MAX_BACKOFF_MS,
    });
  });

  it('retry.max_attempts と retry.max_backoff_ms を camelCase で取り出せる', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_attempts: 5, max_backoff_ms: 60_000 },
    });
    expect(parsed.retry).toEqual({ maxAttempts: 5, maxBackoffMs: 60_000 });
  });

  it('retry.max_attempts は 0 を許可する (自動 retry 無効)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_attempts: 0 },
    });
    expect(parsed.retry.maxAttempts).toBe(0);
  });

  it('retry.max_attempts が負数だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_attempts: -1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['retry', 'max_attempts']);
    }
  });

  it('retry.max_attempts が小数だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_attempts: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('retry.max_backoff_ms が 0 以下だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_backoff_ms: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('retry 配下の未知キーは strict で拒否する', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_attempts: 3, jitter_ms: 1000 },
    });
    expect(result.success).toBe(false);
  });
});
