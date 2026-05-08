import { describe, expect, it } from 'vitest';

import { MissingStatusOptionError, resolveStatusOptions } from '../../src/orchestrator/status.js';
import type { ProjectMetadata } from '../../src/projects/index.js';

function metadata(options: Array<{ id: string; name: string }>): ProjectMetadata {
  return { projectId: 'PVT_1', statusFieldId: 'PVTSSF_1', statusOptions: options };
}

describe('resolveStatusOptions', () => {
  it('In Progress / In Review / Failed の option ID を解決する', () => {
    const out = resolveStatusOptions(
      metadata([
        { id: 'opt_todo', name: 'Todo' },
        { id: 'opt_ip', name: 'In Progress' },
        { id: 'opt_ir', name: 'In Review' },
        { id: 'opt_fail', name: 'Failed' },
        { id: 'opt_done', name: 'Done' },
      ]),
    );
    expect(out['In Progress']).toBe('opt_ip');
    expect(out['In Review']).toBe('opt_ir');
    expect(out['Failed']).toBe('opt_fail');
  });

  it('必要な option が欠けると MissingStatusOptionError を throw する', () => {
    expect(() =>
      resolveStatusOptions(
        metadata([
          { id: 'opt_todo', name: 'Todo' },
          { id: 'opt_ip', name: 'In Progress' },
        ]),
      ),
    ).toThrow(MissingStatusOptionError);
  });
});
