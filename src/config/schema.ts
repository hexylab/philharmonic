import { z } from 'zod';

import { LOG_LEVELS, type LogLevel } from '../logger/index.js';

/**
 * Philharmonic が読み書きするファイルは原則 `.philharmonic/` 配下に集約する (#67)。
 * 旧来 (`philharmonic.yaml` / `WORKFLOW.md` を repo root に置く) からの移行のため、
 * default 解決時に limit して legacy パスへ fallback する経路を loader / CLI 側で持つ。
 */
export const DEFAULT_CONFIG_FILE = '.philharmonic/philharmonic.yaml';
export const LEGACY_CONFIG_FILE = 'philharmonic.yaml';

export const DEFAULT_BASE_BRANCH = 'main';
export const DEFAULT_STATUS_FIELD = 'Status';
export const DEFAULT_WORKFLOW_FILE = '.philharmonic/WORKFLOW.md';
export const LEGACY_WORKFLOW_FILE = 'WORKFLOW.md';
export const DEFAULT_PERMISSION_MODE = 'auto';
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;
export const DEFAULT_WORKSPACE_ROOT = '.philharmonic/worktrees';
export const DEFAULT_DISPATCH_STATUSES: readonly string[] = ['Todo'];
export const DEFAULT_STATUS_TRANSITION_IN_PROGRESS = 'In Progress';
export const DEFAULT_STATUS_TRANSITION_IN_REVIEW = 'In Review';
export const DEFAULT_STATUS_TRANSITION_FAILED = 'Failed';
export const DEFAULT_CLEAN_RETENTION_DAYS = 7;
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_POLLING_INTERVAL_MS = 30_000;
export const MIN_POLLING_INTERVAL_MS = 1_000;
/**
 * 過剰 polling の suggestion threshold。下限 (`MIN_POLLING_INTERVAL_MS`) は超えているが
 * `LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS` 未満の場合、`philharmonic serve` 起動時に
 * 警告ログを 1 行出して GitHub API rate limit への注意を促す。
 */
export const LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS = 5_000;
export const DEFAULT_AGENT_MAX_CONCURRENT_AGENTS = 1;
export const DEFAULT_AGENT_MAX_TURNS = 1;
export const DEFAULT_AGENT_STALL_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 60 * 1_000;
export const DEFAULT_HOOK_ON_FAILURE = 'fail' as const;
export const SERVER_PORT_MIN = 1;
export const SERVER_PORT_MAX = 65_535;

const pollingSchema = z
  .object({
    interval_ms: z
      .number({ message: 'polling.interval_ms は正の整数で指定してください' })
      .int('polling.interval_ms は整数で指定してください')
      .min(
        MIN_POLLING_INTERVAL_MS,
        `polling.interval_ms は ${MIN_POLLING_INTERVAL_MS} 以上で指定してください (過剰 polling 防止のため)`,
      )
      .default(DEFAULT_POLLING_INTERVAL_MS),
  })
  .strict()
  .default({ interval_ms: DEFAULT_POLLING_INTERVAL_MS });

const agentSchema = z
  .object({
    max_concurrent_agents: z
      .number({ message: 'agent.max_concurrent_agents は 1 以上の整数で指定してください' })
      .int('agent.max_concurrent_agents は整数で指定してください')
      .positive('agent.max_concurrent_agents は 1 以上で指定してください')
      .default(DEFAULT_AGENT_MAX_CONCURRENT_AGENTS),
    max_turns: z
      .number({ message: 'agent.max_turns は 1 以上の整数で指定してください' })
      .int('agent.max_turns は整数で指定してください')
      .positive('agent.max_turns は 1 以上で指定してください')
      .default(DEFAULT_AGENT_MAX_TURNS),
    stall_timeout_ms: z
      .number({ message: 'agent.stall_timeout_ms は 0 以上の整数で指定してください' })
      .int('agent.stall_timeout_ms は整数で指定してください')
      .nonnegative('agent.stall_timeout_ms は 0 以上で指定してください')
      .default(DEFAULT_AGENT_STALL_TIMEOUT_MS),
  })
  .strict()
  .default({
    max_concurrent_agents: DEFAULT_AGENT_MAX_CONCURRENT_AGENTS,
    max_turns: DEFAULT_AGENT_MAX_TURNS,
    stall_timeout_ms: DEFAULT_AGENT_STALL_TIMEOUT_MS,
  });

const hookEntrySchema = z
  .object({
    command: z.string().min(1, 'hooks.*.command は空文字以外で指定してください'),
    args: z.array(z.string()).default([]),
    timeout_ms: z
      .number({ message: 'hooks.*.timeout_ms は 1 以上の整数で指定してください' })
      .int('hooks.*.timeout_ms は整数で指定してください')
      .positive('hooks.*.timeout_ms は 1 以上で指定してください')
      .default(DEFAULT_HOOK_TIMEOUT_MS),
    on_failure: z.enum(['continue', 'fail']).default(DEFAULT_HOOK_ON_FAILURE),
  })
  .strict();

const hooksSchema = z
  .object({
    after_create: z.array(hookEntrySchema).default([]),
    before_run: z.array(hookEntrySchema).default([]),
    after_run: z.array(hookEntrySchema).default([]),
    before_remove: z.array(hookEntrySchema).default([]),
  })
  .strict()
  .default({
    after_create: [],
    before_run: [],
    after_run: [],
    before_remove: [],
  });

const serverSchema = z
  .object({
    port: z
      .number({ message: 'server.port は 1..65535 の整数で指定してください' })
      .int('server.port は整数で指定してください')
      .min(SERVER_PORT_MIN, `server.port は ${SERVER_PORT_MIN} 以上で指定してください`)
      .max(SERVER_PORT_MAX, `server.port は ${SERVER_PORT_MAX} 以下で指定してください`),
  })
  .strict()
  .optional();

const statusTransitionsSchema = z
  .object({
    in_progress: z
      .string()
      .min(1, 'status_transitions.in_progress は空文字以外で指定してください')
      .default(DEFAULT_STATUS_TRANSITION_IN_PROGRESS),
    in_review: z
      .string()
      .min(1, 'status_transitions.in_review は空文字以外で指定してください')
      .default(DEFAULT_STATUS_TRANSITION_IN_REVIEW),
    failed: z
      .string()
      .min(1, 'status_transitions.failed は空文字以外で指定してください')
      .default(DEFAULT_STATUS_TRANSITION_FAILED),
  })
  .strict()
  .default({
    in_progress: DEFAULT_STATUS_TRANSITION_IN_PROGRESS,
    in_review: DEFAULT_STATUS_TRANSITION_IN_REVIEW,
    failed: DEFAULT_STATUS_TRANSITION_FAILED,
  });

const rawConfigSchema = z
  .object({
    owner: z.string().min(1, 'owner は空文字以外の文字列で指定してください'),
    project_number: z
      .number({ message: 'project_number は正の整数で指定してください' })
      .int('project_number は整数で指定してください')
      .positive('project_number は 1 以上で指定してください'),
    base_branch: z.string().min(1).default(DEFAULT_BASE_BRANCH),
    status_field: z.string().min(1).default(DEFAULT_STATUS_FIELD),
    workflow_file: z
      .string()
      .min(1, 'workflow_file は空文字以外で指定してください')
      .default(DEFAULT_WORKFLOW_FILE),
    agent_user_login: z.string().min(1).nullable().default(null),
    permission_mode: z.enum(['auto', 'bypass']).default(DEFAULT_PERMISSION_MODE),
    timeout_ms: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    kill_grace_period_ms: z.number().int().nonnegative().default(DEFAULT_KILL_GRACE_PERIOD_MS),
    workspace_root: z.string().min(1).default(DEFAULT_WORKSPACE_ROOT),
    dispatch_statuses: z
      .array(z.string().min(1, 'dispatch_statuses の各要素は空文字以外で指定してください'))
      .min(1, 'dispatch_statuses は 1 件以上の文字列配列で指定してください')
      .default([...DEFAULT_DISPATCH_STATUSES]),
    status_transitions: statusTransitionsSchema,
    clean_retention_days: z
      .number({ message: 'clean_retention_days は 0 以上の数値で指定してください' })
      .nonnegative('clean_retention_days は 0 以上で指定してください')
      .default(DEFAULT_CLEAN_RETENTION_DAYS),
    log_level: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    polling: pollingSchema,
    agent: agentSchema,
    hooks: hooksSchema,
    server: serverSchema,
  })
  .strict();

export const configSchema = rawConfigSchema.transform((raw) => ({
  owner: raw.owner,
  projectNumber: raw.project_number,
  baseBranch: raw.base_branch,
  statusField: raw.status_field,
  workflowFile: raw.workflow_file,
  agentUserLogin: raw.agent_user_login,
  permissionMode: raw.permission_mode,
  timeoutMs: raw.timeout_ms,
  killGracePeriodMs: raw.kill_grace_period_ms,
  workspaceRoot: raw.workspace_root,
  dispatchStatuses: raw.dispatch_statuses,
  statusTransitions: {
    inProgress: raw.status_transitions.in_progress,
    inReview: raw.status_transitions.in_review,
    failed: raw.status_transitions.failed,
  },
  cleanRetentionDays: raw.clean_retention_days,
  logLevel: raw.log_level,
  polling: {
    intervalMs: raw.polling.interval_ms,
  },
  agent: {
    maxConcurrentAgents: raw.agent.max_concurrent_agents,
    maxTurns: raw.agent.max_turns,
    stallTimeoutMs: raw.agent.stall_timeout_ms,
  },
  hooks: {
    afterCreate: raw.hooks.after_create.map(toHookConfig),
    beforeRun: raw.hooks.before_run.map(toHookConfig),
    afterRun: raw.hooks.after_run.map(toHookConfig),
    beforeRemove: raw.hooks.before_remove.map(toHookConfig),
  },
  server: raw.server === undefined ? null : { port: raw.server.port },
}));

function toHookConfig(raw: z.infer<typeof hookEntrySchema>): {
  command: string;
  args: string[];
  timeoutMs: number;
  onFailure: 'continue' | 'fail';
} {
  return {
    command: raw.command,
    args: raw.args,
    timeoutMs: raw.timeout_ms,
    onFailure: raw.on_failure,
  };
}

export type Config = z.infer<typeof configSchema>;
export type RawConfigInput = z.input<typeof rawConfigSchema>;
