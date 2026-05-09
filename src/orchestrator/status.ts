import type { ProjectMetadata } from '../projects/index.js';

export type StatusName = 'In Progress' | 'In Review' | 'Failed';

export const REQUIRED_STATUS_NAMES: readonly StatusName[] = ['In Progress', 'In Review', 'Failed'];

export class MissingStatusOptionError extends Error {
  public readonly code = 'missing_status_option';

  constructor(
    public readonly statusName: StatusName,
    public readonly availableNames: readonly string[],
  ) {
    const list = availableNames.length === 0 ? '(なし)' : availableNames.join(', ');
    super(`Status field に option '${statusName}' が見つかりません (現存 option: ${list})`);
    this.name = 'MissingStatusOptionError';
  }
}

export type StatusOptionMap = Readonly<Record<StatusName, string>>;

export function resolveStatusOptions(metadata: ProjectMetadata): StatusOptionMap {
  const map = new Map<string, string>();
  for (const o of metadata.statusOptions) map.set(o.name, o.id);
  const partial: Partial<Record<StatusName, string>> = {};
  for (const name of REQUIRED_STATUS_NAMES) {
    const id = map.get(name);
    if (id === undefined) {
      throw new MissingStatusOptionError(
        name,
        metadata.statusOptions.map((o) => o.name),
      );
    }
    partial[name] = id;
  }
  return partial as StatusOptionMap;
}
