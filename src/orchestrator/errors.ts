export type FailureReason =
  | 'workspace_provisioning'
  | 'runner_error'
  | 'timeout'
  | 'stalled'
  | 'no_changes'
  | 'push'
  | 'pr_create';

export type BootstrapErrorReason =
  | 'github_token_missing'
  | 'config_load_failed'
  | 'metadata_load_failed'
  | 'status_transition_to_in_progress_failed';

export class BootstrapError extends Error {
  public readonly code = 'orchestrator_bootstrap_error';

  constructor(
    public readonly reason: BootstrapErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'BootstrapError';
  }
}
