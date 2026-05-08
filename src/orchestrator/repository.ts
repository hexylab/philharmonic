export class InvalidRepositoryError extends Error {
  public readonly code = 'invalid_repository';

  constructor(public readonly value: string) {
    super(
      `repositoryNameWithOwner は 'owner/name' 形式で指定してください (受け取った値: ${value})`,
    );
    this.name = 'InvalidRepositoryError';
  }
}

export type Repository = { owner: string; name: string };

export function parseRepositoryNameWithOwner(value: string): Repository {
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new InvalidRepositoryError(value);
  }
  return { owner: parts[0]!, name: parts[1]! };
}
