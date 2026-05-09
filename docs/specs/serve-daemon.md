# Serve Daemon — `philharmonic serve`

## 概要

Project board を一定間隔でポーリングし、候補があれば `philharmonic run` 相当の 1 ターン
orchestration を 1 件処理する常駐デーモンを `philharmonic serve` として提供する。
Symphony の "daemon workflow" 性に追いつくための最小実装で、並列実行・自動 retry・
recovery は本仕様の範囲外 (別 Issue)。

## 関連 Issue

- #21 — philharmonic serve で常駐ポーリングデーモンを実装する
- 関連 spec: [orchestration-mvp.md](./orchestration-mvp.md), [config-schema.md](./config-schema.md), [observability.md](./observability.md)

## 用語

| 用語              | 意味                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| **poll tick**     | 1 回のポーリング周期。tick ごとに `runOnce` を 1 度呼ぶ                      |
| **in-flight run** | `runOnce` 実行中の状態。Claude Code subprocess が走っている可能性あり        |
| **shutdown**      | SIGTERM / SIGINT を受けて in-flight run の完了を待ってから exit する状態遷移 |

## 要件

- `philharmonic serve` サブコマンドを追加し、`philharmonic --help` / `philharmonic serve --help` から見える
- `--config <path>` フラグで設定ファイルパスを上書きできる (`philharmonic run` と同等)
- ポーリング間隔は config の `polling.interval_ms` で制御する。未指定時のデフォルトは 30000ms (30s)
- `runOnce` は既存実装をそのまま再利用し、daemon 側では loop 制御と signal handling のみを追加する
- 1 tick の流れ:
  1. `poll tick` ログを 1 行出す
  2. `runOnce` を await し、結果に応じて `dispatch success` / `dispatch failed` / `no candidate` を log
  3. `runOnce` が throw した場合は `dispatch error` (warn) を出して次 tick に進む
  4. signal が aborted なら break、そうでなければ `polling.interval_ms` だけ sleep (abortable)
- 起動直後は **即時 1 回 poll** する (sleep 後の 1st poll ではない)。立ち上げ時の停止状態を即時解消するため
- 終了経路 (signal / 例外) を問わず必ず `serve stopped` ログを 1 行出す
- 終了 exit code は **0** (graceful shutdown は正常終了)。Bootstrap 段階で config / token に失敗した場合のみ exit 1

## SIGTERM / SIGINT で graceful shutdown

- CLI レイヤで `process.on('SIGTERM', ...)` / `process.on('SIGINT', ...)` を listen する
- 受信時に `AbortController.abort()` を呼ぶ。loop はこの signal を見て次 tick に進まないように break する
- in-flight run は subprocess 強制終了せず、最後まで完走させる (途中強制終了は本仕様の範囲外)
- 二重シグナル受信 (shutdown 中にもう 1 回 SIGTERM) は warn ログ 1 行を出して以降は no-op
- loop 終了後、登録した signal listener は確実に外す (`process.removeListener`)

## 非機能要件

- **性能**: 単一プロセスで 1 tick = 1 run。tick あたりの GraphQL/REST 呼び出し数は `philharmonic run` と同等
- **可用性**: 単発失敗は次 tick まで待つ (回復は次 tick の自然 retry に委ねる)。連続失敗カウンタや
  exponential backoff は本仕様外 (別 Issue)
- **セキュリティ**: GitHub PAT は CLI レイヤのみが保持。Runner subprocess へは `runOnce` 経由で
  `buildRunnerEnv` が token を除去した env を渡す (既存挙動を流用)
- **アクセシビリティ**: 該当しない (非対話 / CLI のみ)

## データモデル

### Config (`philharmonic.yaml`)

```yaml
polling:
  interval_ms: 30000 # default 30s
```

| キー                  | 型               | 必須 | デフォルト | 説明                                |
| --------------------- | ---------------- | ---- | ---------- | ----------------------------------- |
| `polling.interval_ms` | `integer (>= 1)` | no   | `30000`    | 1 tick 終了後の sleep 時間 (ミリ秒) |

`polling` キー自体を省略しても、空オブジェクト `polling: {}` で書いても、内側 default が補完される。
未知キーは zod の `.strict()` で拒否される。

### structured log

| level | msg                                               | fields                                          | 説明                                   |
| ----- | ------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| info  | `serve started`                                   | `interval_ms`                                   | loop 開始時 1 回                       |
| info  | `poll tick`                                       | `interval_ms`                                   | tick ごと                              |
| info  | `no candidate`                                    | (`runOnce` 内ですでに出している)                | runOnce が `no_candidate` を返したとき |
| info  | `dispatch success`                                | `run_id`, `issue_number`, `pr_number`, `branch` | runOnce が `success` を返したとき      |
| warn  | `dispatch failed`                                 | `run_id`, `issue_number`, `reason`              | runOnce が `failed` を返したとき       |
| warn  | `dispatch error`                                  | `error`                                         | runOnce が throw したとき              |
| info  | `shutdown signal`                                 | `signal` (`SIGTERM` / `SIGINT`)                 | 1 回目のシグナル受信                   |
| warn  | `shutdown signal ignored (already shutting down)` | `signal`                                        | 2 回目以降のシグナル受信               |
| info  | `serve stopped`                                   | -                                               | loop 終了経路を問わず必ず 1 行         |

## API / インターフェース

### CLI

```
$ philharmonic serve [-c <path>]
```

- `-c, --config <path>`: 設定ファイルパス (default: cwd の `philharmonic.yaml`)

### `serveLoop` (`src/orchestrator/serve.ts`)

```ts
type ServeLoopRunOnce = () => Promise<RunOnceResult>;
type ServeLoopSleep = (ms: number, signal: AbortSignal) => Promise<void>;

type ServeLoopDeps = {
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
  runOnce: ServeLoopRunOnce;
  sleep?: ServeLoopSleep; // default: abortableSleep
};

function serveLoop(deps: ServeLoopDeps): Promise<void>;
function abortableSleep(ms: number, signal: AbortSignal): Promise<void>;
```

- `runOnce` は CLI レイヤで wrap 済み (`runOnceFromOrchestrator(...)` を bind したもの)
- `signal` は CLI レイヤの `AbortController.signal`
- 例外は `serveLoop` 内で握って `dispatch error` を log してから次 tick に進む
- 終了経路を問わず `serve stopped` を `finally` で出す

### CLI レイヤ (`src/cli/serve.ts`)

```ts
function createServeCommand(deps?: ServeCommandDeps): Command;
```

主な責務:

1. config / token を解決し、`runOnce` の依存 (GitHub client / projects client / workspace manager) を構築
2. `AbortController` を作って SIGTERM / SIGINT listener を登録
3. `serveLoop` を呼び、終了後に listener を確実に外す

依存は `ServeCommandDeps` で注入可能 (テスト用)。signal listener も `createSignalSubscription`
で差し替え可能にしてある。

## エラーハンドリング

| エラー                               | 発生条件                                 | 扱い方針                                                                                        |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN` 未設定                | 起動時の token 解決                      | stderr に出して exit 1 (loop に入らない)                                                        |
| `ConfigFileNotFoundError` 等         | config 読み込み                          | stderr に出して exit 1                                                                          |
| `BootstrapError` (status 遷移失敗等) | `runOnce` が throw                       | `dispatch error` (warn) を log して次 tick に進む。daemon は落とさない                          |
| 想定外の `runOnce` 例外              | `runOnce` が throw                       | 同上                                                                                            |
| `runOnce` が `failed` を返す         | runner 失敗 / push 失敗 / pr_create 失敗 | `dispatch failed` (warn) を log して次 tick に進む。Issue 失敗コメントは `runOnce` 側で投稿済み |
| 二重シグナル受信                     | shutdown 中にもう 1 回 SIGTERM 等        | `shutdown signal ignored` (warn) を log のみで no-op                                            |

`philharmonic run` では Bootstrap 失敗が exit 1 になっていたが、`serve` では「ネットワークの一過性失敗で
daemon が落ちると運用負担が大きい」ため log のみで継続させる方針を採る。連続失敗の上限制御や exponential
backoff は別 Issue で扱う。

## 外部依存

- 既存 `runOnce` (`src/orchestrator/run.ts`)
- 既存 `createLogger` (`src/logger/`)
- Node.js `AbortController` / `AbortSignal` (Node 22 LTS で標準)
- Node.js `process.on('SIG*', ...)` (CLI レイヤのみ)

## オープンクエスチョン

- 連続失敗カウンタ / exponential backoff の導入時期と仕様
- in-flight run を SIGTERM で強制中断するモード (`--force-shutdown` 等) の導入可否
- jitter による thundering herd 回避の必要性 (単一プロセスでは不要だが multi-process 化で必要になる)
- Linux 以外 (Windows) での SIGTERM/SIGINT 挙動差 (本 MVP では Linux/macOS 前提)

## MVP でやらないこと

- 並列実行 (1 tick = 1 run)
- 自動 retry / 自動 recovery / 連続失敗の上限制御
- backoff / jitter
- in-flight run の強制中断
- HTTP ヘルスチェックエンドポイント
- systemd / launchd 用 unit ファイル同梱
