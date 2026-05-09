# Serve Daemon — `philharmonic serve`

## 概要

Project board を一定間隔でポーリングし、候補があれば `philharmonic run` 相当の 1 ターン
orchestration を処理する常駐デーモンを `philharmonic serve` として提供する。
Symphony の "daemon workflow" 性に追いつくため、起動時の Tracker-driven recovery (#23)、
loop 中の自動 retry (#22)、`max_concurrent_agents` による並列 dispatch (#24) を含む。

## 関連 Issue

- #21 — philharmonic serve で常駐ポーリングデーモンを実装する
- #49 — serve daemon の安全性 hardening を行う (lock file / bypass guard / polling 下限 / process tree kill)
- #23 — Tracker-driven recovery を実装する (起動時に `In Progress` の引き取り。詳細は [orchestration-mvp.md#tracker-driven-recovery-serve-起動時](./orchestration-mvp.md#tracker-driven-recovery-serve-起動時))
- #22 — 失敗時の自動 retry (exponential backoff) を実装する (本ドキュメント [自動 retry (#22)](#自動-retry-22) セクション)
- #24 — `max_concurrent_agents` による並列 dispatch (本ドキュメント [並列 dispatch (#24)](#並列-dispatch-24) セクション)
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
- 1 tick の流れ (`agent.max_concurrent_agents == 1` の互換挙動):
  1. `poll tick` ログを 1 行出す
  2. `runOnce` を await し、結果に応じて `dispatch success` / `dispatch failed` / `no candidate` を log
  3. `runOnce` が throw した場合は `dispatch error` (warn) を出して次 tick に進む
  4. signal が aborted なら break、そうでなければ `polling.interval_ms` だけ sleep (abortable)
- `agent.max_concurrent_agents > 1` のときは 1 tick で最大 N 件まで並列 dispatch する ([並列 dispatch (#24)](#並列-dispatch-24) を参照)
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
- **可用性**: 単発失敗は次 tick まで待つ (回復は次 tick の自然 retry に委ねる)。連続失敗の
  自動 retry (exponential backoff) は [自動 retry (#22)](#自動-retry-22) セクションで定義
- **セキュリティ**: GitHub PAT は CLI レイヤのみが保持。Runner subprocess へは `runOnce` 経由で
  `buildRunnerEnv` が token を除去した env を渡す (既存挙動を流用)
- **アクセシビリティ**: 該当しない (非対話 / CLI のみ)

## データモデル

### Config (`philharmonic.yaml`)

```yaml
polling:
  interval_ms: 30000 # default 30s
retry:
  max_attempts: 3 # default 3 (0 で自動 retry 無効)
  max_backoff_ms: 600000 # default 10 分
```

| キー                   | 型                  | 必須 | デフォルト | 説明                                                                                                    |
| ---------------------- | ------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `polling.interval_ms`  | `integer (>= 1000)` | no   | `30000`    | 1 tick 終了後の sleep 時間 (ミリ秒)。下限 1000ms (#49)                                                  |
| `retry.max_attempts`   | `integer (>= 0)`    | no   | `3`        | `Failed` を自動的に `Todo` に戻す最大回数。`0` で無効化 (詳細は [自動 retry (#22)](#自動-retry-22))     |
| `retry.max_backoff_ms` | `integer (>= 1)`    | no   | `600000`   | exponential backoff の上限 (ミリ秒)。`backoff(attempt) = min(10_000ms × 2^(attempt-1), max_backoff_ms)` |

`polling` / `retry` どちらも省略可、空オブジェクト `{}` でも内側 default が補完される。
未知キーは zod の `.strict()` で拒否される。詳細フィールド一覧は [config-schema.md](./config-schema.md) を参照。

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
backoff は [自動 retry (#22)](#自動-retry-22) セクションで定義する。

## 自動 retry (#22)

`serve` daemon の loop の中で、`runOnce` が `failed` を返した Project Item を一定回数まで自動的に
`Failed` → `Todo` に戻して再実行する。Symphony の "daemon workflow" 性に追いつくための機能で、
recovery (#23) とは別軸 (recovery は起動時 1 回、retry は loop 中の連続失敗対応)。

### スコープ

- **対象**: `serve` の通常 loop で `dispatchSelected` が `failed` を返した Item のみ
- **対象外**: recovery (#23) フェーズで失敗した Item は retry-state に積まない (recovery は 1 回限りの起動時
  リカバリで責務が異なるため。失敗した recovery item は人手で再実行)
- **`philharmonic run`** (一過的実行): 自動 retry を適用しない (1 ターン 1 件で exit する仕様を保つ)

### backoff 計算式

Symphony SPEC.md 9.x 準拠の exponential backoff:

```
backoff(attempt) = min(10_000ms × 2^(attempt - 1), max_retry_backoff_ms)
```

- `attempt = 1` (1 回目の retry): 10 秒
- `attempt = 2`: 20 秒
- `attempt = 3`: 40 秒
- `attempt = N`: `min(10s × 2^(N-1), max_retry_backoff_ms)`

`attempt` は 1 始まりで、`runOnce` の初回失敗で `attempt = 1` の retry が schedule される。

### attempt 数と次回実行時刻の永続化

attempt 数は **Project Item の Status とは別に** ローカル JSON ファイルで管理する:

- パス: `<repoRoot>/.philharmonic/retry-state.json` (相対固定。`.philharmonic/` は `.gitignore` 済み)
- スキーマ:

  ```json
  {
    "version": 1,
    "issues": {
      "<issueNumber>": {
        "attempts": <number>,
        "lastFailedAt": "<ISO8601>",
        "nextAttemptAt": "<ISO8601>",
        "lastReason": "<failure reason>"
      }
    }
  }
  ```

- **書き込み**: tmp ファイル (`<path>.tmp`) に書いて `rename` で atomic 置換
- **読み込み**: 不在 / parse 不能 / schema バージョン不一致のいずれも warn ログを 1 行出して空 state にリセットして続行
  (`serve.lock` の stale 判定と同じ哲学。state が消えても最大 N 回再 retry が走るだけで安全側)

選定理由 (Issue #22 Constraints の確定): Issue コメントへの埋め込みや run-log 集計と比較した結果、
`serve.lock` で **既に単一ホスト前提** になっているためホスト跨ぎ追跡は MVP 範囲外であり、
GitHub API 追加呼び出しが不要 / 実装シンプル / 失敗時の挙動が安全側に倒せる、という理由でローカル JSON を採用する。

### Loop への組み込み (`wrappedRunOnce`)

`serve` の各 tick の `runOnce` 呼び出しは CLI レイヤで 3 段階に wrap される:

```
each tick:
  1. promoteRetryReady()  ← retry-state にある & nextAttemptAt 到達済み Item を Failed → Todo に戻す
  2. runOnce()             ← 通常 dispatch (Todo 候補を 1 件処理)
  3. recordFailure / recordSuccess
       - success → retry-state からその issueNumber を削除
       - failed  → attempts++ で再 schedule、上限超過なら state から削除して Failed のまま
```

#### `promoteRetryReady` の動作

1. `pickReady(now)` を呼ぶ。retry-state が空なら **Project metadata fetch を行わずに early return** する
   (= 通常運用での fetch オーバーヘッドはゼロ)
2. 空でなければ `fetchProjectMetadata` + `fetchProjectCandidates` を行い、現在 Status が `Failed` の
   Item に対して `updateProjectV2ItemStatus` で `Todo` option に戻す
3. `Todo` option が project に存在しない場合は **全件 skip + warn ログ** で次 tick に進む
   (`dispatch_statuses` を `Todo` 以外にカスタマイズしている場合の扱いは Open Question)
4. Status update が GraphQL エラーで失敗した場合は warn ログのみ。retry-state は変更しないため次 tick で
   再試行される

#### `recordFailure` / `recordSuccess` の動作

- `recordFailure({ issueNumber, reason, now })`:
  - `retry.max_attempts === 0` なら `disabled` を返し state を変更しない (自動 retry 無効化)
  - `attempts + 1 > max_attempts` なら state から削除して `gave_up` を返す (Failed のまま放置 → 人間判断)
  - それ以外は `attempts++` & `nextAttemptAt = now + backoff(attempts)` を保存して `scheduled` を返す
- `recordSuccess(issueNumber)`: state からエントリを削除する (state に無ければ no-op)

### 戻し先 Status は `Todo` 固定

Issue #22 の Constraints 文言「`Failed` を一定回数まで自動で `Todo` に戻し再実行する」に従い、
retry promote 先は **`Todo` 固定** とする。`dispatch_statuses` を `['Ready for Agent']` 等にカスタマイズして
project に `Todo` option が存在しない場合は全件 skip + warn (上記参照)。`dispatch_statuses` カスタマイズ時の
戻し先 Status については本仕様の Open Question として残す。

### 設定 (philharmonic.yaml)

```yaml
retry:
  max_attempts: 3 # default 3 (0 で自動 retry 無効化)
  max_backoff_ms: 600000 # default 10 分
```

詳細は [config-schema.md](./config-schema.md) の `retry.*` を参照。

### 上限到達時の扱い

- attempts > `max_attempts` で `gave_up` 判定になると、retry-state から該当エントリを削除する
- Status は **`Failed` のまま放置** (Failure 共通処理でセット済み)。Issue 失敗コメントも runOnce 側で投稿済み
- 人間判断で `Failed → Todo` に手動で戻すと、retry-state には載っていないため次回失敗で attempts=1 から再スタート

### 手動介入時の挙動

- 人手で `Failed → Todo` に戻した Item: retry-state は手動戻しを認識しない (= attempts は維持される)。
  次回失敗で attempts++ となり、想定より早く `gave_up` になる可能性がある。これは「手動介入時はユーザが
  `.philharmonic/retry-state.json` から該当 issue のエントリを消すか、success まで走らせる」運用で受容する
- 人手で Item を Project から削除した場合: `promoteRetryReady` が candidate 取得で見つからないと `skip` する

### structured log 追加分

| level | msg                                                                             | fields                                                                     | 説明                                                                          |
| ----- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| info  | `retry scheduled`                                                               | `runId`, `issueNumber`, `attempts`, `backoffMs`, `nextAttemptAt`, `reason` | runOnce が `failed` を返し、attempts <= max_attempts で再 schedule された場合 |
| info  | `retry gave up (max attempts reached)`                                          | `runId`, `issueNumber`, `attempts`, `reason`                               | attempts > max_attempts で give up された場合                                 |
| info  | `retry promoted to Todo`                                                        | `issueNumber`, `attempts`                                                  | Failed → Todo の status flip 成功                                             |
| info  | `retry promote skipped (status no longer Failed)`                               | `issueNumber`, `currentStatus`                                             | 人手で戻された等、現在 Status が Failed でない場合の skip                     |
| info  | `retry promote skipped (candidate not found)`                                   | `issueNumber`                                                              | Project から削除された等で candidate が見つからない場合の skip                |
| warn  | `retry promote 対象の Status option 'Todo' が見つかりません — 全件 skip します` | `availableStatuses`                                                        | project に `Todo` option が無い場合 (この tick の retry 全件 skip)            |
| warn  | `retry promote failed`                                                          | `issueNumber`, `error`                                                     | Status update が GraphQL エラーで失敗 (state は維持して次 tick で再試行)      |
| warn  | `retry promote エラー (次 tick で再試行します)`                                 | `error`                                                                    | `pickReady` / fetch 系で予期せぬ throw (daemon は落とさない)                  |
| warn  | `retry scheduler の更新に失敗 (state ファイル I/O エラー)`                      | `error`                                                                    | `recordFailure` / `recordSuccess` の I/O エラー (daemon は落とさない)         |

### 起動シーケンスへの位置付け

[Hardening 起動シーケンス](#起動シーケンス-hardening-後) との関係:

- retry scheduler の作成は **logger 初期化と同時** に行う (lock 取得後 / signal subscription の前)
- retry-state file の I/O は serveLoop の各 tick (= `wrappedRunOnce` の中) で初めて発生する。
  bootstrap で I/O は行わない (ファイル不在 = 空 state なので問題ない)

## 並列 dispatch (#24)

`serve` daemon の loop の中で、`agent.max_concurrent_agents` 件まで複数 Issue を並列 dispatch する。
1 ホストで Claude Code subprocess を N 並列に走らせて単純にスループットを上げるための機能で、
状態別上限 (`max_concurrent_agents_by_state`) は本仕様の範囲外 (将来検討)。

### スコープ

- **対象**: `serve` の通常 loop (`Recovery` 後の poll tick) のみ
- **対象外**:
  - `philharmonic run` (1 ターン実行) は引き続き 1 件のみ処理する
  - Recovery フェーズ (#23) は 1 件ずつ逐次のまま (起動時 1 回限りの処理で複雑化を避ける)
  - 状態別上限 / queue 永続化 / multi-host 跨ぎ並列

### 動作概要

設定値 `N = agent.max_concurrent_agents` (default 1) として:

```
each tick:
  1. promoteRetryReady()  ← retry-state を Failed → Todo に戻す (#22)
  2. fetchAcceptableCandidates(limit = N)  ← 上から最大 N 件 acceptable な candidate を取る
  3. 各 candidate について並列に:
       a. Status: Todo → In Progress
       b. dispatchSelected() (workspace → prompt → runner → push → PR → In Review)
     ただし同時に走る dispatch 数は最大 N。N + M 件投入時は M 件が wait queue に入り、
     先行 dispatch の slot が空くたび pull される (汎用 worker pool で実装)
  4. 全件完了後 (Promise.allSettled) に retry scheduler を逐次更新
       - success → recordSuccess (state から削除)
       - failed  → recordFailure (attempts++ または gave_up)
  5. 次 tick へ進む (sleep)
```

### 候補取得件数の上限 (1 tick で N 件のみ)

1 tick で acceptable と判定された candidate を **上から最大 N 件** だけ pick して並列 dispatch する。
GraphQL の page 1 (= 100 件) 取得は変わらず、その中から acceptable filter (Issue open / 未 skip ラベル / assignee 一致) を通った先頭 N 件のみが対象。

理由:

- 1 tick の処理時間が `max_dispatch_duration` (= Runner timeout 30 分相当) で頭打ちになり、運用が予測しやすい
- queue は wait queue 関数 (`dispatchPool`) の中で発生するため、Acceptance Criteria は単体テストで担保できる
- `agent.queue_size` を別 config で広げる余地は将来 Open Question として残す

### Slot pool (wait queue 挙動)

実装は汎用ワーカープール `dispatchPool({ tasks, maxConcurrent, worker })`:

- `tasks` を順番に消費する iterator を 1 つ持つ
- `min(maxConcurrent, tasks.length)` 個の slot worker を起動し、各 worker は iterator から次の task を取って await する
- iterator が空になったら worker は終了、残り slot worker の完了を `Promise.all` で待つ
- 結果配列は task の入力順で返す (slot 完了順ではない)

これにより、`tasks.length > maxConcurrent` の場合、超過分 (`tasks.length - maxConcurrent`) は **wait queue** として slot が空くまで待ち、空き次第順次 pull される。

### retry scheduler の race-free 更新

並列 dispatch の結果は `Promise.allSettled` で全件完了させてから、CLI レイヤで **逐次** に
`recordSuccess` / `recordFailure` を呼ぶ。理由は state ファイル (`.philharmonic/retry-state.json`)
の atomic write が「最後勝ち」になるため、並列で書き込みを走らせると 1 回の tick の中で
state エントリが消失するリスクがあるため。

### 各 dispatch の独立性

- 各 dispatch は独立した Promise として走り、相互に状態を汚染しない
- 例外 (BootstrapError 含む) は **その dispatch の中で握って結果配列に `failed` として落とす**。
  他の dispatch は影響を受けず最後まで走る
- worktree / branch / run-id はすべて Issue 番号ごとに分離されているため、衝突しない
  (slot index が変わっても worktree path は変わらない)

### 1 tick が長くなることの注意

1 tick で N 件並列 dispatch すると tick 完了までの時間は最大「Runner timeout × ⌈N/N⌉ = 30 分」。
シャットダウン時の graceful shutdown は in-flight な N 個の dispatch がすべて完走するまで待つ。
SIGTERM の二重受信時は既存の `shutdown signal ignored` 挙動と同じ。

### 設定 (philharmonic.yaml)

```yaml
agent:
  max_concurrent_agents: 1 # default 1 (MVP 互換)
```

詳細は [config-schema.md](./config-schema.md) の `agent.max_concurrent_agents` を参照。
0 / 負数 / 非整数は zod validation error。

### structured log 追加分

`agent.max_concurrent_agents > 1` の dispatch 結果ログには `slot` (0..N-1) を必ず含める。
slot は「どの worker slot で処理されたか」を表す並列インデックス。`runId` も既存どおり付く。

| level | msg                                             | fields                                               | 説明                                                                              |
| ----- | ----------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| info  | `concurrent tick`                               | `maxConcurrent`, `dispatched`                        | 1 tick で N 件 dispatch を開始した時点の info                                     |
| info  | `dispatch success`                              | `slot`, `runId`, `issueNumber`, `prNumber`, `branch` | 並列 dispatch 1 件成功                                                            |
| warn  | `dispatch failed`                               | `slot`, `runId`, `issueNumber`, `reason`             | 並列 dispatch 1 件失敗 (`markFailed` 済み)                                        |
| warn  | `dispatch error`                                | `slot`, `issueNumber`, `error`                       | 並列 dispatch 内で `dispatchSelected` が想定外 throw した場合 (failed として記録) |
| warn  | `concurrent dispatch status_transition skipped` | `issueNumber`, `error`                               | Todo→In Progress の Status update が失敗し当該 Issue を skip した場合             |

`max_concurrent_agents == 1` のとき (互換挙動) は `slot` を含めず従来どおりのログ形式を維持する。

### Open Question

- 1 tick で fetch する acceptable candidate の上限を `N + agent.queue_size` 等で拡張するか
  (queue 挙動を実プロダクトでも観察したい場合)
- 状態別上限 (`max_concurrent_agents_by_state`) の導入可否
- `serve.lock` は 1 ホスト前提のままだが、N 並列 dispatch で外部 API rate limit や git worktree
  IO 競合を実測してから上げる
- SIGTERM 受信時に in-flight の N 件すべてを待つと shutdown が遅くなる問題への対策
  (`--force-shutdown` 等)

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

- in-flight run を SIGTERM で強制中断するモード (`--force-shutdown` 等) の導入可否
- jitter による thundering herd 回避の必要性 (単一プロセスでは不要だが multi-process 化で必要になる)
- Linux 以外 (Windows) での SIGTERM/SIGINT 挙動差 (本 MVP では Linux/macOS 前提)
- retry の戻し先 Status: `dispatch_statuses` カスタマイズ時 (`Ready for Agent` 等で `Todo` が無い project) の挙動
  (現状: 全件 skip + warn。`dispatch_statuses[0]` を戻し先にする案あり)
- retry の reason 別ポリシー: 現状は `workspace_provisioning` / `runner_error` / `timeout` / `no_changes` /
  `push` / `pr_create` のいずれも一律で retry。reason ごとに上限値を変えるか、特定 reason は retry しない、等の検討余地

## MVP でやらないこと

- 状態別上限 (`max_concurrent_agents_by_state`)
- 並列 dispatch の wait queue を 1 tick 内で実プロダクトでも発生させる (現状は dispatchPool 単体テストで queue 挙動を担保)
- 自動 recovery (#23 で別途実装済み)
- in-flight run の強制中断
- HTTP ヘルスチェックエンドポイント
- systemd / launchd 用 unit ファイル同梱
- retry の jitter (multi-process 化したら必要だが、単一プロセスでは不要)
- retry attempt 数のホスト跨ぎ追跡 (lock 同様、単一ホスト前提)
