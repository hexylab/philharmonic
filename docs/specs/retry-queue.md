# Retry Queue — `philharmonic serve` の自動再 dispatch

## 概要

`philharmonic serve` daemon の **in-memory retry queue** の仕様。`workspace_provisioning` / `runner_error` / `timeout` / `stalled` / `hook_failed` のいずれかで失敗した dispatch を、Symphony と同じ指数バックオフ (`10s * 2^(attempt-1)` を `agent.max_retry_backoff_ms` で clamp) で自動的に再 dispatch する。永続化は **しない** (daemon プロセスを跨いだ retry は recovery が引き受ける)。

## 関連 Issue

- Issue #84 — 失敗・stalled run を指数バックオフで自動リトライする
- ADR: [ADR-0008 失敗 / stalled run を指数バックオフで再 dispatch する in-memory retry queue を導入する](../adr/0008-in-memory-retry-queue.md)
- 関連 spec: [serve-daemon.md](./serve-daemon.md), [orchestration-mvp.md](./orchestration-mvp.md), [snapshot-api.md](./snapshot-api.md), [config-schema.md](./config-schema.md)
- 関連 ADR: [ADR-0005 §7 worktree cleanup の trigger 簡素化](../adr/0005-thin-orchestrator-agent-delegation.md), [ADR-0005 §8 retry-state は撤廃](../adr/0005-thin-orchestrator-agent-delegation.md)

## 用語

| 用語            | 意味                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **retry queue** | daemon プロセス内に 1 つ存在する in-memory な待機列。`Map<issueNumber, RetryEntry>` で実装する |
| **retry entry** | 1 件の retry 情報。issueNumber / attempt / dueAt / failureReason / branch / workspacePath ほか |
| **attempt**     | retry の試行番号 (1-indexed)。初回 dispatch は attempt 0 扱いで queue に積まれない             |
| **drain**       | `dueAt <= now` を満たす entry を queue から pop すること                                       |
| **schedule**    | dispatch 失敗を受けて retry entry を queue に enqueue する操作                                 |
| **exhausted**   | `attempt > max_retry_attempts` で queue から落とす状態                                         |

## 要件

- `agent.max_retry_attempts >= 1` のとき、retry-eligible failure (本 spec [対象 failure](#対象-failure-failurereason)) を受けて自動的に retry queue に積む
- `agent.max_retry_attempts == 0` のとき、retry queue は **常に空** (機能 off)
- backoff は `min(10_000 * 2^(attempt - 1), max_retry_backoff_ms)` で計算 (ms 単位)
- retry の dispatch は **次の poll tick 以降の `dueAt <= now`** を満たす最初の tick で発火する。同 tick 内の即時 sleep は行わない
- 各 retry の dispatch 直前に **`getIssue` と `fetchProjectCandidates` を再取得** し、Issue / Project Status が active でないなら drop する (詳細: [Status 再取得](#status-再取得))
- retry の dispatch は `agent.max_concurrent_agents` の slot を **最優先で消費** する。残り slot 件数だけ通常 candidate selection を呼ぶ
- 同一 Issue が retry queue に **同時に複数 entry 存在しない** (Map で `issueNumber` キーで dedup する)
- retry 中の Issue が `runTracker.getRunningByIssue !== null` のとき、その entry は dispatch せずに **同じ attempt のまま `dueAt` を `now + 10s` に再 schedule** (重複 dispatch を防ぐ)
- recovery 経路 (`recoverInProgress`) で `dispatchSelected` が failed を返した場合も、同じ規則で retry queue に積む (queue が DI で渡されているとき)
- `philharmonic run` (1 ターン CLI) は retry queue を持たない (queue を渡さなければ動作変更なし)

## 非機能要件

- **性能**: 1 retry あたり追加 GitHub API call は `getIssue` 1 回 + `fetchProjectCandidates` 1 回 (= candidate 取得 1 回) のみ。Project items 取得は通常 tick と共有可能だが、本 spec の最小実装では retry ごとに 1 回の overhead を許容する (rate limit 設計は将来要件)
- **可用性**: queue は in-memory のみ。daemon 再起動で消える。失われた retry は次回 `serve` 起動の recovery で拾う (Status `In Progress` の Item を引き取る既存経路)
- **セキュリティ**: 永続ファイルを増やさない (`.philharmonic/retry-state.json` 等は作らない)。GitHub token は通常の dispatch 経路と同じく env allowlist で透過させる
- **アクセシビリティ**: 該当しない (機械可読 API + 構造化ログ)

## データモデル

### `RetryEntry` (in-memory)

```ts
type RetryEntry = {
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  attempt: number; // 1-indexed retry attempt
  dueAt: Date; // ISO 8601 ms 精度
  scheduledAt: Date;
  failureReason: FailureReason;
  lastRunId: string;
  lastErrorSummary: string | null;
};
```

`FailureReason` は `src/orchestrator/errors.ts` の type ([対象 failure](#対象-failure-failurereason) と同じ列挙)。`lastErrorSummary` は `markFailed` が `describeError(error)` または `RunResult.rawStderrTail` から組み立てた `errorSummary` (先頭最大 500 文字) を `RunOnceResult.failed.errorSummary` 経由で受け取る。`runConcurrent` の dispatch worker が想定外 throw した場合は catch 句で同様に `describeError(error)` から作る。

### 対象 failure (`failureReason`)

`dispatchSelected` の戻り値が `failed` で、以下のいずれかなら retry queue に積む。

- `workspace_provisioning`
- `runner_error`
- `timeout`
- `stalled`
- `hook_failed`

これは現行 `FailureReason` の **全件** ([orchestration-mvp.md エラーハンドリング表](./orchestration-mvp.md#エラーハンドリング)) と一致する。区別を入れない理由は ADR-0008 §1 を参照。

### `RetryQueue` (純粋データ構造)

```ts
type RetryQueue = {
  /** 既存 entry があれば差し替える (同一 issueNumber は 1 件だけ) */
  schedule(input: ScheduleInput): RetryEntry;
  /** dueAt <= now の entry を取り出して queue から消す。残りは保持 */
  drainDue(now: Date): RetryEntry[];
  /** 任意 issue を queue から落とす (success 時 / exhausted 時に呼ぶ) */
  remove(issueNumber: number): boolean;
  /** dispatch 直前の重複防止用: tracker_in_flight だった entry を 10s 後に積み直す */
  reschedule(input: RescheduleInput): RetryEntry;
  /** Snapshot API 用。dueAt 昇順 */
  list(): readonly RetryEntry[];
  /** 件数 */
  size(): number;
};

type ScheduleInput = {
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  attempt: number; // schedule する attempt 番号 (1-indexed)
  failureReason: FailureReason;
  lastRunId: string;
  lastErrorSummary: string | null;
  now: Date;
  maxBackoffMs: number;
};

type RescheduleInput = {
  issueNumber: number;
  delayMs: number;
  now: Date;
};
```

`computeRetryDelayMs(attempt, maxBackoffMs)` を `src/orchestrator/retry-queue.ts` の export として提供する (テストと外部観測の両方で再利用するため)。

```ts
function computeRetryDelayMs(attempt: number, maxBackoffMs: number): number {
  const base = 10_000 * Math.pow(2, attempt - 1);
  return Math.min(base, maxBackoffMs);
}
```

`attempt < 1` は呼び出し側のバグ。defensive に `attempt = 1` として扱う (実装上は `Math.max(1, attempt)` で clamp)。

## API / インターフェース

### `runOnce` / `runConcurrent` (改訂)

`RunOnceDeps` / `RunConcurrentDeps` に以下を追加する。

```ts
type RunOnceDeps = {
  // 既存フィールド省略
  retryQueue?: RetryQueue;
  /** retry 上限 (= max_retry_attempts)。0 で retry 無効 */
  maxRetryAttempts?: number;
  /** retry backoff の clamp 上限 (ms) */
  maxRetryBackoffMs?: number;
};
```

省略時 (= `philharmonic run` のように queue を渡さないケース) は **retry 機能なし** として動く (既存挙動互換)。

### Tick の流れ (改訂後)

```
each tick:
  1. retry queue から drainDue(now) で due な entry を pop
  2. 各 entry について:
     2.1 runTracker.getRunningByIssue(issueNumber) !== null → reschedule(10s 後), drop from this tick
     2.2 getIssue で再取得 → state === 'closed' なら remove(), `retry skipped reason=closed` info ログ
     2.3 fetchProjectCandidates で再取得 → status が "active 範囲" 外なら remove(), `retry skipped reason=terminal_status / inactive_status` info ログ
         active 範囲 = dispatch_statuses ∪ {status_transitions.in_progress}
     2.4 上記合格なら retry task に積む
  3. retry tasks の件数 M。fresh slots = max(0, max_concurrent_agents - M)
  4. fresh_slots > 0 なら通常 candidate selection を呼ぶ (fresh tasks; 既存挙動)
  5. retry tasks + fresh tasks (合計 ≤ max_concurrent_agents) を dispatchPool に投入
     5.1 retry task の場合: dispatchSelected を呼ぶ前に cleanupWorkspace で worktree を force reset
     5.2 dispatchSelected を呼ぶ
  6. 各 dispatch 結果を集計:
     6.1 success → retryQueue.remove(issueNumber)
     6.2 failed (retry-eligible) かつ attempt + 1 <= max_retry_attempts → schedule(attempt + 1)
     6.3 failed (retry-eligible) かつ attempt + 1 > max_retry_attempts → remove() + `retry exhausted` warn
  7. sleep
```

retry entry の `attempt` は **その entry が現在保持している試行番号** (= 直前に失敗した attempt)。tick 内で再 dispatch するときの「次回 attempt」は `attempt + 1`、ただし「初回失敗 → 初 schedule」のときは attempt=1 で schedule する (attempt 0 は queue に積まない)。

具体的な遷移:

```
初回 dispatch (attempt 0) 失敗
  → schedule(attempt = 1, dueAt = now + 10s)
attempt 1 の retry dispatch 失敗
  → schedule(attempt = 2, dueAt = now + 20s)
attempt 5 の retry dispatch 失敗 (max_retry_attempts = 5)
  → remove() + retry exhausted warn (max_retry_attempts == attempt なので further schedule しない)
```

### Status 再取得

`fetchProjectCandidates` は既に tick 1 で呼んでいるが、retry の Issue / Status 検証は **その tick の retry drain phase でも 1 回呼ぶ** ([Tick の流れ](#tick-の流れ-改訂後) 2.3)。再取得を入れる理由:

- 人間 / agent が retry 待機中に Status を変更したケース (例: agent が `Failed` flip した、人間が Issue を close した) を尊重する
- `fetchProjectCandidates` は MVP では 1 page (100 件) のみ取得。retry の判定に必要なのは 1 Issue 分の Status だが、全件 fetch を再利用する設計が単純 (`philharmonic.yaml` の `polling.interval_ms` は通常 30s 以上のため、tick 1 回の中で 2 回呼んでも rate limit 上問題にはならない)

「Issue が Project board から落ちた」(= candidate 一覧に存在しない) ケースは `inactive_status` 扱いで drop する。

### `cleanupWorkspace` の force reset

retry の dispatch 前に必ず以下を実行する。

```ts
await deps.workspaceManager.cleanupWorkspace({
  taskKey: `issue-${entry.issueNumber}`,
  branch: entry.branch,
  deleteBranch: true,
});
```

`cleanupWorkspace` は冪等 (worktree が既に無ければ no-op、branch も同様)。失敗した場合 (例: git remove の権限エラー) は warn ログを出して次の dispatch 試行に進む — `dispatchSelected` 内で `createWorkspace` が改めて衝突 fail するため、結果は `workspace_provisioning` 失敗 → さらに retry attempt が積まれる。

### Snapshot HTTP API

`/api/v1/state` のレスポンスに `retry_queue` field を追加する。`scheduler` と同じく **optional + null 許容**。

```json
{
  "retry_queue": {
    "size": 2,
    "max_attempts": 5,
    "max_backoff_ms": 300000,
    "entries": [
      {
        "issue_number": 42,
        "attempt": 2,
        "due_at": "2026-05-09T00:00:50.000Z",
        "scheduled_at": "2026-05-09T00:00:30.000Z",
        "failure_reason": "runner_error",
        "last_run_id": "0190ce80-...",
        "last_error_summary": "claude exited with code 1: ..."
      }
    ]
  }
}
```

| フィールド                     | 型             | 説明                                                                              |
| ------------------------------ | -------------- | --------------------------------------------------------------------------------- |
| `retry_queue`                  | object \| null | retry queue が無効 (`max_retry_attempts == 0`) または queue 未注入時は null       |
| `retry_queue.size`             | integer        | 現在の entry 件数                                                                 |
| `retry_queue.max_attempts`     | integer        | `agent.max_retry_attempts` の現値 (運用者の参照用)                                |
| `retry_queue.max_backoff_ms`   | integer        | `agent.max_retry_backoff_ms` の現値                                               |
| `retry_queue.entries[]`        | array          | dueAt 昇順                                                                        |
| `entries[].issue_number`       | integer        | Issue 番号                                                                        |
| `entries[].attempt`            | integer        | 1-indexed retry 試行番号                                                          |
| `entries[].due_at`             | ISO 8601       | 次に dispatch される予定時刻                                                      |
| `entries[].scheduled_at`       | ISO 8601       | この entry が積まれた時刻                                                         |
| `entries[].failure_reason`     | string         | `workspace_provisioning` / `runner_error` / `timeout` / `stalled` / `hook_failed` |
| `entries[].last_run_id`        | string         | 直近失敗した run id                                                               |
| `entries[].last_error_summary` | string \| null | エラーメッセージの先頭 500 文字以内                                               |

「古い (本フィールドを実装していない) serve」が response から `retry_queue` を完全に省略するパターンも client 側で考慮する (TypeScript 上 `retry_queue?: ...` の **optional** にする)。

### `/api/v1/<issue_number>` への影響

retry queue 上の entry は **`/api/v1/<issue_number>` には載せない** (= 既存挙動のまま、in-flight でない Issue は 404 で返す)。retry の存在確認は `/api/v1/state` 経由で行う設計。理由は snapshot-api.md `retrying` 撤廃 (ADR-0005) 時の議論と同じく、Issue 単位の API は in-flight 判定に絞ることでレスポンス意味を簡潔に保つため。

## エラーハンドリング

| 発生箇所                                              | エラー              | 扱い方針                                                                                                                         |
| ----------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| retry drain 中の `getIssue` 失敗                      | network / 403 / 404 | warn `retry skipped reason=fetch_error` を出して entry を drop (queue から落とす)                                                |
| retry drain 中の Project items 取得失敗               | network / 403       | warn `retry drain error` を出して **その tick はゼロ retry** で fresh dispatch のみ進める                                        |
| retry 経路の `cleanupWorkspace` 失敗                  | git remove 失敗     | warn ログを 1 行出して次の `dispatchSelected` に進む。`createWorkspace` 衝突は通常の `workspace_provisioning` 失敗として扱われる |
| `dispatchSelected` の throw                           | BootstrapError 等   | 既存挙動 (catch して `runner_error` 扱い)。retry queue にも積み直す                                                              |
| retry queue が `agent.max_retry_attempts == 0` で無効 | retry 機能 off      | `dispatchSelected` 失敗時に schedule しない (`retryQueue.schedule` を呼ばない)                                                   |

## 構造化ログ

| level | msg                 | fields                                                                                                                      |
| ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| info  | `retry scheduled`   | `issueNumber`, `attempt`, `delayMs`, `dueAt`, `failureReason`, `lastRunId`                                                  |
| info  | `retry due`         | `issueNumber`, `attempt`, `lastRunId`                                                                                       |
| info  | `retry skipped`     | `issueNumber`, `attempt`, `reason` (`closed` / `terminal_status` / `inactive_status` / `fetch_error` / `tracker_in_flight`) |
| warn  | `retry exhausted`   | `issueNumber`, `attempt`, `failureReason`, `lastRunId`                                                                      |
| warn  | `retry drain error` | `error`                                                                                                                     |

`concurrent tick` ログには `retries` フィールドを追加する (= 当 tick で dispatch する retry 件数)。

```
{ msg: 'concurrent tick', maxConcurrent: 2, dispatched: 2, retries: 1 }
```

`max_concurrent_agents == 1` のときは互換挙動として `concurrent tick` を出さない既存形式を維持する (= retry 件数は `retry due` ログ単位で確認する)。

## 外部依存

- 既存 `WorkspaceManager.cleanupWorkspace` (`src/workspace/manager.ts`) — retry 経路で worktree force reset に使う
- 既存 `dispatchSelected` (`src/orchestrator/run.ts`) — workspace 作成以降の処理を再利用
- 既存 `RunTracker.getRunningByIssue` (`src/server/tracker.ts`) — 重複 dispatch ガード
- 既存 `GitHubClient.getIssue` / `ProjectsClient.fetchProjectCandidates` — Status 再取得
- 既存 `Logger.child` — `runId` / `issueNumber` を付与した派生 logger

## オープンクエスチョン

- failureReason 別に retry on/off を切り替える config 拡張 (例: `hook_failed` は人間が直すまで retry させない) — 必要になったら別 PR
- retry queue を `/api/v1/refresh` で強制 drain する API — 認証導入後の別 Issue
- TUI dashboard (ADR-0006) の Retry section 表示 — 後続 PR で `retry_queue` field を購読する
- multi-host 跨ぎの retry queue 共有 — multi-host orchestration ADR で扱う (MVP out-of-scope)
- attempt counter を runlog に記録する — 個別 retry の root cause を後追いするため。`<run-id>/metadata.json` に `retryAttempt` を追加する案あり (本 spec では未採用)

## MVP でやらないこと

- retry queue の永続化 (`.philharmonic/retry-queue.jsonl` 等)
- retry の即時 sleep (`philharmonic run` の同期 retry)
- failure reason 別の retry on/off 切り替え
- jitter の追加 (固定 backoff のみ)
- multi-host 同期
