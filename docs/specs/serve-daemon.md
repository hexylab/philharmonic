# Serve Daemon — `philharmonic serve`

## 概要

Project board を一定間隔でポーリングし、候補があれば `philharmonic run` 相当の 1 ターン
orchestration を処理する常駐デーモンを `philharmonic serve` として提供する。
Symphony の "daemon workflow" 性に追いつくため、起動時の Tracker-driven recovery (#23) と
`max_concurrent_agents` による並列 dispatch (#24) を含む。

**自動 retry**: ADR-0005 で撤廃された **永続 / Status-driven** な retry は復活させないが、
Issue #84 / ADR-0008 で **in-memory のみ / 内部失敗起因** な retry queue を別機構として導入する
(詳細: [retry-queue.md](./retry-queue.md))。

## 関連 Issue

- #21 — philharmonic serve で常駐ポーリングデーモンを実装する
- #49 — serve daemon の安全性 hardening を行う (lock file / bypass guard / polling 下限 / process tree kill)
- #23 — Tracker-driven recovery を実装する (起動時に `In Progress` の引き取り。詳細は [orchestration-mvp.md#tracker-driven-recovery-serve-起動時](./orchestration-mvp.md#tracker-driven-recovery-serve-起動時))
- #24 — `max_concurrent_agents` による並列 dispatch (本ドキュメント [並列 dispatch (#24)](#並列-dispatch-24) セクション)
- #30 — Snapshot HTTP API を追加する (`/api/v1/state` / `/api/v1/<n>` / `/api/v1/refresh`)。詳細: [snapshot-api.md](./snapshot-api.md)
- #62 — Status 遷移 / PR 作成を agent に委譲し、自動 retry を撤廃する
- #68 — `serve` 起動前の手動 env export を不要化し、config (`github.token_source` / `safety.allow_bypass_in_serve`) と `gh auth` で起動できるようにする
- 関連 spec: [orchestration-mvp.md](./orchestration-mvp.md), [config-schema.md](./config-schema.md), [claude-runner.md](./claude-runner.md), [observability.md](./observability.md), [snapshot-api.md](./snapshot-api.md), [retry-queue.md](./retry-queue.md)
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
- **セキュリティ**: GitHub PAT は CLI レイヤと Runner subprocess の両方が保持する。Runner には `GITHUB_TOKEN` / `GH_TOKEN` を allowlist 経由で渡し、agent が `gh` / `git push` で利用する (ADR-0005)。token 文字列は config に書かない (#68)。`gh auth token` 経由で取得した場合は orchestrator が `process.env.GITHUB_TOKEN` に書き戻し、既存の allowlist 経路で runner に届ける
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

| level | msg                                               | fields                                   | 説明                                                                                    |
| ----- | ------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| info  | `serve started`                                   | `interval_ms`                            | loop 開始時 1 回                                                                        |
| info  | `poll tick`                                       | `interval_ms`                            | tick ごと                                                                               |
| info  | `no candidate`                                    | (`runOnce` 内ですでに出している)         | runOnce が `no_candidate` を返したとき                                                  |
| info  | `dispatch success`                                | `run_id`, `issue_number`, `branch`       | runOnce が `success` を返したとき                                                       |
| warn  | `dispatch failed`                                 | `run_id`, `issue_number`, `reason`       | runOnce が `failed` を返したとき                                                        |
| warn  | `dispatch error`                                  | `error`                                  | runOnce が throw したとき                                                               |
| info  | `dependency blocked`                              | `issue_number`, `blocking_issue_numbers` | candidate の依存先に open Issue があり dispatch 対象外になったとき (ADR-0007)           |
| warn  | `dependency invalid`                              | `issue_number`, `invalid_entries`        | candidate の `Depends-On:` が parse-invalid / 404 / 403 / fetch error のとき (ADR-0007) |
| warn  | `dependency cycle`                                | `issue_number`, `cycle_issue_numbers`    | candidate が循環依存に属しているとき (self-loop を含む。ADR-0007)                       |
| info  | `shutdown signal`                                 | `signal` (`SIGTERM` / `SIGINT`)          | 1 回目のシグナル受信                                                                    |
| warn  | `shutdown signal ignored (already shutting down)` | `signal`                                 | 2 回目以降のシグナル受信                                                                |
| info  | `serve stopped`                                   | -                                        | loop 終了経路を問わず必ず 1 行                                                          |

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

| エラー                       | 発生条件                                                                                    | 扱い方針                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GitHubTokenNotSetError`     | 起動時の token 解決 (`source: env` で env 空、または `auto` で env 空 + 後段で `gh` も失敗) | stderr に出して exit 1 (loop に入らない)                               |
| `GhCliNotFoundError`         | 起動時の token 解決 (`source: gh` / `auto` で `gh` 未インストール)                          | stderr に出して exit 1                                                 |
| `GhCliNotAuthenticatedError` | 起動時の token 解決 (`gh auth login` 未実行 / stdout 空 / `gh` exit !=0)                    | stderr に出して exit 1                                                 |
| bypass guard 失敗            | `permission_mode: bypass` で env / config どちらの opt-in も無し                            | stderr に出して exit 1 (token 解決前)                                  |
| `ConfigFileNotFoundError` 等 | config 読み込み                                                                             | stderr に出して exit 1                                                 |
| `BootstrapError`             | `runOnce` が throw                                                                          | `dispatch error` (warn) を log して次 tick に進む。daemon は落とさない |
| 想定外の `runOnce` 例外      | `runOnce` が throw                                                                          | 同上                                                                   |
| `runOnce` が `failed` を返す | runner 失敗 / hook 失敗                                                                     | `dispatch failed` (warn) を log して次 tick に進む                     |
| 二重シグナル受信             | shutdown 中にもう 1 回 SIGTERM 等                                                           | `shutdown signal ignored` (warn) を log のみで no-op                   |

## 自動 retry の撤廃 (ADR-0005) と in-memory retry queue (ADR-0008)

旧仕様 (#22) では `runOnce` が `failed` を返した Project Item を `retry.max_attempts` の範囲で `Failed → Todo` に自動的に戻す機能 (`RetryScheduler` / `promoteRetryReady` / `.philharmonic/retry-state.json`) を持っていた。これは ADR-0005 で **撤廃** された (Status は agent が書く設計に集約するため、永続 retry-state を捨てた)。

その後 Issue #84 / ADR-0008 で、別機構として **in-memory な retry queue** を導入する。違いは:

| 観点              | 旧 (#22, ADR-0005 で撤廃)               | 新 (#84, ADR-0008)                                       |
| ----------------- | --------------------------------------- | -------------------------------------------------------- |
| 永続化            | `.philharmonic/retry-state.json`        | **しない** (daemon プロセス内 Map のみ)                  |
| 駆動軸            | Project Status `Failed → Todo` 書き戻し | **内部失敗** (`failureReason` ∈ ADR-0008 §1) ベース      |
| Status 書き換え   | orchestrator が書く                     | **書かない** (ADR-0005 の方針を維持)                     |
| daemon 再起動跨ぎ | 永続ファイル経由で復元                  | 失われる → 既存 recovery (`In Progress` 引き取り) で代替 |
| template 変数     | `attempt` あり                          | 無し (prompt は変えない)                                 |

新 retry の詳細は [retry-queue.md](./retry-queue.md) / [ADR-0008](../adr/0008-in-memory-retry-queue.md) を参照。同 Issue を再実行したい場合の選択肢は:

- 自動 retry queue (in-memory, ADR-0008) で `agent.max_retry_attempts` 回まで自動再 dispatch
- agent 自身が判断して `gh` で `Failed → Todo` に戻す
- 人間が Project board で Status を `Todo` に戻す
- daemon 再起動時の recovery (In Progress 引き取り)

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
  1. retryQueue.drainDue(now) ← due な retry entry を最大 N 件まで先に消費 (#84 / ADR-0008)
       - 各 entry について Issue / Project Status を再取得して active 判定
       - active なら cleanupWorkspace で worktree force reset → retry task に積む
       - drop / reschedule は queue に戻すか log 出して落とす
       - 件数 = M
  2. fetchAcceptableCandidates(limit = N - M) ← 残り slot 分だけ通常選択
                                              二重 dispatch ガード (worktree 存在 / tracker) を含む
  3. retry tasks + fresh tasks (合計 ≤ N) について並列に dispatchSelected()
     ただし同時に走る dispatch 数は最大 N。N + M 件投入時は M 件が wait queue に入り、
     先行 dispatch の slot が空くたび pull される (汎用 worker pool で実装)
  4. 全件完了後 (Promise.allSettled): 失敗が retry-eligible なら retry queue に schedule
  5. 次 tick へ進む (sleep)
```

旧仕様にあった `promoteRetryReady` / `recordSuccess` / `recordFailure` の呼び出しは ADR-0005 で撤廃された (永続 retry-state 駆動の旧 retry)。新 retry queue (#84) はこれと別経路で in-memory のみで動く。

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

| level | msg                 | fields                                                                     | 説明                                                                                                           |
| ----- | ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| info  | `concurrent tick`   | `maxConcurrent`, `dispatched`, `retries` (ADR-0008)                        | 1 tick で N 件 dispatch を開始した時点の info。`retries` は当 tick の retry 件数                               |
| info  | `dispatch success`  | `slot`, `runId`, `issueNumber`, `branch`                                   | 並列 dispatch 1 件成功                                                                                         |
| warn  | `dispatch failed`   | `slot`, `runId`, `issueNumber`, `reason`                                   | 並列 dispatch 1 件失敗                                                                                         |
| warn  | `dispatch error`    | `slot`, `issueNumber`, `error`                                             | 並列 dispatch 内で `dispatchSelected` が想定外 throw した場合 (failed として記録)                              |
| info  | `retry due`         | `issueNumber`, `attempt`, `lastRunId`                                      | retry queue から drain した時点 (#84 / ADR-0008)                                                               |
| info  | `retry skipped`     | `issueNumber`, `attempt`, `reason`                                         | retry を drop または reschedule (closed / terminal_status / inactive_status / fetch_error / tracker_in_flight) |
| info  | `retry scheduled`   | `issueNumber`, `attempt`, `delayMs`, `dueAt`, `failureReason`, `lastRunId` | 失敗を受けて retry queue に schedule した時点                                                                  |
| warn  | `retry exhausted`   | `issueNumber`, `attempt`, `failureReason`, `lastRunId`                     | `agent.max_retry_attempts` を使い切って drop した時点                                                          |
| warn  | `retry drain error` | `error`                                                                    | retry drain 中に Project candidate fetch 等が失敗した時点                                                      |

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

- `permission_mode: bypass` を `serve` で使う場合、明示的な opt-in を要求する
- opt-in は **以下のどちらか** を満たせばよい (#68 で OR に拡張):
  1. `philharmonic.yaml` の `safety.allow_bypass_in_serve: true` ← 推奨
  2. env `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` ← 後方互換 / 一時的なオーバーライド
- どちらも満たさない場合は **lock 取得前** に exit 1。エラーメッセージで両経路を案内する
- ADR-0005 で agent 委譲型では `bypass` が実用上必須となったが、長時間連続発火を抑止するため opt-in は維持する
- opt-in 済みでも起動時に強い警告ログ (`permission_mode=bypass で serve を起動します`) を 1 行出す。fields は `optInEnv` / `configOptIn`
- `philharmonic run` (一過的実行) は引き続き opt-in 不要 — guard は serve 限定

### `polling.interval_ms` の下限と warning

- zod schema 側で **下限 1000ms** を強制
- 1000ms 以上 5000ms 未満は warning ログを出す
- 既定値は `30000` (30s) のまま

### 起動シーケンス (Hardening 後)

1. config 読み込み (失敗 → exit 1)
2. **bypass guard** (`permission_mode: bypass` で env / config どちらの opt-in も無ければ exit 1) (#68)
3. **token 解決** (`config.github.tokenSource` を使う。失敗 → exit 1。`gh` 経由で取れた場合は `process.env.GITHUB_TOKEN` に書き戻す) (#68)
4. **lock 取得** (失敗 → exit 1)
5. logger 初期化、`bypass` / 低 polling の warning を 1 行ずつ
6. signal subscription を張る
7. **Recovery フェーズ** を実行 (`In Progress` 引き取り)
8. `serveLoop` を呼ぶ
9. (loop 終了) `subscription.dispose()` → `apiServer.close()` → `workflowSource.close()` → `lock.release()`

### structured log 追加分

| level | msg                                               | fields                           | 説明                                                                                                               |
| ----- | ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| info  | `github token resolved`                           | `source`, `origin`               | token 解決成功時 1 回。`source` は config 値 (`env` / `gh` / `auto`)、`origin` は実際の取得元 (`env` / `gh`) (#68) |
| warn  | `permission_mode=bypass で serve を起動します...` | `optInEnv`, `configOptIn`        | bypass + opt-in 済みの起動時 1 回。どちらの経路で opt-in したかが分かる (#68)                                      |
| warn  | `polling.interval_ms が低く設定されています...`   | `intervalMs`, `recommendedMinMs` | `intervalMs < 5000` のときの起動時 1 回                                                                            |
| warn  | `serve lock release に失敗`                       | `error`                          | shutdown 時の release 失敗 (race / FS エラー等)                                                                    |

## active run watchdog (#105)

`philharmonic serve` が tracker 上 `In Progress` と認識している run について、孤児化 (= サイレント停止) を運用者が判別できる最小スコープの安全機構。

### 目的

- **terminal repair**: run dir に `metadata.json` (status: `success` / `failed`) が既にあるのに tracker が running のままという「明確に修復可能な状態」を検出し、`tracker.runFinished` をべき等に呼んで in-flight set から外す
- **可視化**: pid 消失 / activity 停止の疑いを Snapshot API / dashboard に `orphaned` / `stale` marker として表示する
- **誤検知ガード**: pid 消失 / activity 停止だけを根拠に runner kill / worktree cleanup / retry dispatch を **行わない**。長時間の tool wait / advisor wait を誤って止めない

### 起動契機

`serveLoop` は新しい独立 timer を持たず、**poll tick の冒頭** (= `wrappedRunOnce` の最初) で `runWatchdog` を 1 回呼ぶ。実装は `src/orchestrator/watchdog.ts`。watchdog 中の例外は warn ログ 1 行に握って次フェーズ (`runOnce` / `runConcurrent`) に進む (daemon は落とさない)。

### 入出力

入力 (DI):

- `tracker: RunTracker` — `listRunning()` / `runFinished()` / `setWatchdog()` を使う
- `stallTimeoutMs: number` — `agent.stall_timeout_ms` の現値。`<= 0` で stale 判定 off
- `now: Date` — 現在時刻 (テスト用)
- `readMetadata: (runLogPath) => Promise<RunMetadataSnapshot | null>` — `<runLogPath>/metadata.json` を読む default 実装あり
- `processAlive: (pid) => boolean` — `process.kill(pid, 0)` の wrapper。default は ESRCH のみ dead 扱い

出力:

- `repaired[]` — 当 tick で terminal metadata により tracker から外した entry
- `markers[]` — 当 tick で marker が立っている (orphaned / stale) entry の最新状態

### 判定ルール

各 `running entry` について順に評価する。

1. `<entry.runLogPath>/metadata.json` を読む
   - 読めて `status` が `success` / `failed`: `tracker.runFinished({ kind: status, ..., reason: failureReason ?? 'runner_error', totalCostUsd })` を呼んで repair。次の entry へ
   - ENOENT / parse 不能 / status が他値: 続行
   - その他 IO エラー: warn ログを残して続行 (repair は次 tick で再試行)
2. `entry.runnerPid !== null` かつ `process.kill(pid, 0)` が ESRCH: `reasons` に `'orphaned'` を追加
3. `stallTimeoutMs > 0` かつ `now - lastActivityAt > stallTimeoutMs * 2`: `reasons` に `'stale'` を追加
4. `reasons` の状態に応じて `tracker.setWatchdog(runId, ...)` を呼ぶ
   - `reasons.length === 0` かつ既存 `entry.watchdog !== null`: `null` で marker 解消
   - `reasons.length > 0`: `{ reasons, orphanedSince, staleSince }` で書き戻す。`orphanedSince` / `staleSince` は **初出時刻を保持** する (active な間は同じ値、非活性に戻ったら次回 active 化で新しい時刻)

### 副作用

- `tracker.runFinished` (terminal repair 時のみ)
- `tracker.setWatchdog` (orphaned / stale で marker を立てる / 解除する)
- 構造化ログ:
  - `info`: `watchdog terminal repair` (repair した瞬間 1 回)
  - `warn`: `watchdog marker` (marker の組み合わせが切り替わった瞬間 1 回。tick ごとの再出力は無し)
  - `warn`: `watchdog metadata read failed` (IO エラーで repair を skip した tick)
  - `warn`: `watchdog tick failed` (`runWatchdog` 自体が throw、cli/serve.ts 側で catch)

### やらないこと (Issue #105)

- pid 消失だけを根拠に worktree cleanup
- pid 消失だけを根拠に retry dispatch
- activity 停止だけを根拠に Project Status を `Failed` に倒す
- `philharmonic retry <issue-number>` のような手動 retry CLI (= 別 Issue)
- dashboard の Running 詳細活動表示 (= #98)

## orphan recovery (#109)

`active run watchdog` (#105) が立てた marker のうち、**安全条件を満たした entry だけ** を自動的に retry queue / Failed safety-net に接続するフェーズ。`runWatchdog` の直後、`runOnce` / `runConcurrent` の前に `recoverOrphaned` (`src/orchestrator/orphan-recovery.ts`) を 1 回呼ぶ。watchdog 自身は観測専用に維持し、副作用 (`tracker.runFinished` / `retryQueue.schedule` / `handleFailureExhaustion`) は本フェーズに集約する。

### 自動 recovery の合格条件 (AND)

以下を **全て** 満たしたときに限り、`runFinished` → `retryQueue.schedule(kind=failure)` をこの順で発火する。

1. `entry.watchdog.reasons` が `'orphaned'` と `'stale'` の **両方** を含む
2. retry queue が DI されており、`agent.max_retry_attempts >= 1`
3. `entry.workspacePath` が `workspaceRoot` 配下 (path traversal を弾く)
4. `feature/<issueNumber>-` の open PR が 0 件 (agent が PR 作って Status flip 前死亡の稀ケース保護)
5. Project Items から `repository` / `itemId` が取れる (= 上限到達時の Failed safety-net が動かせる)

合格時の `attempt` 番号は永続化 retry entry が同 Issue に残っていれば `existing.attempt + 1`、それ以外は `1`。`failureReason` は **`stalled`** で固定 (orphaned + stale + activity 停止という事実が最も意味的に一致するため)。

`nextAttempt > maxRetryAttempts` のときは `handleFailureExhaustion` (ADR-0010) を呼んで Project Status を `Failed` に倒し、Issue にコメントする。`via=watchdog` を log field に載せる。

### operator action required

合格条件のいずれかに失敗した entry は **自動 recovery を行わず**、`tracker.setWatchdog` で `operatorActionRequired: true` を立てて理由 (`operatorActionReasons`) を記録する。dashboard / Snapshot API には `running[].watchdog.operator_action_required` / `operator_action_reasons` として露出する。

| reason                  | 発火条件                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `orphaned_only`         | `reasons` が `['orphaned']` のみ (pid 死亡だけ。activity 停止が確認できていない) |
| `stale_only`            | `reasons` が `['stale']` のみ (pid 生存。Claude の長期 wait の可能性)            |
| `open_pr`               | `feature/<num>-` の open PR が 1 件以上                                          |
| `retry_disabled`        | retry queue 未注入 / `max_retry_attempts <= 0`                                   |
| `unsafe_workspace_path` | `entry.workspacePath` が `workspaceRoot` 配下でない                              |
| `recover_error`         | `listOpenPullRequests` / `fetchProjectCandidates` が throw / candidate 未発見    |

`orphaned_only` / `stale_only` は `runWatchdog` 内で marker を更新した瞬間に立てる (orphan recovery を経由しない)。それ以外は `recoverOrphaned` 内で entry の既存 `operatorActionReasons` に追記する。

### double-dispatch / unsafe action 防止

- `tracker.runFinished` を `retryQueue.schedule` より **先に** 呼ぶ。`drainRetryQueue` は同 tick 内で再 schedule した entry (dueAt = now + 10s) を pop しないが、順序保証として明示する
- worktree は **削除しない** (retry queue drain phase で `cleanupWorkspace` する既存挙動に任せる)。orphan recovery で worktree を直接触ると open PR 誤検知時に作業を失う危険があるため
- `unsafe_workspace_path` のときは `cleanupWorkspace` を呼ばないので、`workspaceRoot` 外への副作用は構造的に発生しない

### 構造化ログ

| level | msg                                        | fields                                                                                              |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| warn  | `orphan recovered`                         | `runId`, `issueNumber`, `attempt`, `dueAt`, `delayMs`, `branch`, `workspacePath`, `via=watchdog`    |
| warn  | `orphan recovery operator action required` | `runId`, `issueNumber`, `reasons`, `branch`, `workspacePath` (marker が初出 / 変化した tick のみ)   |
| warn  | `orphan recovery error`                    | `runId`, `issueNumber`, `stage`, `error` (`listOpenPullRequests` / `fetchProjectCandidates` 失敗時) |
| warn  | `orphan recovery tick failed`              | `error` (`recoverOrphaned` 自体が throw した場合、`cli/serve.ts` 側で catch)                        |
| warn  | `retry exhausted`                          | `kind=failure`, `via=watchdog`, ...既存 fields (上限到達経路)                                       |

## GitHub token 解決 (#68)

`serve` 起動前に手動で `export GITHUB_TOKEN=...` を要求しないため、token の取得元を config で選べるようにする。token 文字列そのものは絶対に YAML に書かない (誤 commit リスク)。

### `github.token_source` の意味

| 値     | 挙動                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| `env`  | `GITHUB_TOKEN` → `GH_TOKEN` の順に env を読む。空なら `GitHubTokenNotSetError` で exit 1      |
| `gh`   | `gh auth token` を起動時に 1 回呼ぶ。stdout が空 / `gh` 不在 / `gh` exit !=0 のいずれもエラー |
| `auto` | env を試し、空なら `gh` に fallback。デフォルト (#68)                                         |

### 取得先別エラー

| 状態                                            | 例外                         | exit |
| ----------------------------------------------- | ---------------------------- | ---- |
| env 未設定 (`source: env`)                      | `GitHubTokenNotSetError`     | 1    |
| `gh` コマンド未インストール                     | `GhCliNotFoundError`         | 1    |
| `gh auth login` 未実行 / scope 不足で stdout 空 | `GhCliNotAuthenticatedError` | 1    |
| `auto` で env 空 + `gh` 未インストール          | `GhCliNotFoundError`         | 1    |

`gh` の **scope 不足** (PAT に Project / Issue 権限が無い等) は `gh auth token` 自体は成功してしまうため、ここでは検出できない。実態として GitHub API 呼び出し時に 403 で落ちるため、その時点のエラーメッセージで気づく設計。

### Runner subprocess への透過

orchestrator が解決した token を `process.env.GITHUB_TOKEN` に書き戻す。Runner subprocess は既存の `buildRunnerEnv` allowlist 経由で `GITHUB_TOKEN` を受け取り、agent が `gh` / `git push` で利用する (ADR-0005)。`gh` 経由で取得した場合も既存経路と同一になるため、Runner 側の追加変更は不要。

### token がログに出ない (acceptance criteria)

- `info` レベルでは `source` (config 値) と `origin` (`env` / `gh`) のみを出す。`token` フィールドは log オブジェクトに **含めない**
- error メッセージにも token 文字列は含まない (`GhCliNotAuthenticatedError` は `gh` の stderr tail を出すが、ここに token が含まれることはない)
- test (`tests/cli/serve.test.ts`) で stderr / stdout / logger の全 call args を集計し、token が含まれないことを assert する

### `philharmonic run` / `philharmonic projects` との共通化

- `philharmonic run` も同じ resolver を使う (config 経由で `github.token_source` を読む)
- `philharmonic projects list` は config 非依存 (`--owner` / `--project` 必須) のため、`--token-source <env|gh|auto>` フラグで同じ resolver を呼ぶ。default は `auto`

## 外部依存

- 既存 `runOnce` (`src/orchestrator/run.ts`)
- 既存 `createLogger` (`src/logger/`)
- `acquireServeLock` (`src/serve/lock.ts`)
- `resolveGitHubToken` (`src/github/token.ts`) (#68)
- `gh` CLI (token_source が `gh` / `auto` のとき。`gh auth token` を 1 回 spawn)
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
- 永続 retry-state を伴う Status 駆動 retry (ADR-0005 で撤廃。in-memory な retry queue は ADR-0008 で別途追加)
- in-flight run の強制中断
- HTTP ヘルスチェックエンドポイント (Snapshot HTTP API は #30 で別途追加 — 詳細: [snapshot-api.md](./snapshot-api.md))
- systemd / launchd 用 unit ファイル同梱
- daemon 連続稼働中の **任意失敗** の自動救済 (in-memory retry queue は ADR-0008 で `runner_error` 等の限定された failureReason のみカバーする。それ以外 / queue が消えたケースは次回 `serve` 起動時の recovery に任せる)
