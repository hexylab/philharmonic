# Snapshot HTTP API — `philharmonic serve`

## 概要

`philharmonic serve` daemon に read-only な HTTP API を追加し、稼働中の状態 (in-flight runs / 自動 retry 待ち / 累計トークンコスト等) を JSON で外部から参照できるようにする。Symphony の "Snapshot API" に相当する機能で、dashboard (#31) や外部 health-check の前提となる。

## 関連

- 関連 Issue: #30 (Refs: #21, #28), #62 (`retrying` セクション撤廃), #31 (TUI dashboard が本 API を購読する), #84 (`retry_queue` セクション追加 / ADR-0008)
- 設計判断: [ADR-0004 Snapshot HTTP API は Node 標準 http で loopback 固定で公開する](../adr/0004-snapshot-http-api.md), [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md), [ADR-0006 TUI dashboard は Ink で実装する](../adr/0006-tui-dashboard.md), [ADR-0008 in-memory retry queue](../adr/0008-in-memory-retry-queue.md)
- 関連 spec: [serve-daemon.md](./serve-daemon.md), [dashboard.md](./dashboard.md), [config-schema.md](./config-schema.md), [observability.md](./observability.md), [orchestration-mvp.md](./orchestration-mvp.md)

## 要件

- `philharmonic serve` の bootstrap 経路で **`config.server.port` が指定されているときだけ** API server を起動する
- 未指定なら server は起動しない (snapshot 機能を無効化できる)
- bind は **`127.0.0.1` 固定**。`server.host` キーは出さない (loopback 限定 / 認証は ADR-0004 の今後の課題)
- 公開エンドポイントは 3 つだけ:
  - `GET  /api/v1/state` — 全体 snapshot
  - `GET  /api/v1/<issue_number>` — 指定 Issue の snapshot
  - `POST /api/v1/refresh` — 次 tick の sleep を起こす (in-flight 中は no-op)
- 認証なし (ADR-0004 で確定)
- すべてのリクエストで `api request` (info) ログを 1 行残す ([構造化ロガー (#28)](./observability.md) 経由)
- shutdown シーケンス (SIGTERM / SIGINT / serveLoop の例外) で必ず HTTP server を close する

## 非機能要件

- **性能**: 1 リクエストあたり in-memory tracker の参照 + retry-state ファイル 1 read のみ。GitHub API 呼び出しは行わない
- **可用性**: server 起動失敗 (port 衝突等) は exit 1。daemon は API なしでは起動させない (運用者が気付ける)
- **セキュリティ**: loopback 固定 / 認証なし。LAN 越しに叩きたい場合は SSH トンネル (`ssh -L 4000:127.0.0.1:4000`) を使う運用とする
- **アクセシビリティ**: 該当しない (機械可読 API)

## データモデル

### in-memory `RunTracker`

`philharmonic serve` プロセス起動時に 1 つ生成する。**daemon プロセス起動以降の累計のみ** を保持し、再起動で消える。

```ts
type RunningEntry = {
  runId: string;
  issueNumber: number;
  branch: string;
  startedAt: string; // ISO 8601
  slot: number | null; // 並列 dispatch (#24) 時のみ非 null
};

type Totals = {
  runsCompleted: number;
  runsSucceeded: number;
  runsFailed: number;
  totalCostUsd: number;
};
```

各 dispatch (`dispatchSelected`) は開始時に `tracker.runStarted(...)` を、終了時 (success / failure / 想定外 throw) に `tracker.runFinished(...)` を呼ぶ。`runFinished` は **runId が running set に居なければ no-op** (べき等)。

### `RetryStateEntry` の撤廃 (ADR-0005) と `retry_queue` の追加 (ADR-0008)

旧仕様 (#22) では `.philharmonic/retry-state.json` を読んで `retrying` 配列を返していたが、ADR-0005 で永続 retry 機能ごと撤廃された。本 API では `retrying` 配列を返さない / 出さない。Issue 別 endpoint (`/api/v1/<issue>`) でも `retrying` フィールドは常に省略される。

ADR-0008 で **in-memory な retry queue** を別機構として導入し、`/api/v1/state` のレスポンスに `retry_queue` field を追加する。永続ファイルではなく daemon プロセス内の `RetryQueue` インスタンスをそのまま読むだけで、追加 GitHub API call は発生しない。`agent.max_retry_attempts == 0` のときと queue 未注入のときは `retry_queue: null` を返す。`/api/v1/<issue>` では引き続き retry 状態を露出しない (in-flight でない Issue は 404)。

### `WakeController`

`/api/v1/refresh` 用。serveLoop の sleep に渡す AbortSignal を 1 つ提供し、`wake()` で abort する。abort 後は新しい AbortController に差し替える (次 tick の sleep には fresh な signal を渡せる)。

### in-memory `DependencyTracker` (ADR-0007)

ADR-0007 の DAG-aware scheduler が、各 tick の candidate 評価結果を保持する in-memory tracker。`philharmonic serve` プロセス起動時に 1 つ生成し、daemon の lifetime と一致する (再起動で消える)。

```ts
type SchedulerSnapshot = {
  lastEvaluatedAt: string; // ISO 8601
  ready: ReadonlyArray<{ issueNumber: number; title: string }>;
  blocked: ReadonlyArray<{
    issueNumber: number;
    title: string;
    blockedBy: readonly number[];
  }>;
  cycles: ReadonlyArray<{ issueNumbers: readonly number[] }>;
  invalidDependencies: ReadonlyArray<{
    issueNumber: number;
    title: string;
    entries: ReadonlyArray<{
      raw: string;
      issueNumber: number | null;
      reason: 'parse_invalid' | 'not_found' | 'forbidden' | 'fetch_error';
      message?: string;
    }>;
  }>;
};
```

- candidate selection (`selectAcceptableCandidates`) が `evaluateDependencyDag` を呼んだ直後に **per-tick で 1 度だけ** `recordEvaluation` でまるごと差し替える。per-candidate に append しない (古い tick の評価が残らないようにするため)
- `cycles[]` は同じ SCC が複数 candidate から重複しないように、SCC member の sorted set で dedup する
- 配列は `evaluateDependencyDag` の入力順 (= board 順 = ready 優先順位) を保持する。`cycles[]` だけは dedup の都合で sorted SCC member 順

`getSnapshot()` は `recordEvaluation` が 1 度も呼ばれていなければ `null` を返す (= API は `scheduler: null` を返し、TUI 側で「まだ評価していない」と表示する)。recovery 経路では candidate selection を通らないため、recovery のみで poll tick が来ていない瞬間は `null` のままになる。

## API / インターフェース

### `GET /api/v1/state`

全体 snapshot を返す。

**レスポンス (200 OK, `application/json`)**:

```json
{
  "started_at": "2026-05-09T00:00:00.000Z",
  "uptime_ms": 60000,
  "polling": {
    "interval_ms": 30000,
    "last_tick_at": "2026-05-09T00:00:30.000Z"
  },
  "running": [
    {
      "run_id": "0190ce80-...",
      "issue_number": 42,
      "branch": "feature/42-foo",
      "started_at": "2026-05-09T00:00:10.000Z",
      "slot": 0
    }
  ],
  "totals": {
    "runs_completed": 12,
    "runs_succeeded": 10,
    "runs_failed": 2,
    "total_cost_usd": 4.32
  },
  "scheduler": {
    "last_evaluated_at": "2026-05-09T00:00:30.000Z",
    "ready": [
      { "issue_number": 104, "title": "Add foo handler" },
      { "issue_number": 105, "title": "Wire bar adapter" }
    ],
    "blocked": [{ "issue_number": 102, "title": "Switch to async API", "blocked_by": [101] }],
    "cycles": [{ "issue_numbers": [201, 202] }],
    "invalid_dependencies": [
      {
        "issue_number": 103,
        "title": "Migrate legacy endpoint",
        "entries": [{ "raw": "owner/repo#123", "issue_number": null, "reason": "parse_invalid" }]
      }
    ]
  },
  "retry_queue": {
    "size": 1,
    "max_attempts": 5,
    "max_backoff_ms": 300000,
    "entries": [
      {
        "issue_number": 42,
        "attempt": 2,
        "due_at": "2026-05-09T00:00:50.000Z",
        "scheduled_at": "2026-05-09T00:00:30.000Z",
        "failure_reason": "runner_error",
        "last_run_id": "0190ce80-0000-7000-8000-000000000001",
        "last_error_summary": "claude exited with code 1: ..."
      }
    ]
  }
}
```

| フィールド               | 型               | 説明                                                                                           |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------- |
| `started_at`             | ISO 8601         | daemon の起動時刻 (= tracker 生成時刻)                                                         |
| `uptime_ms`              | integer          | daemon が稼働している時間 (ms)                                                                 |
| `polling.interval_ms`    | integer          | `config.polling.interval_ms`                                                                   |
| `polling.last_tick_at`   | ISO 8601 \| null | 最終 poll tick の時刻。1 回も tick していなければ null                                         |
| `running`                | array            | 現在進行中の dispatch (issue number 昇順)                                                      |
| `running[].run_id`       | UUIDv7           | `dispatchSelected` で生成した run id                                                           |
| `running[].issue_number` | integer          | Issue 番号                                                                                     |
| `running[].branch`       | string           | feature ブランチ名                                                                             |
| `running[].started_at`   | ISO 8601         | `dispatchSelected` の開始時刻                                                                  |
| `running[].slot`         | integer \| null  | 並列 dispatch (#24) の slot index。`max_concurrent_agents == 1` の互換動作なら null            |
| `totals.runs_completed`  | integer          | daemon プロセス起動以降に完了 (success+failed) した run 数                                     |
| `totals.runs_succeeded`  | integer          | 成功した run 数                                                                                |
| `totals.runs_failed`     | integer          | 失敗した run 数                                                                                |
| `totals.total_cost_usd`  | number           | runner からの `total_cost_usd` の総和 (null は 0 として扱う)                                   |
| `scheduler`              | object \| null   | DAG-aware scheduler の最新 evaluation (詳細は次節)。1 度も評価していなければ null              |
| `retry_queue`            | object \| null   | In-memory retry queue (ADR-0008)。`agent.max_retry_attempts == 0` または queue 未注入なら null |

`retrying` 配列 (旧 #22) は ADR-0005 で撤廃。`retry_queue` (ADR-0008) は別機構として再導入された (永続化しない / Status 駆動でない)。

PR 番号 (`pr_number`) は orchestrator が知れなくなったため `running` entry にも含めない。

#### `retry_queue` フィールド (ADR-0008)

`philharmonic serve` daemon プロセス内の retry queue をスナップショットする。永続ファイルは読まない。`agent.max_retry_attempts == 0` で機能 off のときは `null` を返す。

| フィールド                     | 型             | 説明                                                                                         |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------- |
| `retry_queue.size`             | integer        | 現在 queue に積まれている entry 件数                                                         |
| `retry_queue.max_attempts`     | integer        | `agent.max_retry_attempts` の現値                                                            |
| `retry_queue.max_backoff_ms`   | integer        | `agent.max_retry_backoff_ms` の現値                                                          |
| `retry_queue.entries[]`        | array          | dueAt 昇順、同時刻なら issue_number 昇順                                                     |
| `entries[].issue_number`       | integer        | Issue 番号                                                                                   |
| `entries[].attempt`            | integer        | 1-indexed retry 試行番号 (= 次に走る attempt)                                                |
| `entries[].due_at`             | ISO 8601       | この entry が次に dispatch されうる予定時刻                                                  |
| `entries[].scheduled_at`       | ISO 8601       | この entry が積まれた / 上書きされた時刻                                                     |
| `entries[].failure_reason`     | string         | `workspace_provisioning` / `runner_error` / `timeout` / `stalled` / `hook_failed` のいずれか |
| `entries[].last_run_id`        | string         | 直近失敗した run id                                                                          |
| `entries[].last_error_summary` | string \| null | 失敗エラーメッセージ先頭最大 500 文字。詳細は run-log の `summary.md` 参照                   |

#### `scheduler` フィールド (ADR-0007)

candidate selection の dependency filter (`evaluateDependencyDag`) が直近 tick で出力した結果のサマリ。`philharmonic serve` は **request ごとに GitHub API を叩かない**。tracker に保持された最新 evaluation をそのまま返すだけ。

| フィールド                                      | 型              | 説明                                                                      |
| ----------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| `last_evaluated_at`                             | ISO 8601        | 最後に candidate selection が走った時刻                                   |
| `ready[]`                                       | array           | dispatch 可能な candidate (board 順)                                      |
| `ready[].issue_number`                          | integer         | Issue 番号                                                                |
| `ready[].title`                                 | string          | Issue タイトル                                                            |
| `blocked[]`                                     | array           | 1 件以上の依存先が open のため dispatch されなかった candidate (board 順) |
| `blocked[].issue_number`                        | integer         | Issue 番号                                                                |
| `blocked[].title`                               | string          | Issue タイトル                                                            |
| `blocked[].blocked_by`                          | array<integer>  | 開いている依存先 Issue 番号 (`Depends-On:` の出現順、重複なし)            |
| `cycles[]`                                      | array           | 依存グラフに循環がある candidate が属する SCC (重複は dedup)              |
| `cycles[].issue_numbers`                        | array<integer>  | SCC のメンバ (issue_number 昇順)                                          |
| `invalid_dependencies[]`                        | array           | parse 不能 / 取得失敗な依存先を持つ candidate                             |
| `invalid_dependencies[].issue_number`           | integer         | candidate 自身の Issue 番号                                               |
| `invalid_dependencies[].title`                  | string          | candidate 自身のタイトル                                                  |
| `invalid_dependencies[].entries[]`              | array           | 1 件以上の invalid 依存先詳細                                             |
| `invalid_dependencies[].entries[].raw`          | string          | 元の文字列。parse 失敗時は entry の原文、fetch 失敗時は `#<number>`       |
| `invalid_dependencies[].entries[].issue_number` | integer \| null | parse 成功した Issue 番号 (parse-invalid のときのみ null)                 |
| `invalid_dependencies[].entries[].reason`       | string          | `parse_invalid` / `not_found` / `forbidden` / `fetch_error`               |
| `invalid_dependencies[].entries[].message`      | string          | `fetch_error` のときのみ含まれる元例外文言                                |

**precedence**: 1 candidate は最大 1 つの section にしか出ない。`cycle` > `invalid_dependency` > `blocked` > `ready` の順で分類される (ADR-0007 §2 と同じ)。`ready` candidate であっても `running` (dispatch 中) なら top-level `running` 配列に既に出るため、scheduler に出すかどうかは「直近 tick の dependency 評価結果」基準で判定する (= dispatch 中 candidate は `ready` から除かれていない可能性がある — `ready` は「dependency 上 dispatch 可能だった」事実を表す)。

**サイズ制約**: candidate 1 件あたり `issue_number + title (+ blocked_by/entries)` のみ。Issue body や label 一覧は含めない (Snapshot 全体の payload を抑える)。

**初期状態**: `philharmonic serve` 起動直後で、まだ poll tick が 1 度も走っていない (= recovery のみ走った瞬間も含む) なら `scheduler: null`。古い (本フィールドを実装していない) serve に対して TUI が安全に fall back できるよう、フィールド自体を欠落させる代わりに **null を明示的に返す**。

**累計の集計範囲**: 「daemon プロセス起動以降」のみを保証する。再起動を跨いだ全期間累計は本 API の範囲外 (詳細: ADR-0004 「daemon-lifetime の in-memory tracker を新設する」)。

### `GET /api/v1/<issue_number>`

`<issue_number>` は **正の整数のみ受理する**。

**レスポンス (200 OK)**:

```json
{
  "issue_number": 42,
  "running": { ... } | null
}
```

`running` のフィールド構造は `/api/v1/state` の各要素と同じ。

| 状況                                    | レスポンス                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| 該当 Issue が in-flight                 | `running` に entry                                                                         |
| 該当 Issue が in-flight でない          | **404 Not Found** + `{"error":"not_found","issue_number":N}`                               |
| `<issue_number>` が `0` / 負数 / 非整数 | **400 Bad Request** + `{"error":"invalid_issue_number"}` (regex 不一致は 404 fall-through) |

`retrying` フィールドは ADR-0005 で撤廃された。

理由: project に存在する全 Issue 一覧を返すには Project metadata fetch が必要 (= rate limit を消費する)。本 API は read-only / 軽量を主眼としており、in-memory にあるものだけを返すのが合理的。

### `POST /api/v1/refresh`

次 tick の sleep を起こす。in-flight (= sleep 中ではなく dispatch 実行中) なら何もしない。

**レスポンス (202 Accepted)**:

```json
{ "woken": true }
```

| `woken` | 意味                                                                     |
| ------- | ------------------------------------------------------------------------ |
| `true`  | sleep 中の wake signal を実際に abort した                               |
| `false` | acquire 前 (= dispatch 実行中) または既に abort 済みのため何もしなかった |

副作用は wake のみ。実 dispatch は serveLoop に任せる (= API 側が GitHub に直接叩きに行かない)。

### Method Not Allowed

| Path                     | 許可 method | 不一致時のレスポンス                     |
| ------------------------ | ----------- | ---------------------------------------- |
| `/api/v1/state`          | `GET`       | `405 Method Not Allowed` + `Allow: GET`  |
| `/api/v1/<issue_number>` | `GET`       | `405 Method Not Allowed` + `Allow: GET`  |
| `/api/v1/refresh`        | `POST`      | `405 Method Not Allowed` + `Allow: POST` |

その他のパスは `404 Not Found` + `{"error":"not_found"}`。

### 構造化ログ

| level | msg                         | fields                                              | 説明                      |
| ----- | --------------------------- | --------------------------------------------------- | ------------------------- |
| info  | `snapshot api started`      | `host`, `port`                                      | API server 起動時 1 回    |
| info  | `api request`               | `method`, `path`, `status`, `duration_ms`, `remote` | 全リクエストで 1 行       |
| warn  | `api request error`         | `method`, `path`, `error`, `remote`                 | handler が throw したとき |
| warn  | `snapshot api close に失敗` | `error`                                             | shutdown 時の close 失敗  |

### 起動シーケンス (Hardening 後との関係)

[serve-daemon.md#起動シーケンス-hardening-後](./serve-daemon.md#起動シーケンス-hardening-後) との関係:

1. token 解決 / config 読み込み / bypass guard / lock 取得 (既存)
2. logger 初期化 (既存)
3. **runTracker / wakeController を生成** (新規)
4. **`config.server` が非 null なら snapshot api server を起動** (新規)
   - 失敗時は lock を release してから exit 1
5. workflowSource (既存)
6. signal subscription / Recovery / serveLoop (既存)
7. (loop 終了) `subscription.dispose()` → **`apiServer.close()`** → `workflowSource.close()` → `lock.release()`

## エラーハンドリング

| エラー                                 | 発生条件         | 扱い方針                                                        |
| -------------------------------------- | ---------------- | --------------------------------------------------------------- |
| `EADDRINUSE` 等で API server 起動失敗  | bootstrap 段階   | stderr に出して lock release → exit 1 (daemon 自体を起動しない) |
| handler 内で例外                       | リクエスト処理中 | `500 Internal Server Error` + `warn` ログ。daemon は落とさない  |
| `getIssue` が両方 null                 | リクエスト時     | `404 Not Found` + `{"error":"not_found","issue_number":N}`      |
| `<issue_number>` が `0` 等の不正な整数 | リクエスト時     | `400 Bad Request` + `{"error":"invalid_issue_number"}`          |
| 未知 path                              | リクエスト時     | `404 Not Found`                                                 |
| 不一致 method                          | リクエスト時     | `405 Method Not Allowed` + `Allow: <method>` ヘッダ             |
| `apiServer.close()` の失敗             | shutdown 時      | `warn` ログのみ。lock release は続行                            |

## 外部依存

- Node.js 標準 `http` モジュール (フレームワーク追加なし — ADR-0004)
- 既存 `RetryScheduler` の `listEntries` / `getEntry` (本 Issue で追加)
- 既存 `serveLoop` (`acquireWakeSignal` / `onPollTick` を本 Issue で追加)
- 既存 `evaluateDependencyDag` (ADR-0007 split 2) — DependencyTracker は candidate selection 経由でその出力を保持するだけ

## オープンクエスチョン

- 認証 (token / unix socket / GitHub Apps) を入れる際の host バインド戦略 → ADR で別途検討
- 全期間累計 (再起動を跨ぐ) を返す API の追加 → 本 Issue の範囲外。`runlog/` 全件走査 or sqlite 化が必要になるため別 ADR で扱う
- `/api/v1/issues` (project にある全 candidate を一括で返す) の追加 → Project fetch 1 回分のレート消費を伴うため、本 Issue では入れない
- request body が必要な PUT / PATCH (例: 強制 retry / pause) → 認証導入後の別 Issue
