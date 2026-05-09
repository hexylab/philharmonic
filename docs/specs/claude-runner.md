# Claude Code Headless Runner

## 概要

Claude Code CLI を **headless mode** (`claude -p ... --output-format stream-json --verbose`) で subprocess として起動し、指定された prompt と workspace path で 1 回実行して結果を構造化された `RunResult` として返すモジュール。GitHub Projects 連携・PR 作成・Status 更新などのオーケストレーション責務は持たず、純粋に「Claude Code を 1 回叩いて結果を構造化する」ことに専念する。

## 関連 Issue

- #6 — Claude Code headless runner の最小実装を作る
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)
- 上位フロー: [orchestration-mvp.md](./orchestration-mvp.md) の「6. Runner Execution」「Failure / Timeout / Retry」「Run Log」

## 用語と登場アクター

| 用語             | 意味                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| **Runner**       | 本仕様で定義する Node.js モジュール (`src/runner/`)。subprocess の起動と結果収集を司る |
| **Claude Code**  | Anthropic 公式 CLI。本 Runner はこれを `claude -p ...` で 1 回起動するだけ             |
| **Workspace**    | Claude Code の作業対象ディレクトリ。subprocess の `cwd` として渡す                     |
| **Stream Event** | `--output-format stream-json` で 1 行 1 JSON object として出力される event             |
| **Result Event** | Stream Event のうち `type === "result"` のもの。実行サマリ (cost / usage 等) を含む    |

## 要件

Issue #6 の Acceptance Criteria を満たすために、以下を実現する。

- `runClaude(options): Promise<RunResult>` という stateless な API を提供する
- `prompt` と `workspacePath` を受け取り、Claude Code を subprocess として起動する
- stream-json (NDJSON) を行ごとに parse し、最終 `result` event から以下を抽出する:
  - `subtype` / `is_error` / `result` (最終応答テキスト) / `session_id`
  - `total_cost_usd` / `usage.input_tokens` / `usage.output_tokens`
  - `duration_ms` / `duration_api_ms` / `num_turns` / `stop_reason`
- `logDir` が指定された場合、`stream.jsonl` (stdout 全行) と `stderr.log` (stderr 全文) を追記書き込みする
- `timeoutMs` 経過時に subprocess を SIGTERM、`killGracePeriodMs` 後にまだ生きていれば SIGKILL で終了させる
- `RunResult.status` は `'success' / 'failed' / 'timeout'` の 3 値で返す
- `claude` コマンドが見つからない (ENOENT) 場合は `ClaudeNotInstalledError` を throw する
- GitHub token (`GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` / `OCTOKIT_*`) を Runner プロセスの環境変数から削除する
- `permissionMode` は `'auto'` (既定) または `'bypass'` の 2 値をサポートし、ADR-0001 の mapping に従って CLI 引数を切り替える

## 責務分割 (orchestration-mvp.md との整合)

orchestration-mvp.md は `metadata.json` / `stream.jsonl` / `summary.md` の 3 ファイルを `<run-id>/` 配下に永続化することを要求するが、Runner はそのうち以下の **2 ファイルのみ** を書く。

| ファイル        | 書き手       | 内容                                                            |
| --------------- | ------------ | --------------------------------------------------------------- |
| `stream.jsonl`  | Runner       | Claude Code の stdout を 1 行ずつ追記                           |
| `stderr.log`    | Runner       | Claude Code の stderr を全文追記                                |
| `metadata.json` | Orchestrator | run-id / issue 番号 / PR 番号 / branch 等 Runner が知らない情報 |
| `summary.md`    | Orchestrator | `RunResult.finalText` を Markdown に整形                        |

これにより Runner は orchestrator の存在を知らずに使え、テストも runner 単体で完結する。

## 非機能要件

- **性能**: subprocess 実起動のオーバーヘッドのみ。Runner 自身の CPU/IO は無視できる程度
- **可用性**: 単一プロセス・1 ターン実行のみ。並列実行・自動再開は対象外
- **セキュリティ**:
  - `spawn` は shell を経由せず、引数を配列で渡す
  - GitHub token は `buildRunnerEnv` で `process.env` から削除した上で subprocess に渡す
  - `permissionMode: 'bypass'` 指定時のみ `--dangerously-skip-permissions` を渡す。本フラグは worktree 外 (ホスト全体) にも副作用が及び得るため、git worktree + 非特権ユーザによる隔離を前提とする
  - 警告ログは Runner 自身ではなく **呼び出し側 (orchestrator)** が出す (Runner は stateless にし、副作用ロギングを持たない)
  - `sessionId` を受け取った場合は UUID 形式 validation を行う (Claude Code CLI が要求)
- **アクセシビリティ**: 該当しない (内部モジュール)

## データモデル

### `RunClaudeOptions`

| キー                | 型                   | 必須 | 説明                                                                                                                       |
| ------------------- | -------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `prompt`            | `string`             | yes  | Claude Code に渡す prompt 文字列。空文字は許容しない                                                                       |
| `workspacePath`     | `string`             | yes  | subprocess の `cwd` として渡す絶対パス                                                                                     |
| `permissionMode`    | `'auto' \| 'bypass'` | no   | 既定 `'auto'`。`auto` は `--permission-mode acceptEdits`、`bypass` は `--dangerously-skip-permissions` にマップ (ADR-0001) |
| `sessionId`         | `string`             | no   | UUID 形式。指定時は `--session-id <UUID>` を渡す                                                                           |
| `timeoutMs`         | `number`             | no   | 既定 `30 * 60 * 1000` (30 分)                                                                                              |
| `killGracePeriodMs` | `number`             | no   | SIGTERM → SIGKILL 待機。既定 `5000` (5 秒)                                                                                 |
| `logDir`            | `string`             | no   | 指定時 `<logDir>/stream.jsonl` `<logDir>/stderr.log` を追記する                                                            |
| `env`               | `NodeJS.ProcessEnv`  | no   | 既定: `process.env` から GitHub token 系を除外したもの                                                                     |
| `spawn`             | `SpawnFn`            | no   | テスト用 DI。既定は `node:child_process.spawn` のラッパー                                                                  |
| `command`           | `string`             | no   | 既定 `'claude'`。テスト用に上書き可                                                                                        |

### `RunResult`

| キー                  | 型                                                      | 説明                                                         |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| `status`              | `'success' \| 'failed' \| 'timeout'`                    | 終了区分                                                     |
| `exitCode`            | `number \| null`                                        | subprocess の exit code                                      |
| `signal`              | `NodeJS.Signals \| null`                                | subprocess を kill した signal (`SIGTERM` / `SIGKILL` 等)    |
| `durationMs`          | `number`                                                | Runner 計測の所要時間 (spawn〜close)                         |
| `durationApiMs`       | `number \| null`                                        | result event の `duration_api_ms`                            |
| `numTurns`            | `number \| null`                                        | result event の `num_turns`                                  |
| `sessionId`           | `string \| null`                                        | result event の `session_id` (なければ system event のもの)  |
| `resultSubtype`       | `string \| null`                                        | result event の `subtype` (`success` / `error_max_turns` 等) |
| `stopReason`          | `string \| null`                                        | result event の `stop_reason` (`end_turn` / `max_turns` 等)  |
| `isError`             | `boolean`                                               | result event の `is_error` (event 不在時は `false`)          |
| `finalText`           | `string \| null`                                        | result event の `result` フィールド (最終応答テキスト)       |
| `totalCostUsd`        | `number \| null`                                        | result event の `total_cost_usd`                             |
| `usage`               | `{ inputTokens: number; outputTokens: number } \| null` | result event の `usage`                                      |
| `rawStderrTail`       | `string`                                                | stderr の末尾最大 8KB (logDir 指定なし時のメモリ圧対策)      |
| `resultEventReceived` | `boolean`                                               | result event が 1 度でも来たか                               |
| `logPaths`            | `{ stream: string; stderr: string } \| null`            | logDir 指定時の書き出し先絶対パス                            |

`stop_reason` は assistant message と result event の両方に出現するが、本 Runner は **result event 由来のもの** を採用する (実機検証で result event に含まれることを確認済み)。

`events: StreamEvent[]` 全体は **保持しない**。長 run で MB 級になるため、永続化先 `stream.jsonl` を読めば再現できる。

### `StreamEvent`

```ts
type StreamEvent =
  | { type: 'system'; subtype?: string; sessionId?: string; raw: unknown }
  | { type: 'assistant'; raw: unknown }
  | { type: 'user'; raw: unknown }
  | {
      type: 'result';
      subtype?: string;
      isError?: boolean;
      sessionId?: string;
      stopReason?: string;
      totalCostUsd?: number;
      durationMs?: number;
      durationApiMs?: number;
      numTurns?: number;
      finalText?: string;
      usage?: { inputTokens: number; outputTokens: number };
      raw: unknown;
    }
  | { type: 'unknown'; raw: unknown }
  | { type: 'parse_error'; line: string; reason: string };
```

snake_case → camelCase の変換は parser 内で行う。

## API / インターフェース

```ts
export function runClaude(options: RunClaudeOptions): Promise<RunResult>;

export class StreamEventParser {
  push(chunk: string): StreamEvent[];
  flush(): StreamEvent[];
}

export function buildRunnerEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export class ClaudeNotInstalledError extends Error {}
export class ClaudeRunnerSpawnError extends Error {}
export class InvalidSessionIdError extends Error {}
```

## CLI 引数規約

`claude -p` は `permissionMode` に応じて以下の 2 系統で引数を組み立てる。

`auto` (既定):

```
claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits [--session-id <UUID>]
```

`bypass`:

```
claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions [--session-id <UUID>]
```

- `--output-format stream-json` は **`--verbose` とセットで指定する必要がある** (Claude Code 2.1.x で確認: `--output-format=stream-json requires --verbose`)
- `--cwd` フラグは Claude Code CLI に **存在しない**。workspace path は subprocess の `cwd` オプションで渡す (ADR-0001 / orchestration-mvp.md も同方針に揃えて記述済み)
- `bypass` 指定時は `--permission-mode` フラグを **付けない**。両者を同時指定すると CLI 側で挙動が曖昧になるため
- `--dangerously-skip-permissions` は `bypass` モード以外では **絶対に渡さない**

## ライフサイクル

1. **入力検証**: `prompt` が空でないこと、`workspacePath` が絶対パスであること、`sessionId` が UUID 形式であることを確認
2. **環境変数構築**: `env` 未指定時は `buildRunnerEnv()` を呼んで GitHub token を除いた env を生成
3. **logDir 準備**: 指定時は `mkdir -p` し、stream.jsonl / stderr.log の書き込みストリームを開く
4. **spawn**: `claude -p ...` を起動。`error` event で `code === 'ENOENT'` を catch して `ClaudeNotInstalledError` に変換
5. **stream 取り込み**: stdout を `StreamEventParser.push()` に流し、最終 `result` event を保持。stderr は ring-buffer (8KB) + logDir に書き込み
6. **timeout**: `setTimeout(timeoutMs)` 発火で `child.kill('SIGTERM')`、`status='timeout'` フラグ。`killGracePeriodMs` 後 `SIGKILL`
7. **close 待機**: `child.on('close')` を待ってから RunResult を組み立て
8. **後処理**: タイマー clear、ログストリーム close

## エラーハンドリング

| エラー / 状態                   | 発生条件                                      | 扱い方針                                                                   |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `ClaudeNotInstalledError`       | spawn の `error` event で `code === 'ENOENT'` | reject。呼び出し側で「`claude` をインストールしてください」を表示する想定  |
| `ClaudeRunnerSpawnError`        | spawn の `error` event で ENOENT 以外         | reject。`cause` に元エラーを保持                                           |
| `InvalidSessionIdError`         | `sessionId` が UUID 形式でない                | spawn 前に同期 reject                                                      |
| `status: 'failed'` (異常終了)   | exit code != 0 かつ timeout でない            | resolve。`exitCode` と `rawStderrTail` を返す                              |
| `status: 'failed'` (event なし) | result event が来ずに exit 0                  | resolve。`resultEventReceived: false`、その他 result 由来フィールドは null |
| `status: 'timeout'`             | `timeoutMs` 超過                              | resolve。SIGTERM → 必要なら SIGKILL                                        |
| `parse_error` event             | NDJSON の 1 行が JSON として parse 不能       | parser 内 warning。処理は続行 (1 行が壊れても全体を止めない)               |
| logDir 書き込み失敗             | ファイル系エラー                              | reject (Runner の責務外で復旧不能なため)                                   |

## 外部依存

- **Claude Code CLI**: 2.x 系で動作確認 (2.1.133 で fixture 生成済み)。バージョン制約は MVP では未指定
- **Node.js 標準**: `node:child_process` (`spawn`)、`node:fs/promises`、`node:path`、`node:events`、`node:stream`
- 外部ネットワーク I/O は Claude Code 自身が行う。Runner からは行わない

## オープンクエスチョン

- result event 未到着時 (anthropics/claude-code#1920) の retry ポリシー — MVP では retry しない (orchestrator 判断)
- `--add-dir` / `--allowedTools` / `--mcp-config` 等の追加オプションのサポート時期 — 後続 Issue
- `bypass` 利用時の追加ガード (`PHILHARMONIC_BYPASS=1` などの環境フラグ二重確認) を入れるか — MVP では config + 警告ログで十分とし、必要であれば後続 Issue で検討

## MVP でやらないこと

- 自動 retry / resume
- `metadata.json` / `summary.md` の永続化 (orchestrator 責務)
- `events: StreamEvent[]` 全体のメモリ保持 (永続化先で再現可)
- `--add-dir` / `--mcp-config` / `--allowedTools` などの追加フラグ
- 並列実行・プロセス間 lock
