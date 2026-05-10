import { describe, expect, it } from 'vitest';

import {
  configSchema,
  DEFAULT_AGENT_MAX_CONCURRENT_AGENTS,
  DEFAULT_AGENT_MAX_RETRY_ATTEMPTS,
  DEFAULT_AGENT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_BASE_BRANCH,
  DEFAULT_CLEAN_RETENTION_DAYS,
  DEFAULT_DISPATCH_STATUSES,
  DEFAULT_GITHUB_TOKEN_SOURCE,
  DEFAULT_KILL_GRACE_PERIOD_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_SAFETY_ALLOW_BYPASS_IN_SERVE,
  DEFAULT_STATUS_FIELD,
  DEFAULT_STATUS_TRANSITION_FAILED,
  DEFAULT_STATUS_TRANSITION_IN_PROGRESS,
  DEFAULT_STATUS_TRANSITION_IN_REVIEW,
  DEFAULT_TERMINAL_STATUSES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WORKFLOW_FILE,
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
      workflowFile: DEFAULT_WORKFLOW_FILE,
      agentUserLogin: null,
      permissionMode: DEFAULT_PERMISSION_MODE,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      killGracePeriodMs: DEFAULT_KILL_GRACE_PERIOD_MS,
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      dispatchStatuses: [...DEFAULT_DISPATCH_STATUSES],
      terminalStatuses: [...DEFAULT_TERMINAL_STATUSES],
      statusTransitions: {
        inProgress: DEFAULT_STATUS_TRANSITION_IN_PROGRESS,
        inReview: DEFAULT_STATUS_TRANSITION_IN_REVIEW,
        failed: DEFAULT_STATUS_TRANSITION_FAILED,
      },
      cleanRetentionDays: DEFAULT_CLEAN_RETENTION_DAYS,
      logLevel: DEFAULT_LOG_LEVEL,
      polling: { intervalMs: DEFAULT_POLLING_INTERVAL_MS },
      agent: {
        maxConcurrentAgents: DEFAULT_AGENT_MAX_CONCURRENT_AGENTS,
        maxTurns: DEFAULT_AGENT_MAX_TURNS,
        stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
        maxRetryAttempts: DEFAULT_AGENT_MAX_RETRY_ATTEMPTS,
        maxRetryBackoffMs: DEFAULT_AGENT_MAX_RETRY_BACKOFF_MS,
      },
      hooks: {
        afterCreate: [],
        beforeRun: [],
        afterRun: [],
        beforeRemove: [],
      },
      server: null,
      github: { tokenSource: DEFAULT_GITHUB_TOKEN_SOURCE },
      safety: { allowBypassInServe: DEFAULT_SAFETY_ALLOW_BYPASS_IN_SERVE },
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
      workflow_file: 'PROMPT.md',
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
    expect(parsed.workflowFile).toBe('PROMPT.md');
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

  it('workflow_file 未指定時は WORKFLOW.md が補完される (#27)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.workflowFile).toBe(DEFAULT_WORKFLOW_FILE);
  });

  it('workflow_file が空文字だと検証エラーになる (#27)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      workflow_file: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['workflow_file']);
    }
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

  it('retry キー (撤廃済) を渡すと strict で拒否する (ADR-0005)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      retry: { max_attempts: 3 },
    });
    expect(result.success).toBe(false);
  });

  it('status_transitions が未指定なら default (In Progress / In Review / Failed) が補完される', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.statusTransitions).toEqual({
      inProgress: DEFAULT_STATUS_TRANSITION_IN_PROGRESS,
      inReview: DEFAULT_STATUS_TRANSITION_IN_REVIEW,
      failed: DEFAULT_STATUS_TRANSITION_FAILED,
    });
  });

  it('status_transitions の一部だけ指定しても残りはデフォルトで埋まる', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      status_transitions: { in_progress: 'Working' },
    });
    expect(parsed.statusTransitions).toEqual({
      inProgress: 'Working',
      inReview: DEFAULT_STATUS_TRANSITION_IN_REVIEW,
      failed: DEFAULT_STATUS_TRANSITION_FAILED,
    });
  });

  it('status_transitions の値が空文字なら拒否する', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      status_transitions: { in_progress: '' },
    });
    expect(result.success).toBe(false);
  });

  it('status_transitions の未知キーは strict で拒否する', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      status_transitions: { in_progress: 'Working', done: 'Done' },
    });
    expect(result.success).toBe(false);
  });

  it('agent キーが完全に未指定でもデフォルト値が補完される (#24 / #25 / #84)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.agent).toEqual({
      maxConcurrentAgents: DEFAULT_AGENT_MAX_CONCURRENT_AGENTS,
      maxTurns: DEFAULT_AGENT_MAX_TURNS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      maxRetryAttempts: DEFAULT_AGENT_MAX_RETRY_ATTEMPTS,
      maxRetryBackoffMs: DEFAULT_AGENT_MAX_RETRY_BACKOFF_MS,
    });
  });

  it('agent: {} だけ指定でもデフォルト値が補完される', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent: {},
    });
    expect(parsed.agent).toEqual({
      maxConcurrentAgents: DEFAULT_AGENT_MAX_CONCURRENT_AGENTS,
      maxTurns: DEFAULT_AGENT_MAX_TURNS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      maxRetryAttempts: DEFAULT_AGENT_MAX_RETRY_ATTEMPTS,
      maxRetryBackoffMs: DEFAULT_AGENT_MAX_RETRY_BACKOFF_MS,
    });
  });

  it('agent.max_concurrent_agents を明示指定すると camelCase で取り出せる', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_concurrent_agents: 5 },
    });
    expect(parsed.agent).toEqual({
      maxConcurrentAgents: 5,
      maxTurns: DEFAULT_AGENT_MAX_TURNS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      maxRetryAttempts: DEFAULT_AGENT_MAX_RETRY_ATTEMPTS,
      maxRetryBackoffMs: DEFAULT_AGENT_MAX_RETRY_BACKOFF_MS,
    });
  });

  it('agent.max_retry_attempts / agent.max_retry_backoff_ms を camelCase で取り出せる (#84)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_retry_attempts: 0, max_retry_backoff_ms: 60_000 },
    });
    expect(parsed.agent.maxRetryAttempts).toBe(0);
    expect(parsed.agent.maxRetryBackoffMs).toBe(60_000);
  });

  it('agent.max_retry_attempts が負数だと検証エラーになる (#84)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_retry_attempts: -1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['agent', 'max_retry_attempts']);
    }
  });

  it('agent.max_retry_backoff_ms は 0 / 負数を許さない (#84)', () => {
    expect(
      configSchema.safeParse({
        owner: 'hexylab',
        project_number: 1,
        agent: { max_retry_backoff_ms: 0 },
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        owner: 'hexylab',
        project_number: 1,
        agent: { max_retry_backoff_ms: -100 },
      }).success,
    ).toBe(false);
  });

  it('agent.max_turns / agent.stall_timeout_ms を camelCase で取り出せる (#25)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_turns: 10, stall_timeout_ms: 60_000 },
    });
    expect(parsed.agent.maxTurns).toBe(10);
    expect(parsed.agent.stallTimeoutMs).toBe(60_000);
  });

  it('agent.max_turns が 0 以下だと検証エラーになる (#25)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_turns: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['agent', 'max_turns']);
    }
  });

  it('agent.max_turns が小数だと検証エラーになる (#25)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_turns: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('agent.stall_timeout_ms は 0 を許可する (stall detection 無効化, #25)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      agent: { stall_timeout_ms: 0 },
    });
    expect(parsed.agent.stallTimeoutMs).toBe(0);
  });

  it('agent.stall_timeout_ms が負数だと検証エラーになる (#25)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { stall_timeout_ms: -1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['agent', 'stall_timeout_ms']);
    }
  });

  it('agent.max_concurrent_agents が 0 以下だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_concurrent_agents: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['agent', 'max_concurrent_agents']);
    }
  });

  it('agent.max_concurrent_agents が小数だと検証エラーになる', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_concurrent_agents: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('agent 配下の未知キーは strict で拒否する', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      agent: { max_concurrent_agents: 3, by_state: 'foo' },
    });
    expect(result.success).toBe(false);
  });

  it('hooks 未指定時は全 event 空配列に補完される (#26)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.hooks).toEqual({
      afterCreate: [],
      beforeRun: [],
      afterRun: [],
      beforeRemove: [],
    });
  });

  it('hooks 配下の各 event は配列で受け取る (#26)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      hooks: {
        after_create: [
          { command: 'pnpm', args: ['install'], timeout_ms: 60_000, on_failure: 'fail' },
        ],
        before_run: [],
        after_run: [],
        before_remove: [{ command: 'echo', args: ['bye'] }],
      },
    });
    expect(parsed.hooks.afterCreate).toEqual([
      { command: 'pnpm', args: ['install'], timeoutMs: 60_000, onFailure: 'fail' },
    ]);
    expect(parsed.hooks.beforeRemove[0]).toEqual({
      command: 'echo',
      args: ['bye'],
      timeoutMs: 60_000,
      onFailure: 'fail',
    });
  });

  it('hooks の各 entry は command が必須 (#26)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      hooks: {
        after_create: [{ args: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('hooks の on_failure は continue / fail のみ許可する (#26)', () => {
    expect(
      configSchema.safeParse({
        owner: 'hexylab',
        project_number: 1,
        hooks: {
          after_create: [{ command: 'echo', on_failure: 'panic' }],
        },
      }).success,
    ).toBe(false);
  });

  it('hooks の timeout_ms は 1 以上の整数 (#26)', () => {
    expect(
      configSchema.safeParse({
        owner: 'hexylab',
        project_number: 1,
        hooks: {
          after_create: [{ command: 'echo', timeout_ms: 0 }],
        },
      }).success,
    ).toBe(false);
  });

  it('hooks 配下の未知キーは strict で拒否する (#26)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      hooks: {
        after_create: [],
        unknown_event: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('server 未指定時は null になる (#30)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.server).toBeNull();
  });

  it('server.port を指定すると port が camelCase で展開される (#30)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      server: { port: 4000 },
    });
    expect(parsed.server).toEqual({ port: 4000 });
  });

  it('server.port は 1..65535 の整数のみ許可 (#30)', () => {
    for (const invalid of [0, -1, 65_536, 1.5]) {
      const result = configSchema.safeParse({
        owner: 'hexylab',
        project_number: 1,
        server: { port: invalid },
      });
      expect(result.success).toBe(false);
    }
  });

  it('server 配下の未知キーは strict で拒否する (#30)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      server: { port: 4000, host: '0.0.0.0' },
    });
    expect(result.success).toBe(false);
  });

  it('server.port を欠いた server セクションは reject (#30)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      server: {},
    });
    expect(result.success).toBe(false);
  });

  it('github 未指定時は token_source: auto が補完される (#68)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.github).toEqual({ tokenSource: 'auto' });
  });

  it('github.token_source は env / gh / auto のみ許可する (#68)', () => {
    for (const source of ['env', 'gh', 'auto']) {
      const parsed = configSchema.parse({
        owner: 'hexylab',
        project_number: 1,
        github: { token_source: source },
      });
      expect(parsed.github.tokenSource).toBe(source);
    }
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      github: { token_source: 'pat' },
    });
    expect(result.success).toBe(false);
  });

  it('github 配下の未知キー (token 直書き等) は strict で拒否する (#68)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      github: { token: 'ghp_xxx' },
    });
    expect(result.success).toBe(false);
  });

  it('safety 未指定時は allow_bypass_in_serve: false が補完される (#68)', () => {
    const parsed = configSchema.parse({ owner: 'hexylab', project_number: 1 });
    expect(parsed.safety).toEqual({ allowBypassInServe: false });
  });

  it('safety.allow_bypass_in_serve に boolean を渡すと camelCase で取り出せる (#68)', () => {
    const parsed = configSchema.parse({
      owner: 'hexylab',
      project_number: 1,
      safety: { allow_bypass_in_serve: true },
    });
    expect(parsed.safety.allowBypassInServe).toBe(true);
  });

  it('safety 配下の未知キーは strict で拒否する (#68)', () => {
    const result = configSchema.safeParse({
      owner: 'hexylab',
      project_number: 1,
      safety: { allow_bypass_in_serve: true, danger: true },
    });
    expect(result.success).toBe(false);
  });
});
