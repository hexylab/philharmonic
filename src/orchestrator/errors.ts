export type FailureReason =
  | 'workspace_provisioning'
  | 'runner_error'
  | 'timeout'
  | 'stalled'
  | 'hook_failed';

export type BootstrapErrorReason = 'github_token_missing' | 'config_load_failed';

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
