export class ServeLockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number,
    public readonly hostname: string,
    public readonly startedAt: string | null,
  ) {
    super(
      `serve は既に起動中の可能性があります (lock: ${lockPath}, pid=${holderPid}, host=${hostname})。` +
        `別プロセスを停止するか、不要なら lock ファイルを削除してください`,
    );
    this.name = 'ServeLockHeldError';
  }
}

export class ServeLockHeldOnDifferentHostError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number,
    public readonly hostname: string,
  ) {
    super(
      `serve lock が別ホストで保持されています (lock: ${lockPath}, pid=${holderPid}, host=${hostname})。` +
        `共有ファイルシステム経由の誤検出を避けるため自動奪取しません。手動で確認してください`,
    );
    this.name = 'ServeLockHeldOnDifferentHostError';
  }
}
