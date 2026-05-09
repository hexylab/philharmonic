import { z } from 'zod';

import { LOG_LEVELS, type LogLevel } from '../logger/index.js';

export const DEFAULT_CONFIG_FILE = 'philharmonic.yaml';

export const DEFAULT_BASE_BRANCH = 'main';
export const DEFAULT_STATUS_FIELD = 'Status';
export const DEFAULT_WORKFLOW_FILE = 'WORKFLOW.md';
export const DEFAULT_PERMISSION_MODE = 'auto';
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;
export const DEFAULT_WORKSPACE_ROOT = '.philharmonic/worktrees';
export const DEFAULT_DISPATCH_STATUSES: readonly string[] = ['Todo'];
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
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_MAX_BACKOFF_MS = 10 * 60 * 1_000;
export const DEFAULT_AGENT_MAX_CONCURRENT_AGENTS = 1;
export const DEFAULT_AGENT_MAX_TURNS = 1;
export const DEFAULT_AGENT_STALL_TIMEOUT_MS = 5 * 60 * 1_000;

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

const retrySchema = z
  .object({
    max_attempts: z
      .number({ message: 'retry.max_attempts は 0 以上の整数で指定してください' })
      .int('retry.max_attempts は整数で指定してください')
      .nonnegative('retry.max_attempts は 0 以上で指定してください')
      .default(DEFAULT_RETRY_MAX_ATTEMPTS),
    max_backoff_ms: z
      .number({ message: 'retry.max_backoff_ms は正の整数で指定してください' })
      .int('retry.max_backoff_ms は整数で指定してください')
      .positive('retry.max_backoff_ms は 1 以上で指定してください')
      .default(DEFAULT_RETRY_MAX_BACKOFF_MS),
  })
  .strict()
  .default({
    max_attempts: DEFAULT_RETRY_MAX_ATTEMPTS,
    max_backoff_ms: DEFAULT_RETRY_MAX_BACKOFF_MS,
  });

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
    clean_retention_days: z
      .number({ message: 'clean_retention_days は 0 以上の数値で指定してください' })
      .nonnegative('clean_retention_days は 0 以上で指定してください')
      .default(DEFAULT_CLEAN_RETENTION_DAYS),
    log_level: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    polling: pollingSchema,
    retry: retrySchema,
    agent: agentSchema,
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
  cleanRetentionDays: raw.clean_retention_days,
  logLevel: raw.log_level,
  polling: {
    intervalMs: raw.polling.interval_ms,
  },
  retry: {
    maxAttempts: raw.retry.max_attempts,
    maxBackoffMs: raw.retry.max_backoff_ms,
  },
  agent: {
    maxConcurrentAgents: raw.agent.max_concurrent_agents,
    maxTurns: raw.agent.max_turns,
    stallTimeoutMs: raw.agent.stall_timeout_ms,
  },
}));

export type Config = z.infer<typeof configSchema>;
export type RawConfigInput = z.input<typeof rawConfigSchema>;
