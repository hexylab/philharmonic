export {
  createDependencyIssueFetcher,
  logDependencyEvaluation,
  type DependencyIssueFetcherDeps,
} from './dependency-filter.js';
export { BootstrapError, type BootstrapErrorReason, type FailureReason } from './errors.js';
export {
  buildMarker as buildExhaustionMarker,
  notifyFailureExhausted,
  renderExhaustionComment,
  resolveCommentBodyPath as resolveExhaustionCommentBodyPath,
  type ExhaustionNotifyDeps,
  type ExhaustionNotifyInput,
  type ExhaustionNotifyResult,
} from './exhaustion-notify.js';
export {
  renderFailureSummary,
  resolveFailureSummaryPath,
  writeFailureSummary,
  type FailureSummaryArtifact,
  type FailureSummaryInput,
} from './failure-summary.js';
export { fetchBaseBranch } from './git.js';
export {
  InvalidRepositoryError,
  parseRepositoryNameWithOwner,
  type Repository,
} from './repository.js';
export { dispatchPool } from './pool.js';
export {
  dispatchSelected,
  runConcurrent,
  runOnce,
  type ConcurrentDispatchOutcome,
  type DispatchSelectedDeps,
  type NotifyFailureExhaustedFn,
  type RunConcurrentDeps,
  type RunOnceClock,
  type RunOnceDeps,
  type RunOnceResult,
} from './run.js';
export { recoverInProgress, type RecoveryDeps, type RecoverySummary } from './recovery.js';
export {
  cleanupStaleWorktreesAtStartup,
  type CleanupStaleWorktreesAtStartupDeps,
  type CleanupStaleWorktreesSummary,
} from './stale-cleanup.js';
export {
  computeRetryDelayMs,
  CONTINUATION_RETRY_DELAY_MS,
  createRetryQueue,
  type CreateRetryQueueOptions,
  type RescheduleInput as RetryQueueRescheduleInput,
  type RetryEntry,
  type RetryKind,
  type RetryQueue,
  type ScheduleInput as RetryQueueScheduleInput,
} from './retry-queue.js';
export {
  createRetryQueueFileStore,
  loadRetryQueueEntries,
  RETRY_QUEUE_STATE_FILE_RELATIVE,
  RETRY_QUEUE_STATE_VERSION,
  type InvalidEntryReport,
  type LoadResult as RetryQueueLoadResult,
  type RetryEntryJson,
  type RetryQueueStateJson,
  type RetryQueueStore,
} from './retry-queue-store.js';
export {
  releaseRestoredRetries,
  type ReleaseRestoredRetriesDeps,
  type ReleaseRestoredRetriesSummary,
} from './retry-queue-restore.js';
export {
  abortableSleep,
  serveLoop,
  type ServeLoopDeps,
  type ServeLoopRunOnce,
  type ServeLoopSleep,
} from './serve.js';
export {
  checkDispatchGuard,
  DEFAULT_DISPATCH_STATUSES,
  DEFAULT_SKIP_LABEL,
  isAcceptableIssue,
  selectFirstByStatus,
  type CheckDispatchGuardResult,
  type DispatchGuard,
  type DispatchGuardSkipReason,
  type IsAcceptableIssueInput,
  type IsAcceptableIssueResult,
  type IssueAssigneeView,
  type IssueLabelView,
  type SelectCandidateInput,
} from './select.js';
export { buildIssueSlug, FALLBACK_SLUG } from './slug.js';
export {
  runWatchdog,
  type RunMetadataSnapshot,
  type RunWatchdogDeps,
  type WatchdogMarker,
  type WatchdogReason,
  type WatchdogRepair,
  type WatchdogResult,
} from './watchdog.js';
