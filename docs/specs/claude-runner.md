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
- `maxTurns` (既定 `1`) を超えない範囲で、1 ターン目が `error_max_turns` で打ち切られたときに `--resume <session-id>` で次ターンを継続する。1 ターンで完結する場合は loop に入らず従来動作と一致する。詳細は「Multi-turn ループ (#25)」節
- `stallTimeoutMs` 経過 (= 最後の stdout イベントから無音が続いた時間) で stall と判定し、`'stalled'` ステータスで強制終了する。詳細は「Stall detection (#25)」節
- `RunResult.status` は `'success' / 'failed' / 'timeout' / 'stalled'` の 4 値で返す
- `claude` コマンドが見つからない (ENOENT) 場合は `ClaudeNotInstalledError` を throw する
- Runner subprocess に渡す環境変数は **allowlist 方式** で絞る (#49)。許可した key 以外は通さない。詳細は「Runner subprocess の環境変数 (allowlist)」節
- subprocess は `detached: true` で起動して **process group leader** にし、timeout / stall 発火時の SIGTERM / SIGKILL は process group 全体に送って **孫プロセスまで停止** させる (#49)。詳細は「Process tree kill」節
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
  - Runner に渡す環境変数は **allowlist 方式** (`buildRunnerEnv`) で絞る。許可されたキー / プレフィックス以外は parent process の `process.env` から落とす (#49)。これにより `AWS_*` / `NPM_TOKEN` / `SSH_AUTH_SOCK` / `OPENAI_API_KEY` / `KUBECONFIG` 等の主要 secret や任意の `<custom>_TOKEN` 系が runner に到達しない
  - `permissionMode: 'bypass'` 指定時のみ `--dangerously-skip-permissions` を渡す。本フラグは worktree 外 (ホスト全体) にも副作用が及び得るため、git worktree + 非特権ユーザによる隔離を前提とする
  - `serve` で `bypass` を使う場合は env `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` を必須にする bootstrap guard を CLI レイヤに置く (詳細: [serve-daemon.md](./serve-daemon.md))
  - `bypass` の利用警告 (orchestration レベルの注意喚起) は **呼び出し側 (orchestrator)** が出す。Runner はライフサイクルイベント (spawn / timeout / close) のみを `logger` 経由で出し、orchestration セマンティクスのログは持たない (詳細は「ライフサイクル」節および [observability.md](./observability.md))
  - `logger` 未指定時は副作用ロギングを持たず stateless
  - `sessionId` を受け取った場合は UUID 形式 validation を行う (Claude Code CLI が要求)
- **アクセシビリティ**: 該当しない (内部モジュール)

## データモデル

### `RunClaudeOptions`

| キー                 | 型                   | 必須 | 説明                                                                                                                                                                               |
| -------------------- | -------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`             | `string`             | yes  | Claude Code に渡す prompt 文字列。空文字は許容しない                                                                                                                               |
| `workspacePath`      | `string`             | yes  | subprocess の `cwd` として渡す絶対パス                                                                                                                                             |
| `permissionMode`     | `'auto' \| 'bypass'` | no   | 既定 `'auto'`。`auto` は `--permission-mode acceptEdits`、`bypass` は `--dangerously-skip-permissions` にマップ (ADR-0001)                                                         |
| `sessionId`          | `string`             | no   | UUID 形式。指定時は 1 ターン目に `--session-id <UUID>` を渡し、2 ターン目以降は同 UUID を `--resume <UUID>` で再開する (#25)                                                       |
| `timeoutMs`          | `number`             | no   | 既定 `30 * 60 * 1000` (30 分)。**1 ターンあたり**の絶対上限。multi-turn loop では各ターン個別に適用される                                                                          |
| `killGracePeriodMs`  | `number`             | no   | SIGTERM → SIGKILL 待機。既定 `5000` (5 秒)                                                                                                                                         |
| `maxTurns`           | `number`             | no   | 既定 `1`。multi-turn loop の上限ターン数。`1` で従来動作 (1 セッションで完結)。Runner は `error_max_turns` で打ち切られた場合のみ次ターンへ進む (#25)                              |
| `continuationPrompt` | `string`             | no   | 既定 `'Please continue working on the task.'`。2 ターン目以降の `-p` に渡す継続用 prompt。`maxTurns === 1` のときは未使用                                                          |
| `stallTimeoutMs`     | `number`             | no   | 既定 `5 * 60 * 1000` (5 分)。stdout から最後にイベントを受け取ってから経過時間がこの値を超えると stall と判定し SIGTERM を送る。`0` で stall detection を無効化する (#25)          |
| `logDir`             | `string`             | no   | 指定時 `<logDir>/stream.jsonl` `<logDir>/stderr.log` を追記する。multi-turn 実行時は同じファイルにターン跨ぎで追記される                                                           |
| `env`                | `NodeJS.ProcessEnv`  | no   | 既定: `buildRunnerEnv()` の allowlist で絞ったもの (詳細: 「Runner subprocess の環境変数 (allowlist)」)                                                                            |
| `spawn`              | `SpawnFn`            | no   | テスト用 DI。既定は `node:child_process.spawn` のラッパー                                                                                                                          |
| `command`            | `string`             | no   | 既定 `'claude'`。テスト用に上書き可                                                                                                                                                |
| `logger`             | `Logger`             | no   | 構造化ログ用の Logger。subprocess の `system` イベントから `session_id` 取得時に `child({ sessionId })` で以降のログに付与する (ADR-0002 / [observability.md](./observability.md)) |
| `killProcessGroup`   | `KillProcessGroupFn` | no   | テスト用 DI。既定は `process.kill(-pid, signal)`。timeout / stall 時の SIGTERM / SIGKILL を process group 全体に送るのに使う (#49)                                                 |

### `RunResult`

| キー                  | 型                                                      | 説明                                                                                   |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `status`              | `'success' \| 'failed' \| 'timeout' \| 'stalled'`       | 終了区分。`stalled` は stream イベントの無音が `stallTimeoutMs` を超えた場合 (#25)     |
| `exitCode`            | `number \| null`                                        | subprocess の exit code                                                                |
| `signal`              | `NodeJS.Signals \| null`                                | subprocess を kill した signal (`SIGTERM` / `SIGKILL` 等)                              |
| `durationMs`          | `number`                                                | Runner 計測の所要時間 (multi-turn の場合は全ターンの spawn〜close を通算)              |
| `durationApiMs`       | `number \| null`                                        | result event の `duration_api_ms` (multi-turn では各ターンの加算)                      |
| `numTurns`            | `number \| null`                                        | result event の `num_turns` (multi-turn では各ターンの加算)                            |
| `turns`               | `number`                                                | Runner が起動した外側ターン数 (`maxTurns` 上限内)。1 ターンで完結なら `1`              |
| `sessionId`           | `string \| null`                                        | session_id。multi-turn でも同一値が保持される (Acceptance Criteria: #25)               |
| `resultSubtype`       | `string \| null`                                        | 最終ターンの result event の `subtype` (`success` / `error_max_turns` 等)              |
| `stopReason`          | `string \| null`                                        | 最終ターンの result event の `stop_reason` (`end_turn` / `max_turns` 等)               |
| `isError`             | `boolean`                                               | 最終ターンの result event の `is_error` (event 不在時は `false`)                       |
| `finalText`           | `string \| null`                                        | 最終ターンの result event の `result` フィールド                                       |
| `totalCostUsd`        | `number \| null`                                        | result event の `total_cost_usd` (multi-turn では各ターンの加算)                       |
| `usage`               | `{ inputTokens: number; outputTokens: number } \| null` | result event の `usage` (multi-turn では各ターンの加算)                                |
| `rawStderrTail`       | `string`                                                | stderr の末尾最大 8KB (logDir 指定なし時のメモリ圧対策)。multi-turn では最終ターンのみ |
| `resultEventReceived` | `boolean`                                               | 最終ターンで result event が 1 度でも来たか                                            |
| `logPaths`            | `{ stream: string; stderr: string } \| null`            | logDir 指定時の書き出し先絶対パス                                                      |

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

`claude -p` は `permissionMode` と「multi-turn の何ターン目か」に応じて引数を組み立てる。

1 ターン目 (`auto` 既定):

```
claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits [--session-id <UUID>]
```

1 ターン目 (`bypass`):

```
claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions [--session-id <UUID>]
```

2 ターン目以降 (`auto`):

```
claude -p <continuationPrompt> --output-format stream-json --verbose --permission-mode acceptEdits --resume <UUID>
```

- `--output-format stream-json` は **`--verbose` とセットで指定する必要がある** (Claude Code 2.1.x で確認: `--output-format=stream-json requires --verbose`)
- `--cwd` フラグは Claude Code CLI に **存在しない**。workspace path は subprocess の `cwd` オプションで渡す (ADR-0001 / orchestration-mvp.md も同方針に揃えて記述済み)
- `bypass` 指定時は `--permission-mode` フラグを **付けない**。両者を同時指定すると CLI 側で挙動が曖昧になるため
- `--dangerously-skip-permissions` は `bypass` モード以外では **絶対に渡さない**
- 2 ターン目以降は `--session-id` の代わりに `--resume <UUID>` を渡す。Claude Code は両者の同時指定を許容するが、`--resume` だけで十分かつ意図が明確なため `--session-id` は付けない

## ライフサイクル

1. **入力検証**: `prompt` が空でないこと、`workspacePath` が絶対パスであること、`sessionId` が UUID 形式であることを確認
2. **環境変数構築**: `env` 未指定時は `buildRunnerEnv()` を呼んで allowlist で絞った env を生成 (詳細: 「Runner subprocess の環境変数 (allowlist)」)
3. **logDir 準備**: 指定時は `mkdir -p` し、stream.jsonl / stderr.log の書き込みストリームを開く (multi-turn でも同一ストリームに追記する)
4. **Multi-turn loop** (詳細: 「Multi-turn ループ (#25)」):
   - turn = 1 から `maxTurns` まで以下を繰り返す
   - **spawn**: `claude -p ...` を `detached: true` 付きで起動 (process group leader 化)。`error` event で `code === 'ENOENT'` を catch して `ClaudeNotInstalledError` に変換
   - **stream 取り込み**: stdout を `StreamEventParser.push()` に流し、`result` event を保持。stderr は ring-buffer (8KB) + logDir に書き込み
   - **timeout**: `setTimeout(timeoutMs)` 発火で SIGTERM を process group に送り、`status='timeout'` フラグ。`killGracePeriodMs` 後 `SIGKILL`
   - **stall detection**: stdout に data が来るたびに stall timer を `stallTimeoutMs` で reschedule。発火で SIGTERM、`status='stalled'` フラグ
   - **close 待機**: `child.on('close')` を待ってから当該ターンを集約
   - **継続判定**: 当該ターンが `success` 以外で **かつ** `result event の subtype === 'error_max_turns'` の場合のみ次ターンへ進む。それ以外は loop break
5. **集約**: 各ターンの `durationApiMs` / `numTurns` / `totalCostUsd` / `usage` を加算、`finalText` / `resultSubtype` / `stopReason` / `isError` / `status` / `exitCode` / `signal` は最終ターンを採用
6. **後処理**: タイマー clear、ログストリーム close

なお `logger` を渡されている場合、Runner は以下の構造化ログを出す (詳細: [observability.md](./observability.md))。

| タイミング               | level   | msg                                                                               |
| ------------------------ | ------- | --------------------------------------------------------------------------------- |
| spawn 直後               | `info`  | `runner started` (`turn` フィールドにターン番号を含む)                            |
| `system` event 受信時    | (なし)  | 内部で `logger.child({ sessionId })` に切り替え (`session_id` を以降のログに付与) |
| timeout 発火 (SIGTERM)   | `warn`  | `runner timeout reached, sending SIGTERM to process group`                        |
| stall 発火 (SIGTERM)     | `warn`  | `runner stall detected, sending SIGTERM to process group` (`stallTimeoutMs` 含む) |
| SIGKILL fallback         | `warn`  | `runner did not exit after SIGTERM, sending SIGKILL to process group`             |
| process group kill 失敗  | `warn`  | `process group kill failed, falling back to direct kill`                          |
| spawn 失敗 / error event | `error` | `runner spawn failed` / `runner error event`                                      |
| ターン継続判定           | `info`  | `runner continuing to next turn` (`turn` / `nextTurn` フィールド)                 |
| close 後 (ターン)        | `info`  | `runner turn finished` (1 ターン分の status / exitCode 等)                        |
| 全ターン完了後           | `info`  | `runner finished` (`turns` 累計 / 集約された status)                              |

## Multi-turn ループ (#25)

Claude Code の 1 セッション (`claude -p ...` 1 回起動) は内部的に複数の turn を回すが、`result.subtype === 'error_max_turns'` で打ち切られたまま完了することがある。Symphony の `agent.max_turns` に相当する外側のターン上限を Runner で持たせ、上限内でセッションを継続できるようにする。

### 継続条件 (再起動 trigger)

各ターン終了後、以下を **すべて** 満たす場合に限り次ターン (= 新しい subprocess) を spawn する:

1. `currentTurn < maxTurns`
2. result event を 1 つでも受け取った (`resultEventReceived === true`)
3. `resultSubtype === 'error_max_turns'`

それ以外 (`success` / `timeout` / `stalled` / spawn error / parse 失敗 / その他 result event 不在) は loop を打ち切り、その時点の `RunResult` を返す。

### 引数組み立て

- 1 ターン目: `--session-id <UUID>` (または `sessionId` が無ければ session_id 指定なし)
- 2 ターン目以降: 常に `--resume <UUID>` (1 ターン目の result event の `session_id` または引数で渡された `sessionId` を採用)
- 2 ターン目以降の `prompt` は `continuationPrompt` (既定 `'Please continue working on the task.'`)。1 ターン目の prompt は再送しない (`--resume` で context が復元される)
- `sessionId` が引数で渡されない場合でも、1 ターン目の `system` event から取得した session_id が利用可能な間は multi-turn を継続できる。session_id が確定しなかった場合は loop break (継続不可)

### 集約ルール

| キー                                                                                       | 集約方式                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `durationApiMs` / `numTurns` / `totalCostUsd` / `usage.inputTokens` / `usage.outputTokens` | 各ターンの値を加算 (どれかが null なら null として扱わずに skip) |
| `finalText` / `resultSubtype` / `stopReason` / `isError`                                   | 最終ターンの値を採用                                             |
| `status` / `exitCode` / `signal`                                                           | 最終ターンの値を採用                                             |
| `sessionId`                                                                                | 全ターンを通して同一値 (`Acceptance Criteria #25`)               |
| `turns`                                                                                    | 実際に Runner が起動したターン数                                 |

### MVP でやらないこと

- `--max-budget-usd` のような Claude Code 側 turn 上限の同期 (Claude Code に `--max-turns` フラグは存在しないため、Runner 側 loop でカバーする)
- 失敗した中間ターンに対する個別 retry (中間ターンが `runner_error` で落ちたら loop break で全体失敗)
- 中間ターンの `summary.md` 出力 (`writeSummary` は orchestrator 側で最終結果のみ書く)

## Process tree kill (#49)

Claude Code は内部で MCP server / git / shell コマンド等を子として spawn することがある。Runner が
timeout で `child.kill('SIGTERM')` を直接呼ぶと **直接の子プロセスにしか signal が届かず**、孫が
parent を失った状態で生き残る。`philharmonic serve` のような長時間稼働のシナリオでは、これらの
ゾンビが累積して FD / メモリを食い潰す。

そのため Runner は次の構造で **process group 単位** の kill を行う。

1. `defaultSpawn` で `detached: true` を渡す → 子プロセスは新しい process group の leader になる (Unix の `setsid` 相当)
2. `SpawnedProcess.pid` を保持する
3. timeout 時は `process.kill(-pid, 'SIGTERM')` で **process group 全体** に signal を送る (負の pid)
4. `killGracePeriodMs` 後にまだ生きていれば `process.kill(-pid, 'SIGKILL')` を同じく process group に送る
5. `process.kill` が ESRCH 等で失敗した場合は warn ログを出して `child.kill(signal)` (単体 kill) にフォールバック

`stdio` は `pipe` のままで、parent プロセスは引き続き subprocess の close を待つ
(`detached: true` 単体では子は parent から切り離されない。`unref()` を呼ばない限り close を待つ)。

`process.kill` 自体は DI 可能 (`RunClaudeOptions.killProcessGroup`)。テストでは fake function を渡して
process group kill が呼ばれることを検証する。

Windows では `detached: true` は新しい console window を作るだけで process group 概念がない。本仕様
では Unix を優先し、Windows は best-effort (ENOENT 等で fallback されて単体 kill になる)。

## Stall detection (#25)

Claude Code が API 応答 (rate limit / network / inference) で停止し、stream-json 上のイベントが長時間途絶することがある。`timeoutMs` (1 ターン上限) を待たずに早期検知して subprocess を停止できるよう、Runner は **stdout 無音タイマー** を別途管理する。

### 仕様

- 計測対象は **subprocess の stdout からの `'data'` イベント**。stderr は対象外 (debug 出力で無音中もチラ見えする可能性があるため)
- subprocess spawn 直後に `setTimeout(stallTimeoutMs)` をセット
- stdout に data が 1 byte でも来たら `clearTimeout` → 改めて `setTimeout(stallTimeoutMs)` を再 set (毎回 reschedule)
- 発火時は process group に SIGTERM を送り、`status='stalled'` フラグを立てる。`killGracePeriodMs` 後にまだ生きていれば SIGKILL
- `stallTimeoutMs <= 0` または `Number.POSITIVE_INFINITY` 相当値 (内部 sentinel) のときは stall detection 自体を無効化する
- 通常 timeout (`timeoutMs`) と stall timeout は **両方並行で動き、先に発火した方が `status` を決める**。両者の発火タイミングが極めて近いケースでは、最初に立てたフラグ (`timedOut` または `stalled`) を採用する

### multi-turn との関係

stall detection は **各ターン独立** に評価される。あるターンで stall して subprocess を kill した場合、`status='stalled'` が確定するため次ターンへ進まずに loop は break する (`error_max_turns` 以外なので継続条件を満たさない)。

## Runner subprocess の環境変数 (allowlist) (#49)

`buildRunnerEnv` は `process.env` を **allowlist 方式** で絞り、Runner subprocess に渡してよい
key だけを通す。deny list 方式 (`SENSITIVE_ENV_KEYS` で個別除外) では新しい secret 形式が登場するたびに
追記が必要で穴が空きやすいため、明示的に許可した key のみを通す。

### 許可リスト

**完全一致 key (`ALLOWED_ENV_KEYS`):**

- 基本: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`
- タイムゾーン / ロケール: `TZ`, `LANG`, `LANGUAGE`
- 端末: `TERM`, `COLUMNS`, `LINES`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `CI`
- 一時ディレクトリ: `TMPDIR`, `TMP`, `TEMP`

**プレフィックス一致 (`ALLOWED_ENV_PREFIXES`):**

- `LC_*`: ロケール詳細 (`LC_ALL` / `LC_CTYPE` ...)
- `XDG_*`: Linux user dirs (`XDG_CONFIG_HOME` 等で Claude Code の設定にも影響)
- `NODE_*`: Node.js 自身が見るオプション群 (`NODE_PATH` / `NODE_OPTIONS` 等)
- `ANTHROPIC_*` / `CLAUDE_*`: Claude Code が auth / 設定で参照する env (`ANTHROPIC_API_KEY` など)
- `PHILHARMONIC_*`: 自分自身の env (debug 用)

### 落とす対象 (テストで保証)

- GitHub: `GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` / `OCTOKIT_*`
- AWS: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_PROFILE`
- npm: `NPM_TOKEN` / `NPM_CONFIG_USERCONFIG`
- ssh: `SSH_AUTH_SOCK` / `SSH_AGENT_PID`
- 他 LLM: `OPENAI_API_KEY`
- クラウド: `GOOGLE_APPLICATION_CREDENTIALS` / `KUBECONFIG` / `DOCKER_AUTH_CONFIG`
- DB / 任意: `DATABASE_URL` / `MY_PROJECT_TOKEN` 等の未知の env はすべて落ちる

これは「allowlist で **明示的に許可した key 以外は通さない**」原則の自然な帰結であり、deny list の
個別 entry を維持する必要はない。

## エラーハンドリング

| エラー / 状態                   | 発生条件                                      | 扱い方針                                                                   |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `ClaudeNotInstalledError`       | spawn の `error` event で `code === 'ENOENT'` | reject。呼び出し側で「`claude` をインストールしてください」を表示する想定  |
| `ClaudeRunnerSpawnError`        | spawn の `error` event で ENOENT 以外         | reject。`cause` に元エラーを保持                                           |
| `InvalidSessionIdError`         | `sessionId` が UUID 形式でない                | spawn 前に同期 reject                                                      |
| `status: 'failed'` (異常終了)   | exit code != 0 かつ timeout / stall でない    | resolve。`exitCode` と `rawStderrTail` を返す                              |
| `status: 'failed'` (event なし) | result event が来ずに exit 0                  | resolve。`resultEventReceived: false`、その他 result 由来フィールドは null |
| `status: 'timeout'`             | `timeoutMs` 超過                              | resolve。SIGTERM → 必要なら SIGKILL                                        |
| `status: 'stalled'`             | `stallTimeoutMs` の間 stdout イベント無音     | resolve。SIGTERM → 必要なら SIGKILL (#25)                                  |
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

- 自動 retry (orchestrator 側 `philharmonic serve` の retry とは別軸。Runner 内では `error_max_turns` 以外の失敗を retry しない)
- `metadata.json` / `summary.md` の永続化 (orchestrator 責務)
- `events: StreamEvent[]` 全体のメモリ保持 (永続化先で再現可)
- `--add-dir` / `--mcp-config` / `--allowedTools` などの追加フラグ
- 並列実行・プロセス間 lock
