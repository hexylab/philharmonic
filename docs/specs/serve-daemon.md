# Serve Daemon — `philharmonic serve`

## 概要

Project board を一定間隔でポーリングし、候補があれば `philharmonic run` 相当の 1 ターン
orchestration を処理する常駐デーモンを `philharmonic serve` として提供する。
Symphony の "daemon workflow" 性に追いつくため、起動時の Tracker-driven recovery (#23) と
`max_concurrent_agents` による並列 dispatch (#24) を含む。**自動 retry は ADR-0005 で撤廃** (agent 委譲)。

## 関連 Issue

- #21 — philharmonic serve で常駐ポーリングデーモンを実装する
- #49 — serve daemon の安全性 hardening を行う (lock file / bypass guard / polling 下限 / process tree kill)
- #23 — Tracker-driven recovery を実装する (起動時に `In Progress` の引き取り。詳細は [orchestration-mvp.md#tracker-driven-recovery-serve-起動時](./orchestration-mvp.md#tracker-driven-recovery-serve-起動時))
- #24 — `max_concurrent_agents` による並列 dispatch (本ドキュメント [並列 dispatch (#24)](#並列-dispatch-24) セクション)
- #30 — Snapshot HTTP API を追加する (`/api/v1/state` / `/api/v1/<n>` / `/api/v1/refresh`)。詳細: [snapshot-api.md](./snapshot-api.md)
- #62 — Status 遷移 / PR 作成を agent に委譲し、自動 retry を撤廃する
- 関連 spec: [orchestration-mvp.md](./orchestration-mvp.md), [config-schema.md](./config-schema.md), [claude-runner.md](./claude-runner.md), [observability.md](./observability.md), [snapshot-api.md](./snapshot-api.md)
- 設計前提: [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md)

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
- 1 tick の流れ (`agent.max_concurrent_agents == 1` の互換挙動):
  1. `poll tick` ログを 1 行出す
  2. `runOnce` を await し、結果に応じて `dispatch success` / `dispatch failed` / `no candidate` を log
  3. `runOnce` が throw した場合は `dispatch error` (warn) を出して次 tick に進む
  4. signal が aborted なら break、そうでなければ `polling.interval_ms` だけ sleep (abortable)
- `agent.max_concurrent_agents > 1` のときは 1 tick で最大 N 件まで並列 dispatch する ([並列 dispatch (#24)](#並列-dispatch-24) を参照)
- 起動直後は **即時 1 回 poll** する
- 終了経路 (signal / 例外) を問わず必ず `serve stopped` ログを 1 行出す
- 終了 exit code は **0** (graceful shutdown は正常終了)。Bootstrap 段階で config / token に失敗した場合のみ exit 1
- candidate selection の段階で **二重 dispatch ガード** を入れる (orchestration-mvp.md「Candidate Selection Rule」)。Status flip が agent に渡ったため、worktree 既存 / in-flight tracker に積まれている Issue は skip する

## SIGTERM / SIGINT で graceful shutdown

- CLI レイヤで `process.on('SIGTERM', ...)` / `process.on('SIGINT', ...)` を listen する
- 受信時に `AbortController.abort()` を呼ぶ。loop はこの signal を見て次 tick に進まないように break する
- in-flight run は subprocess 強制終了せず、最後まで完走させる
- 二重シグナル受信は warn ログ 1 行を出して以降は no-op
- loop 終了後、登録した signal listener は確実に外す

## 非機能要件

- **性能**: 単一プロセスで 1 tick = 1 run。tick あたりの GraphQL/REST 呼び出し数は `philharmonic run` と同等
- **可用性**: 単発失敗は次 tick まで待つ。runner exit ≠ 0 + agent が Failed flip 前に死亡したケースは **次回 `serve` 起動時の recovery でのみ拾う** (daemon 連続稼働中の自動救済はやらない)
- **セキュリティ**: GitHub PAT は CLI レイヤと Runner subprocess の両方が保持する。Runner には `GITHUB_TOKEN` / `GH_TOKEN` を allowlist 経由で渡し、agent が `gh` / `git push` で利用する (ADR-0005)
- **アクセシビリティ**: 該当しない (非対話 / CLI のみ)

## データモデル

### Config (`philharmonic.yaml`)

```yaml
polling:
  interval_ms: 30000 # default 30s
agent:
  max_concurrent_agents: 1 # default 1 (1 tick で並列 dispatch する Issue 件数の上限)
```

| キー                          | 型                  | 必須 | デフォルト | 説明                                                                |
| ----------------------------- | ------------------- | ---- | ---------- | ------------------------------------------------------------------- |
| `polling.interval_ms`         | `integer (>= 1000)` | no   | `30000`    | 1 tick 終了後の sleep 時間 (ミリ秒)。下限 1000ms (#49)              |
| `agent.max_concurrent_agents` | `integer (>= 1)`    | no   | `1`        | 1 tick で並列 dispatch する Issue 件数の上限。`1` で逐次 (MVP 互換) |

ADR-0005 で `retry.*` (`retry.max_attempts` / `retry.max_backoff_ms`) は config schema から撤廃された。

`polling` / `agent` どちらも省略可、空オブジェクト `{}` でも内側 default が補完される。
未知キーは zod の `.strict()` で拒否される。詳細フィールド一覧は [config-schema.md](./config-schema.md) を参照。

### structured log

| level | msg                                               | fields                             | 説明                                   |
| ----- | ------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| info  | `serve started`                                   | `interval_ms`                      | loop 開始時 1 回                       |
| info  | `poll tick`                                       | `interval_ms`                      | tick ごと                              |
| info  | `no candidate`                                    | (`runOnce` 内ですでに出している)   | runOnce が `no_candidate` を返したとき |
| info  | `dispatch success`                                | `run_id`, `issue_number`, `branch` | runOnce が `success` を返したとき      |
| warn  | `dispatch failed`                                 | `run_id`, `issue_number`, `reason` | runOnce が `failed` を返したとき       |
| warn  | `dispatch error`                                  | `error`                            | runOnce が throw したとき              |
| info  | `shutdown signal`                                 | `signal` (`SIGTERM` / `SIGINT`)    | 1 回目のシグナル受信                   |
| warn  | `shutdown signal ignored (already shutting down)` | `signal`                           | 2 回目以降のシグナル受信               |
| info  | `serve stopped`                                   | -                                  | loop 終了経路を問わず必ず 1 行         |

`pr_number` は orchestrator が知れなくなったため `dispatch success` のフィールドから外れた。PR 番号を運用で追いたい場合は agent が Issue / PR コメントに書いた内容や `gh pr list` で取得する。

## API / インターフェース

### CLI

```
$ philharmonic serve [-c <path>]
```

### `serveLoop` (`src/orchestrator/serve.ts`)

```ts
type ServeLoopRunOnce = () => Promise<RunOnceResult>;
type ServeLoopSleep = (ms: number, signal: AbortSignal, wakeSignal?: AbortSignal) => Promise<void>;

type ServeLoopDeps = {
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
  runOnce: ServeLoopRunOnce;
  sleep?: ServeLoopSleep;
  acquireWakeSignal?: () => AbortSignal | undefined;
  onPollTick?: () => void;
};

function serveLoop(deps: ServeLoopDeps): Promise<void>;
function abortableSleep(ms: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void>;
```

- `runOnce` は CLI レイヤで wrap 済み
- `signal` は CLI レイヤの `AbortController.signal`
- 例外は `serveLoop` 内で握って `dispatch error` を log してから次 tick に進む
- 終了経路を問わず `serve stopped` を `finally` で出す

## エラーハンドリング

| エラー                       | 発生条件                          | 扱い方針                                                               |
| ---------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `GITHUB_TOKEN` 未設定        | 起動時の token 解決               | stderr に出して exit 1 (loop に入らない)                               |
| `ConfigFileNotFoundError` 等 | config 読み込み                   | stderr に出して exit 1                                                 |
| `BootstrapError`             | `runOnce` が throw                | `dispatch error` (warn) を log して次 tick に進む。daemon は落とさない |
| 想定外の `runOnce` 例外      | `runOnce` が throw                | 同上                                                                   |
| `runOnce` が `failed` を返す | runner 失敗 / hook 失敗           | `dispatch failed` (warn) を log して次 tick に進む                     |
| 二重シグナル受信             | shutdown 中にもう 1 回 SIGTERM 等 | `shutdown signal ignored` (warn) を log のみで no-op                   |

## 自動 retry の撤廃 (ADR-0005)

旧仕様 (#22) では `runOnce` が `failed` を返した Project Item を `retry.max_attempts` の範囲で `Failed → Todo` に自動的に戻す機能 (`RetryScheduler` / `promoteRetryReady` / `.philharmonic/retry-state.json`) を持っていた。

ADR-0005 で「対話的 state を agent 側で完結」する方針に倒したため、retry も agent 領域となり、本機能は **撤廃** された。同 Issue を再実行したい場合は:

- agent 自身が判断して `gh` で `Failed → Todo` に戻す
- 人間が Project board で Status を `Todo` に戻す

のいずれかで対応する。`config.retry.*` / `RetryScheduler` / `promoteRetryReady` / `.philharmonic/retry-state.json` / template 変数 `attempt` はすべて削除済み。

## 二重 dispatch ガード (ADR-0005)

agent が `Todo → In Progress` flip を行うため、orchestrator の candidate selection が agent flip 前に同 Issue を再 pick するリスクがある。これを防ぐため、`select` 関数の最終フィルタに以下二段ガードを追加する。

1. **worktree 存在チェック**: `<workspace_root>/issue-<番号>` が既に存在する Issue は skip
2. **in-flight tracker チェック**: `runTracker.getRunningByIssue(issueNumber) !== null` の Issue は skip

(1) は cross-tick / cross-process の防御、(2) は同 tick 内の並列 dispatch の防御。

実装は `src/orchestrator/select.ts` の `selectFirstByStatus` / candidate filter の DI 引数で `pathExists` / `runTracker` を受け取り、テストで容易に差し替えられる形にする。

## 並列 dispatch (#24)

`serve` daemon の loop の中で、`agent.max_concurrent_agents` 件まで複数 Issue を並列 dispatch する。
1 ホストで Claude Code subprocess を N 並列に走らせて単純にスループットを上げるための機能で、
状態別上限 (`max_concurrent_agents_by_state`) は本仕様の範囲外 (将来検討)。

### スコープ

- **対象**: `serve` の通常 loop (`Recovery` 後の poll tick) のみ
- **対象外**:
  - `philharmonic run` (1 ターン実行) は引き続き 1 件のみ処理する
  - Recovery フェーズ (#23) は 1 件ずつ逐次のまま
  - 状態別上限 / queue 永続化 / multi-host 跨ぎ並列

### 動作概要

設定値 `N = agent.max_concurrent_agents` (default 1) として:

```
each tick:
  1. fetchAcceptableCandidates(limit = N)  ← 上から最大 N 件 acceptable な candidate を取る
                                              二重 dispatch ガード (worktree 存在 / tracker) を含む
  2. 各 candidate について並列に dispatchSelected() (workspace → prompt → runner → cleanup)
     ただし同時に走る dispatch 数は最大 N。N + M 件投入時は M 件が wait queue に入り、
     先行 dispatch の slot が空くたび pull される (汎用 worker pool で実装)
  3. 全件完了後 (Promise.allSettled) に次 tick へ進む (sleep)
```

旧仕様にあった `promoteRetryReady` / `recordSuccess` / `recordFailure` の呼び出しは ADR-0005 で撤廃された。

### Slot pool (wait queue 挙動)

実装は汎用ワーカープール `dispatchPool({ tasks, maxConcurrent, worker })`:

- `tasks` を順番に消費する iterator を 1 つ持つ
- `min(maxConcurrent, tasks.length)` 個の slot worker を起動し、各 worker は iterator から次の task を取って await する
- iterator が空になったら worker は終了、残り slot worker の完了を `Promise.all` で待つ
- 結果配列は task の入力順で返す

### 各 dispatch の独立性

- 各 dispatch は独立した Promise として走り、相互に状態を汚染しない
- 例外 (BootstrapError 含む) は **その dispatch の中で握って結果配列に `failed` として落とす**

### 設定 (philharmonic.yaml)

```yaml
agent:
  max_concurrent_agents: 1 # default 1 (MVP 互換)
```

詳細は [config-schema.md](./config-schema.md) の `agent.max_concurrent_agents` を参照。

### structured log 追加分

`agent.max_concurrent_agents > 1` の dispatch 結果ログには `slot` (0..N-1) を必ず含める。

| level | msg                | fields                                   | 説明                                                                              |
| ----- | ------------------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| info  | `concurrent tick`  | `maxConcurrent`, `dispatched`            | 1 tick で N 件 dispatch を開始した時点の info                                     |
| info  | `dispatch success` | `slot`, `runId`, `issueNumber`, `branch` | 並列 dispatch 1 件成功                                                            |
| warn  | `dispatch failed`  | `slot`, `runId`, `issueNumber`, `reason` | 並列 dispatch 1 件失敗                                                            |
| warn  | `dispatch error`   | `slot`, `issueNumber`, `error`           | 並列 dispatch 内で `dispatchSelected` が想定外 throw した場合 (failed として記録) |

`max_concurrent_agents == 1` のとき (互換挙動) は `slot` を含めず従来どおりのログ形式を維持する。

## Hardening (#49)

`serve` を長時間・無人で回す前提の安全対策を bootstrap 段階に集約している。

### 二重起動防止 (local lock file)

- lock file: `<repoRoot>/.philharmonic/serve.lock` (相対固定)
- 内容: `{ pid: number, hostname: string, startedAt: ISO8601 string }` を JSON で保存
- 取得: `open(path, 'wx')` で **atomic** 作成
- 既存 lock 検出時の判定階層:
  1. JSON parse 失敗 → stale 扱いで奪取
  2. `hostname` が現在ホストと異なる → `ServeLockHeldOnDifferentHostError` で exit 1
  3. 同 host + pid 生存 (`process.kill(pid, 0)`) → `ServeLockHeldError` で exit 1
  4. 同 host + pid 死亡 → stale 扱いで奪取
- 解放 (`release()`): lock の中身が**自分の pid と一致しているとき**だけ `unlink`
- bootstrap (token / config / bypass guard) を全て通った後に lock を取る
- `serveLoop` の `finally` で必ず `release()` を呼ぶ

### `permission_mode: bypass` の opt-in guard

- `permission_mode: bypass` を `serve` で使う場合、env `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` を必須にする
- 未設定なら **lock 取得前** に exit 1
- ADR-0005 で agent 委譲型では `bypass` が実用上必須となったが、長時間連続発火を抑止するため opt-in env は維持する
- opt-in 済みでも起動時に強い警告ログ (`permission_mode=bypass で serve を起動します`) を 1 行出す
- `philharmonic run` (一過的実行) は引き続き opt-in env 不要 — guard は serve 限定

### `polling.interval_ms` の下限と warning

- zod schema 側で **下限 1000ms** を強制
- 1000ms 以上 5000ms 未満は warning ログを出す
- 既定値は `30000` (30s) のまま

### 起動シーケンス (Hardening 後)

1. token 解決 (失敗 → exit 1)
2. config 読み込み (失敗 → exit 1)
3. **bypass guard** (`permission_mode: bypass` で opt-in env が無ければ exit 1)
4. **lock 取得** (失敗 → exit 1)
5. logger 初期化、`bypass` / 低 polling の warning を 1 行ずつ
6. signal subscription を張る
7. **Recovery フェーズ** を実行 (`In Progress` 引き取り)
8. `serveLoop` を呼ぶ
9. (loop 終了) `subscription.dispose()` → `apiServer.close()` → `workflowSource.close()` → `lock.release()`

### structured log 追加分

| level | msg                                               | fields                           | 説明                                            |
| ----- | ------------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| warn  | `permission_mode=bypass で serve を起動します...` | `optInEnv`                       | bypass + opt-in 済みの起動時 1 回               |
| warn  | `polling.interval_ms が低く設定されています...`   | `intervalMs`, `recommendedMinMs` | `intervalMs < 5000` のときの起動時 1 回         |
| warn  | `serve lock release に失敗`                       | `error`                          | shutdown 時の release 失敗 (race / FS エラー等) |

## 外部依存

- 既存 `runOnce` (`src/orchestrator/run.ts`)
- 既存 `createLogger` (`src/logger/`)
- `acquireServeLock` (`src/serve/lock.ts`)
- Node.js `AbortController` / `AbortSignal`
- Node.js `process.on('SIG*', ...)` (CLI レイヤのみ)
- Node.js `process.kill(pid, 0)`

## オープンクエスチョン

- in-flight run を SIGTERM で強制中断するモード (`--force-shutdown` 等) の導入可否
- jitter による thundering herd 回避の必要性
- Linux 以外 (Windows) での SIGTERM/SIGINT 挙動差
- daemon 連続稼働中の自動救済 (runner exit ≠ 0 + agent が Failed flip 前に死亡) のサポート可否 — 現状は人手 / 次回起動時 recovery に任せる

## MVP でやらないこと

- 状態別上限 (`max_concurrent_agents_by_state`)
- 自動 retry (ADR-0005 で撤廃)
- in-flight run の強制中断
- HTTP ヘルスチェックエンドポイント (Snapshot HTTP API は #30 で別途追加 — 詳細: [snapshot-api.md](./snapshot-api.md))
- systemd / launchd 用 unit ファイル同梱
- daemon 連続稼働中の自動救済
