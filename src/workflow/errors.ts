export class WorkflowFileNotFoundError extends Error {
  public readonly code = 'workflow_file_not_found';

  constructor(public readonly workflowPath: string) {
    super(`WORKFLOW.md が見つかりません (path: ${workflowPath})`);
    this.name = 'WorkflowFileNotFoundError';
  }
}

export class WorkflowReadError extends Error {
  public readonly code = 'workflow_read_error';

  constructor(
    public readonly workflowPath: string,
    public override readonly cause: unknown,
  ) {
    super(`WORKFLOW.md の読み込みに失敗しました (path: ${workflowPath}): ${describeCause(cause)}`);
    this.name = 'WorkflowReadError';
  }
}

export class WorkflowRenderError extends Error {
  public readonly code = 'workflow_render_error';

  constructor(
    public readonly workflowPath: string,
    public override readonly cause: unknown,
  ) {
    super(
      `WORKFLOW.md のテンプレート評価に失敗しました (path: ${workflowPath}): ${describeCause(cause)}`,
    );
    this.name = 'WorkflowRenderError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
