# Snapshot HTTP API — `philharmonic serve`

## 概要

`philharmonic serve` daemon に read-only な HTTP API を追加し、稼働中の状態 (in-flight runs / 自動 retry 待ち / 累計トークンコスト等) を JSON で外部から参照できるようにする。Symphony の "Snapshot API" に相当する機能で、dashboard (#31) や外部 health-check の前提となる。

## 関連

- 関連 Issue: #30 (Refs: #21, #28), #62 (`retrying` セクション撤廃)
- 設計判断: [ADR-0004 Snapshot HTTP API は Node 標準 http で loopback 固定で公開する](../adr/0004-snapshot-http-api.md), [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md)
- 関連 spec: [serve-daemon.md](./serve-daemon.md), [config-schema.md](./config-schema.md), [observability.md](./observability.md), [orchestration-mvp.md](./orchestration-mvp.md)

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

### `RetryStateEntry` の撤廃 (ADR-0005)

旧仕様 (#22) では `.philharmonic/retry-state.json` を読んで `retrying` 配列を返していたが、ADR-0005 で自動 retry 機能ごと撤廃された。本 API では `retrying` 配列を返さない / 出さない。Issue 別 endpoint (`/api/v1/<issue>`) でも `retrying` フィールドは常に省略される。

### `WakeController`

`/api/v1/refresh` 用。serveLoop の sleep に渡す AbortSignal を 1 つ提供し、`wake()` で abort する。abort 後は新しい AbortController に差し替える (次 tick の sleep には fresh な signal を渡せる)。

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
  }
}
```

| フィールド               | 型               | 説明                                                                                |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| `started_at`             | ISO 8601         | daemon の起動時刻 (= tracker 生成時刻)                                              |
| `uptime_ms`              | integer          | daemon が稼働している時間 (ms)                                                      |
| `polling.interval_ms`    | integer          | `config.polling.interval_ms`                                                        |
| `polling.last_tick_at`   | ISO 8601 \| null | 最終 poll tick の時刻。1 回も tick していなければ null                              |
| `running`                | array            | 現在進行中の dispatch (issue number 昇順)                                           |
| `running[].run_id`       | UUIDv7           | `dispatchSelected` で生成した run id                                                |
| `running[].issue_number` | integer          | Issue 番号                                                                          |
| `running[].branch`       | string           | feature ブランチ名                                                                  |
| `running[].started_at`   | ISO 8601         | `dispatchSelected` の開始時刻                                                       |
| `running[].slot`         | integer \| null  | 並列 dispatch (#24) の slot index。`max_concurrent_agents == 1` の互換動作なら null |
| `totals.runs_completed`  | integer          | daemon プロセス起動以降に完了 (success+failed) した run 数                          |
| `totals.runs_succeeded`  | integer          | 成功した run 数                                                                     |
| `totals.runs_failed`     | integer          | 失敗した run 数                                                                     |
| `totals.total_cost_usd`  | number           | runner からの `total_cost_usd` の総和 (null は 0 として扱う)                        |

`retrying` 配列は ADR-0005 で撤廃。PR 番号 (`pr_number`) は orchestrator が知れなくなったため `running` entry にも含めない。

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

## オープンクエスチョン

- 認証 (token / unix socket / GitHub Apps) を入れる際の host バインド戦略 → ADR で別途検討
- 全期間累計 (再起動を跨ぐ) を返す API の追加 → 本 Issue の範囲外。`runlog/` 全件走査 or sqlite 化が必要になるため別 ADR で扱う
- `/api/v1/issues` (project にある全 candidate を一括で返す) の追加 → Project fetch 1 回分のレート消費を伴うため、本 Issue では入れない
- request body が必要な PUT / PATCH (例: 強制 retry / pause) → 認証導入後の別 Issue
