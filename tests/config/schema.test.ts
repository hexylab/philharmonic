import { describe, expect, it } from 'vitest';

import {
  configSchema,
  DEFAULT_BASE_BRANCH,
  DEFAULT_KILL_GRACE_PERIOD_MS,
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
    });
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
});
