export {
  listIssueWorktrees,
  selectExpiredWorktrees,
  type IssueWorktree,
  type ListIssueWorktreesInput,
  type SelectExpiredOptions,
  type StatFn,
} from './clean.js';
export {
  GitCommandError,
  InvalidBranchNameError,
  InvalidTaskKeyError,
  PathTraversalError,
  WorkspaceConflictError,
} from './errors.js';
export { defaultGitRunner, parseWorktreeList, type GitRunner, type WorktreeEntry } from './git.js';
export {
  DEFAULT_HOOK_KILL_GRACE_PERIOD_MS,
  EMPTY_HOOK_CONFIG_MAP,
  HOOK_EVENTS,
  HookExecutionError,
  HookTimeoutError,
  defaultHookExecutor,
  runHooksForEvent,
  type HookConfig,
  type HookConfigMap,
  type HookContext,
  type HookEvent,
  type HookExecutor,
  type HookExecutorInput,
  type HookFailureMode,
  type RunHooksInput,
} from './hooks.js';
export {
  createWorkspaceManager,
  type CleanupWorkspaceInput,
  type CreateWorkspaceInput,
  type Workspace,
  type WorkspaceManager,
  type WorkspaceManagerOptions,
} from './manager.js';
export { FALLBACK_BRANCH_SEGMENT, sanitizeBranchName } from './sanitize.js';
export {
  executeStaleCleanup,
  planStaleWorktreeCleanup,
  type ExecuteStaleCleanupInput,
  type ExecuteStaleCleanupResult,
  type IsRunningFn,
  type ParseRepositoryFn,
  type PlanStaleWorktreeCleanupInput,
  type RepositoryRef,
  type StaleCleanupCandidate,
  type StaleCleanupOutcome,
  type StaleCleanupPlan,
  type StaleCleanupReason,
  type StaleCleanupSkip,
  type StaleCleanupSkipReason,
} from './stale-cleanup.js';
