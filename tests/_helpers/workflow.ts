import { createWorkflowSource, type WorkflowSource } from '../../src/workflow/index.js';

/**
 * Tests where workflow templating is not the focus: spawn a no-op WorkflowSource that
 * falls back to the existing `buildPrompt` (= デフォルト挙動) by pointing at a path
 * that is guaranteed not to exist.
 */
export async function makeFallbackWorkflowSource(
  baseDir: string = '/tmp',
): Promise<WorkflowSource> {
  return await createWorkflowSource({
    workflowPath: `${baseDir}/__no_such_workflow_${process.pid}.md`,
    fallbackOnMissing: true,
  });
}
