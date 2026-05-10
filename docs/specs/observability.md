# Observability — 構造化ロガーの仕様

## 概要

Philharmonic は orchestrator / runner / cli の各レイヤで進捗・警告・失敗を **構造化ログ** として出力する。
`src/logger/` に薄い自作ロガーを置き、JSON line 形式で `stderr` に書き出す。`run_id` / `issue_number` /
`session_id` を child logger の bindings に持たせることで、ログ 1 行ずつへの識別子付与を構造的に保証する。

## 関連

- 設計判断: [ADR-0002 横串の構造化ロガーを自作で導入する](../adr/0002-structured-logger.md)
- 関連 Issue: #28 (`Refs: #19`)
- 関連 spec: [config-schema.md](./config-schema.md), [orchestration-mvp.md](./orchestration-mvp.md), [claude-runner.md](./claude-runner.md)

## 用語

| 用語          | 意味                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Logger**    | `src/logger/index.ts` から export される interface。`debug` / `info` / `warn` / `error` / `child` の 5 メソッドを持つ |
| **bindings**  | child logger を作る際に親に追加付与される fields。以降そのロガーから出るすべてのイベントに付く                        |
| **fields**    | 各イベントごとに `logger.info(msg, fields)` で渡す追加情報                                                            |
| **JSON line** | 1 イベント = 1 行の JSON。改行で区切り、`jq -c` で逐次処理可能                                                        |

## API

### `Logger` interface (`src/logger/index.ts`)

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type Logger = {
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
};

function createLogger(options?: {
  level?: LogLevel;
  destination?: NodeJS.WritableStream;
  bindings?: Record<string, unknown>;
  clock?: () => Date;
}): Logger;
```

| オプション    | 既定               | 説明                                                             |
| ------------- | ------------------ | ---------------------------------------------------------------- |
| `level`       | `'info'`           | 出力する最低レベル。`debug < info < warn < error` の優先度で判定 |
| `destination` | `process.stderr`   | 書き出し先 stream。テスト時は `Writable` を渡して capture できる |
| `bindings`    | `{}`               | このロガーから出る全イベントに付与される基準 fields              |
| `clock`       | `() => new Date()` | `ts` フィールドの生成元。テスト時に固定可能                      |

## 出力フォーマット (JSON line)

```json
{"ts":"2026-05-09T12:34:56.789Z","level":"info","msg":"candidate selected","run_id":"01956a91-...","issue_number":42}
{"ts":"2026-05-09T12:35:01.123Z","level":"warn","msg":"permission_mode=bypass で Claude Code を起動します","run_id":"01956a91-...","issue_number":42}
{"ts":"2026-05-09T12:40:11.456Z","level":"info","msg":"runner finished","run_id":"01956a91-...","issue_number":42,"session_id":"abcd1234-..."}
```

### キーの規約

- 固定キー: `ts` (ISO 8601), `level`, `msg`
- bindings + 呼び出し時 fields をトップレベルにマージして展開する
- **キーは snake_case で出力**:
  - 既存の `metadata.json` (`run_id`, `issue_number`, `total_cost_usd`) と整合
  - jq 運用慣例 (`.run_id`, `.session_id`) と整合
- コード内では camelCase の引数 (例: `{ runId, issueNumber, sessionId }`) を渡し、ロガーがシリアライズ時に
  **top-level だけ** snake_case に変換する。ネストオブジェクトは再帰しない (値オブジェクトをそのまま
  ダンプするケースで予期せぬキー変更を避けるため)

### フィールドの優先度

1. 固定キー (`ts` / `level` / `msg`) は呼び出し側 fields でも上書き不可
2. 呼び出し時 fields > bindings (同名キーは呼び出し側が勝つ)

## 出力先 (stderr)

- ログは **`stderr`** に出力する
- `philharmonic projects list` / `philharmonic clean` / `philharmonic run` が `stdout` に出す
  「コマンドの結果 (table / 一行サマリ / dry-run リスト)」とは責務を分離する
- `2>&1 | jq -c '.'` で全ログを JSON line として絞り込める

詳細は ADR-0002 の「Issue 文言からの逸脱について」を参照。

## ログレベルの制御

`philharmonic.yaml` の `log_level` キーで指定する。

```yaml
log_level: info # 既定。debug / info / warn / error から選択
```

CLI フラグや環境変数によるオーバーライドは MVP では未実装 (将来 `PHILHARMONIC_LOG_LEVEL` 等で
追加可能)。

## bindings の運用パターン

### `philharmonic run`

1. CLI レイヤで `createLogger({ level: config.logLevel })` を作る (bindings は空)
2. `runOnce` 冒頭で `runId` 確定後に `logger.child({ runId, issueNumber })` を作り、以降
   orchestrator 内ではこの child を使う
3. `runOnce` は `runClaude` に同じ logger を渡す
4. `runClaude` 内で subprocess の `system` イベントから `session_id` を取得した時点で
   `runLogger = logger.child({ sessionId })` に切り替え、以降の runner 内部ログ (`runner finished` /
   timeout 警告) に `session_id` を付与する

### イベント例

| 出る場所            | level   | msg                                                  | 主な fields                                                                       |
| ------------------- | ------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `runOnce`           | `info`  | `candidate selected`                                 | `run_id`, `issue_number`, `repository`                                            |
| `runOnce`           | `warn`  | `permission_mode=bypass で Claude Code を起動します` | `run_id`, `issue_number`                                                          |
| `runOnce`           | `info`  | `run completed successfully`                         | `run_id`, `issue_number`, `branch`                                                |
| `runOnce` (failure) | `error` | `run failed`                                         | `run_id`, `issue_number`, `reason`, `detail`                                      |
| `runClaude`         | `info`  | `runner started`                                     | `run_id`, `issue_number`, `command`, `permission_mode`                            |
| `runClaude`         | `info`  | `runner finished`                                    | `run_id`, `issue_number`, `session_id`, `status`, `duration_ms`, `total_cost_usd` |
| `runClaude`         | `warn`  | `runner timeout reached, sending SIGTERM`            | `run_id`, `issue_number`, `session_id`, `timeout_ms`                              |

`pr_number` フィールドは ADR-0005 で agent 委譲型に切り替えたため orchestrator が知れなくなり、構造化ログから外れた。PR 番号を追跡したい場合は agent が Issue / PR コメントに残した内容や `gh pr list` で取得する。

## CLI サブコマンドへの適用範囲

- `philharmonic run`: 構造化ログ (本仕様の対象)
- `philharmonic projects list`, `philharmonic clean`: 「コマンドの最終結果」のみを stdout / stderr に
  出す設計のため、本仕様の対象外 (Logger 経由にすると table / パイプ処理と競合する)
- `src/cli.ts` の未捕捉例外ハンドラは Logger 経由で `error` を吐く

## エラーハンドリング

- destination への write が失敗した場合、Node.js のデフォルト挙動に委ねる (例外を握りつぶさない)
- JSON line のシリアライズに失敗した場合 (循環参照等) は `JSON.stringify` の例外がそのまま伝播する。
  本ロガーは内部で再 throw しない。呼び出し側は循環参照を含む値を fields に渡さない責任を負う

## テスト容易性

- `destination` に `Writable` ストリームを inject することで、書き出し内容を完全 capture 可能
- `clock` injection で `ts` を固定できる
- `level` を `debug` にすればフィルタを無効化できる

詳細な検証は `tests/logger/logger.test.ts` を参照。

## Out of scope

- 環境変数 (`PHILHARMONIC_LOG_LEVEL` 等) によるレベル上書き
- log redaction / PII マスキング (token は環境変数のみで構造化ログには載らない設計)
- ログのファイル永続化 / rotation (現行の `.philharmonic/runs/<run-id>/` で個別タスクのログは残るため不要)
- 並列実行時の出力直列化
- pretty printer / 色付け (JSON line を直接読まない場合は `jq` / `bunyan` で整形する想定)
