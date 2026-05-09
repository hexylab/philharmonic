# Serve Daemon — `philharmonic serve`

## 概要

Project board を一定間隔でポーリングし、候補があれば `philharmonic run` 相当の 1 ターン
orchestration を 1 件処理する常駐デーモンを `philharmonic serve` として提供する。
Symphony の "daemon workflow" 性に追いつくための最小実装で、並列実行・自動 retry・
recovery は本仕様の範囲外 (別 Issue)。

## 関連 Issue

- #21 — philharmonic serve で常駐ポーリングデーモンを実装する
- #49 — serve daemon の安全性 hardening を行う (lock file / bypass guard / polling 下限 / process tree kill)
- #23 — Tracker-driven recovery を実装する (起動時に `In Progress` の引き取り。詳細は [orchestration-mvp.md#tracker-driven-recovery-serve-起動時](./orchestration-mvp.md#tracker-driven-recovery-serve-起動時))
- 関連 spec: [orchestration-mvp.md](./orchestration-mvp.md), [config-schema.md](./config-schema.md), [claude-runner.md](./claude-runner.md), [observability.md](./observability.md)

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

## Hardening (#49)

`serve` を長時間・無人で回す前提の安全対策を bootstrap 段階に集約している。連続失敗 / retry /
recovery (#22 / #23 / #24) の前提となる「単発で事故を起こさない」ことを守る層。

### 二重起動防止 (local lock file)

- lock file: `<repoRoot>/.philharmonic/serve.lock` (相対固定)
- 内容: `{ pid: number, hostname: string, startedAt: ISO8601 string }` を JSON で保存
- 取得: `open(path, 'wx')` で **atomic** 作成 (既存ファイルがあると EEXIST)
- 既存 lock 検出時の判定階層 (上から順に評価):
  1. JSON parse 失敗 → 前回 crash の半端書きと見なし、stale 扱いで奪取
  2. `hostname` が現在ホストと異なる → `ServeLockHeldOnDifferentHostError` で exit 1
     (NFS / 共有 FS 越しの誤検出を避けるため自動奪取しない)
  3. 同 host + pid 生存 (`process.kill(pid, 0)`) → `ServeLockHeldError` で exit 1
  4. 同 host + pid 死亡 → stale 扱いで奪取
- 解放 (`release()`): lock の中身が**自分の pid と一致しているとき**だけ `unlink`
  - これで「他プロセスに既に奪取された後の自分の release」で他プロセスの lock を消さない (race 安全)
- bootstrap (token / config / bypass guard) を全て通った後に lock を取る。失敗時に lock を残さないため
- `serveLoop` の `finally` で必ず `release()` を呼ぶ。serveLoop が例外を投げた場合も lock は解放される

### `permission_mode: bypass` の opt-in guard

- `permission_mode: bypass` を `serve` で使う場合、env `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` を必須にする
- 未設定なら **lock 取得前** に exit 1 (二重起動チェックの副作用を残さないため)
- opt-in 済みでも起動時に強い警告ログ (`permission_mode=bypass で serve を起動します`) を 1 行出す
- `philharmonic run` (一過的実行) は引き続き opt-in env 不要 — guard は serve 限定

### `polling.interval_ms` の下限と warning

- zod schema 側で **下限 1000ms** を強制 (`MIN_POLLING_INTERVAL_MS = 1_000`)。1000ms 未満は config validation error で起動失敗
- 1000ms 以上 5000ms 未満は **warning ログを 1 行** 出して GitHub API rate limit への注意を促す
  (`LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS = 5_000`)
- 既定値は `30000` (30s) のまま。下限は典型値より十分低く設定して、検証用の高速 polling を許容しつつ過剰 polling は止める

### 起動シーケンス (Hardening 後)

1. token 解決 (失敗 → exit 1)
2. config 読み込み (失敗 → exit 1)
3. **bypass guard** (`permission_mode: bypass` で opt-in env が無ければ exit 1)
4. **lock 取得** (失敗 → exit 1)
5. logger 初期化、`bypass` / 低 polling の warning を 1 行ずつ
6. signal subscription を張る (recovery と serveLoop が同じ `AbortController.signal` を共有)
7. **Recovery フェーズ** を実行 (`In Progress` 引き取り。詳細は [orchestration-mvp.md#tracker-driven-recovery-serve-起動時](./orchestration-mvp.md#tracker-driven-recovery-serve-起動時))。recovery 中の SIGTERM は次 item には進まずに break する
8. `serveLoop` を呼ぶ
9. (loop 終了) `subscription.dispose()` → `lock.release()` を `finally` で必ず呼ぶ

### structured log 追加分

| level | msg                                               | fields                           | 説明                                                               |
| ----- | ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| warn  | `permission_mode=bypass で serve を起動します...` | `optInEnv`                       | bypass + opt-in 済みの起動時 1 回                                  |
| warn  | `polling.interval_ms が低く設定されています...`   | `intervalMs`, `recommendedMinMs` | `intervalMs < 5000` のときの起動時 1 回                            |
| warn  | `serve lock release に失敗`                       | `error`                          | shutdown 時の release 失敗 (race / FS エラー等)。daemon は終了済み |

## 外部依存

- 既存 `runOnce` (`src/orchestrator/run.ts`)
- 既存 `createLogger` (`src/logger/`)
- 新規 `acquireServeLock` (`src/serve/lock.ts`) — 二重起動防止用 local lock
- Node.js `AbortController` / `AbortSignal` (Node 22 LTS で標準)
- Node.js `process.on('SIG*', ...)` (CLI レイヤのみ)
- Node.js `process.kill(pid, 0)` — pid 生存確認 (lock の stale 判定)

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
