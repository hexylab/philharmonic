import { describe, expect, it } from 'vitest';

import {
  configSchema,
  DEFAULT_BASE_BRANCH,
  DEFAULT_CLEAN_RETENTION_DAYS,
  DEFAULT_DISPATCH_STATUSES,
  DEFAULT_KILL_GRACE_PERIOD_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PERMISSION_MODE,
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
});
