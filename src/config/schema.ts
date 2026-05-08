import { z } from 'zod';

export const DEFAULT_CONFIG_FILE = 'philharmonic.yaml';

export const DEFAULT_BASE_BRANCH = 'main';
export const DEFAULT_STATUS_FIELD = 'Status';
export const DEFAULT_PERMISSION_MODE = 'auto';
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;
export const DEFAULT_WORKSPACE_ROOT = '.philharmonic/worktrees';

const rawConfigSchema = z
  .object({
    owner: z.string().min(1, 'owner は空文字以外の文字列で指定してください'),
    project_number: z
      .number({ message: 'project_number は正の整数で指定してください' })
      .int('project_number は整数で指定してください')
      .positive('project_number は 1 以上で指定してください'),
    base_branch: z.string().min(1).default(DEFAULT_BASE_BRANCH),
    status_field: z.string().min(1).default(DEFAULT_STATUS_FIELD),
    agent_user_login: z.string().min(1).nullable().default(null),
    permission_mode: z.enum(['auto', 'bypass']).default(DEFAULT_PERMISSION_MODE),
    timeout_ms: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    kill_grace_period_ms: z.number().int().nonnegative().default(DEFAULT_KILL_GRACE_PERIOD_MS),
    workspace_root: z.string().min(1).default(DEFAULT_WORKSPACE_ROOT),
  })
  .strict();

export const configSchema = rawConfigSchema.transform((raw) => ({
  owner: raw.owner,
  projectNumber: raw.project_number,
  baseBranch: raw.base_branch,
  statusField: raw.status_field,
  agentUserLogin: raw.agent_user_login,
  permissionMode: raw.permission_mode,
  timeoutMs: raw.timeout_ms,
  killGracePeriodMs: raw.kill_grace_period_ms,
  workspaceRoot: raw.workspace_root,
}));

export type Config = z.infer<typeof configSchema>;
export type RawConfigInput = z.input<typeof rawConfigSchema>;
