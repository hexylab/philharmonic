export class InvalidRunIdError extends Error {
  constructor(public readonly runId: string) {
    super(`run-id は UUID 形式で指定してください (受け取った値: '${runId}')`);
    this.name = 'InvalidRunIdError';
  }
}
