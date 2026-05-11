# Retry Queue — `philharmonic serve` の自動再 dispatch

## 概要

`philharmonic serve` daemon の **retry queue** の仕様。以下 2 種類の自動再 dispatch を 1 本の queue で扱う。

- **failure retry** (ADR-0008): `workspace_provisioning` / `runner_error` / `timeout` / `stalled` / `hook_failed` のいずれかで失敗した dispatch を、Symphony と同じ指数バックオフ (`10s * 2^(attempt-1)` を `agent.max_retry_backoff_ms` で clamp) で自動的に再 dispatch する
- **continuation retry** (ADR-0009): agent が正常終了したのに Issue が active (Todo / In Progress) のままなら、短い固定 delay 後に Status を再確認して必要なら再 dispatch する

state は in-memory を SoT としつつ、`<repoRoot>/.philharmonic/state/retry-queue.json` に永続化する (ADR-0011 / Issue #104)。serve 再起動を跨いで attempt counter / dueAt / failureReason を維持する。drain → dispatch 間の crash window で 1 attempt が失われ得る挙動は許容し、`recoverInProgress` が `In Progress` Item を引き取って fall-back する (詳細は [永続化](#永続化-adr-0011)）。

## 関連 Issue

- Issue #84 — 失敗・stalled run を指数バックオフで自動リトライする
- Issue #85 — 正常終了後も Issue が active なら continuation retry で再確認する
- Issue #86 — 自動リトライ上限到達時に失敗情報と手動復旧手順を残す ([Failure summary on exhaustion](#failure-summary-on-exhaustion-issue-86))
- Issue #103 — retry exhausted 時に Project Status を `Failed` へ遷移し Issue に失敗情報を残す ([Exhaustion notify](#exhaustion-notify-issue-103))
- Issue #104 — retry queue を state file に永続化し serve 再起動を跨いで retry / exhaustion を継続する ([永続化](#永続化-adr-0011))
- Issue #109 — orphaned / stale running を安全条件付きで retry queue / Failed safety-net へ接続する ([orphan recovery 経路](#orphan-recovery-経路-109))
- ADR: [ADR-0008 失敗 / stalled run を指数バックオフで再 dispatch する in-memory retry queue を導入する](../adr/0008-in-memory-retry-queue.md), [ADR-0009 agent run の正常終了後に Issue が active のままなら continuation retry で再確認する](../adr/0009-continuation-retry-after-success.md), [ADR-0010 retry exhausted (kind=failure) 時に orchestrator が safety-net として GitHub Projects Status を Failed へ遷移し Issue にコメントする](../adr/0010-retry-exhaustion-github-safety-net.md), [ADR-0011 retry queue を local state file に永続化し serve 再起動を跨いで retry を継続する](../adr/0011-persist-retry-queue-across-restart.md)
- 関連 spec: [serve-daemon.md](./serve-daemon.md), [orchestration-mvp.md](./orchestration-mvp.md), [snapshot-api.md](./snapshot-api.md), [config-schema.md](./config-schema.md)
- 関連 ADR: [ADR-0005 §7 worktree cleanup の trigger 簡素化](../adr/0005-thin-orchestrator-agent-delegation.md), [ADR-0005 §8 retry-state は撤廃](../adr/0005-thin-orchestrator-agent-delegation.md)

## 用語

| 用語                  | 意味                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **retry queue**       | daemon プロセス内に 1 つ存在する in-memory な待機列。`Map<issueNumber, RetryEntry>` で実装する                    |
| **retry entry**       | 1 件の retry 情報。issueNumber / kind / attempt / dueAt / failureReason / branch / workspacePath ほか             |
| **kind**              | `'failure'` (失敗起因) / `'continuation'` (success 起因かつ Status が active のまま) のいずれか                   |
| **attempt**           | retry の試行番号 (1-indexed)。初回 dispatch は attempt 0 扱いで queue に積まれない。kind 切替時はカウンタリセット |
| **drain**             | `dueAt <= now` を満たす entry を queue から pop すること                                                          |
| **schedule**          | dispatch 失敗 / 成功時の active 残存を受けて retry entry を queue に enqueue する操作                             |
| **exhausted**         | `attempt > max_retry_attempts` で queue から落とす状態 (failure / continuation 共通)                              |
| **continuation 解放** | success 後の Status 再確認で terminal / inactive / closed が判明し、queue に積まずに終了する状態                  |

## 要件

### failure / continuation 共通

- `agent.max_retry_attempts >= 1` のとき機能 on (failure / continuation 両方)。`agent.max_retry_attempts == 0` のとき queue は **常に空** (機能 off)
- retry の dispatch は **次の poll tick 以降の `dueAt <= now`** を満たす最初の tick で発火する。同 tick 内の即時 sleep は行わない
- 各 retry の dispatch 直前に **`getIssue` と `fetchProjectCandidates` を再取得** し、Issue / Project Status が active でないなら drop する (詳細: [Status 再取得](#status-再取得))
- retry の dispatch は `agent.max_concurrent_agents` の slot を **最優先で消費** する。残り slot 件数だけ通常 candidate selection を呼ぶ
- 同一 Issue が retry queue に **同時に複数 entry 存在しない** (Map で `issueNumber` キーで dedup する)。`kind` が異なっても同居しない
- retry 中の Issue が `runTracker.getRunningByIssue !== null` のとき、その entry は dispatch せずに **同じ attempt / 同じ kind のまま `dueAt` を `now + 10s` に再 schedule** (重複 dispatch を防ぐ)
- 通常 candidate selection では、**queue に entry がある Issue を skip する** (`DispatchGuard.inRetryQueue`)。failure では worktree が残るため `workspaceExists` で弾けるが、continuation では worktree が cleanup 済みのため queue 参照が必須
- recovery 経路 (`recoverInProgress`) で `dispatchSelected` が failed / success を返した場合も、同じ規則で retry queue に積む (queue が DI で渡されているとき)
- `philharmonic run` (1 ターン CLI) は retry queue を持たない (queue を渡さなければ動作変更なし)

### failure retry (kind=`failure`)

- retry-eligible failure (本 spec [対象 failure](#対象-failure-failurereason)) を受けて自動的に積む
- backoff は `min(10_000 * 2^(attempt - 1), max_retry_backoff_ms)` で計算 (ms 単位)

### continuation retry (kind=`continuation`)

- `dispatchSelected` が `success` を返した直後に `fetchProjectCandidates` で当該 Issue の最新 Status を再取得
- Status が `dispatch_statuses ∪ {status_transitions.in_progress}` に含まれるなら **active** とみなし、continuation entry を schedule
- それ以外 (`in_review` / `failed` / `Done` / Issue closed / candidate に居ない) なら **release** (queue に積まない)
- delay は **固定値** `CONTINUATION_RETRY_DELAY_MS = 10_000` ms。`max_retry_backoff_ms` には依存しない
- attempt は failure とは **独立にカウント**。kind 切替時はカウンタリセット。上限は `max_retry_attempts` を共有
- `failureReason` / `lastErrorSummary` は always `null`

## 非機能要件

- **性能**: 1 retry あたり追加 GitHub API call は `getIssue` 1 回 + `fetchProjectCandidates` 1 回 (= candidate 取得 1 回) のみ。Project items 取得は通常 tick と共有可能だが、本 spec の最小実装では retry ごとに 1 回の overhead を許容する (rate limit 設計は将来要件)
- **可用性**: queue は in-memory を SoT としつつ `<repoRoot>/.philharmonic/state/retry-queue.json` に永続化 (ADR-0011)。daemon 再起動で attempt counter / dueAt / failureReason が維持される。drain → dispatch 間の crash window で 1 attempt が失われ得る挙動は許容し、`recoverInProgress` が `In Progress` Item を引き取って fall-back する
- **セキュリティ**: 永続 state file は retry queue のみ。Status 書き戻し駆動の旧 `.philharmonic/retry-state.json` 等の復活は **しない** (ADR-0011 は ADR-0005 の Status agent 委譲方針を維持する)。GitHub token は通常の dispatch 経路と同じく env allowlist で透過させる
- **アクセシビリティ**: 該当しない (機械可読 API + 構造化ログ)

## データモデル

### `RetryEntry` (in-memory)

```ts
type RetryEntry = {
  kind: 'failure' | 'continuation';
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  attempt: number; // 1-indexed retry attempt (kind 内で独立にカウント)
  dueAt: Date; // ISO 8601 ms 精度
  scheduledAt: Date;
  failureReason: FailureReason | null; // kind=continuation のとき null
  lastRunId: string;
  lastErrorSummary: string | null; // kind=continuation のとき null
};
```

`FailureReason` は `src/orchestrator/errors.ts` の type ([対象 failure](#対象-failure-failurereason) と同じ列挙)。`lastErrorSummary` は `markFailed` が `describeError(error)` または `RunResult.rawStderrTail` から組み立てた `errorSummary` (先頭最大 500 文字) を `RunOnceResult.failed.errorSummary` 経由で受け取る。`runConcurrent` の dispatch worker が想定外 throw した場合は catch 句で同様に `describeError(error)` から作る。

continuation kind では `failureReason` / `lastErrorSummary` は常に null (success 経路で積まれるため)。

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
  /** 既存 entry があれば差し替える (同一 issueNumber は 1 件だけ。kind 違いも上書き) */
  schedule(input: ScheduleInput): RetryEntry;
  /** dueAt <= now の entry を取り出して queue から消す。残りは保持 */
  drainDue(now: Date): RetryEntry[];
  /** 任意 issue を queue から落とす (success 時の release / exhausted 時に呼ぶ) */
  remove(issueNumber: number): boolean;
  /** dispatch ガード用: 該当 Issue が queue に居るかどうか (kind 問わず) */
  has(issueNumber: number): boolean;
  /** dispatch 直前の重複防止用: tracker_in_flight だった entry を 10s 後に積み直す */
  reschedule(input: RescheduleInput): RetryEntry;
  /** Snapshot API 用。dueAt 昇順 */
  list(): readonly RetryEntry[];
  /** 件数 */
  size(): number;
};

type ScheduleInput = {
  kind: 'failure' | 'continuation';
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  attempt: number; // schedule する attempt 番号 (1-indexed)
  failureReason: FailureReason | null; // kind=continuation のとき null
  lastRunId: string;
  lastErrorSummary: string | null;
  now: Date;
  maxBackoffMs: number; // kind=continuation では無視 (固定 delay)
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

continuation の delay は固定値 `CONTINUATION_RETRY_DELAY_MS = 10_000` を使う (computeRetryDelayMs は使わない)。

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
  1. retry queue から drainDue(now) で due な entry を pop (kind 問わず)
  2. 各 entry について:
     2.1 runTracker.getRunningByIssue(issueNumber) !== null → 同 kind / 同 attempt のまま reschedule(10s 後), drop from this tick
     2.2 getIssue で再取得 → state === 'closed' なら remove(), `retry skipped reason=closed kind=...` info ログ
     2.3 fetchProjectCandidates で再取得 → status が "active 範囲" 外なら remove(), `retry skipped reason=terminal_status / inactive_status kind=...` info ログ
         active 範囲 = dispatch_statuses ∪ {status_transitions.in_progress}
     2.4 上記合格なら retry task に積む
  3. retry tasks の件数 M。fresh slots = max(0, max_concurrent_agents - M)
  4. fresh_slots > 0 なら通常 candidate selection を呼ぶ
     4.1 DispatchGuard.inRetryQueue(issueNumber) が true の Issue は skip (`retry_queued`)
     4.2 残りは既存挙動 (status / assignee / dependency / workspaceExists / isRunning)
  5. retry tasks + fresh tasks (合計 ≤ max_concurrent_agents) を dispatchPool に投入
     5.1 retry task の場合 (failure / continuation 共通): dispatchSelected を呼ぶ前に cleanupWorkspace で worktree を force reset
     5.2 dispatchSelected を呼ぶ
  6. 各 dispatch 結果を集計:
     6.1 success → fetchProjectCandidates で当該 Issue の最新 Status を再取得 (runConcurrent では同 tick 内で 1 回に共有)
         6.1.1 active なら continuation entry を schedule (kind=continuation, fixed delay 10s, attempt は kind 別カウンタ +1)
         6.1.2 attempt が max_retry_attempts 超 → remove() + `retry exhausted kind=continuation` warn
         6.1.3 inactive / terminal / closed / fetch error なら remove() + `continuation released reason=...` info
     6.2 failed (retry-eligible) かつ attempt + 1 <= max_retry_attempts → schedule(kind=failure, attempt + 1)
     6.3 failed (retry-eligible) かつ attempt + 1 > max_retry_attempts → remove() + `retry exhausted kind=failure` warn
     6.4 failed (retry 対象外) → 既存挙動 (queue に触らない)
  7. sleep
```

retry entry の `attempt` は **その entry が現在保持している試行番号** (= 直前の dispatch の試行回数)。tick 内で再 dispatch するときの「次回 attempt」は同じ kind なら `attempt + 1`、kind が切り替わるなら `1` から (counter リセット)。「初回失敗 → 初 failure schedule」も「初回 success → 初 continuation schedule」も attempt=1 で schedule する (attempt 0 は queue に積まない)。

具体的な遷移 (failure):

```
初回 dispatch (attempt 0) 失敗
  → schedule(kind=failure, attempt = 1, dueAt = now + 10s)
failure attempt 1 の retry dispatch 失敗
  → schedule(kind=failure, attempt = 2, dueAt = now + 20s)
failure attempt 5 の retry dispatch 失敗 (max_retry_attempts = 5)
  → remove() + `retry exhausted kind=failure` warn
```

具体的な遷移 (continuation):

```
初回 dispatch success かつ Status active
  → schedule(kind=continuation, attempt = 1, dueAt = now + 10s)
continuation attempt 1 の retry dispatch success かつ Status active
  → schedule(kind=continuation, attempt = 2, dueAt = now + 10s)
continuation attempt 5 の retry dispatch success かつ Status active (max_retry_attempts = 5)
  → remove() + `retry exhausted kind=continuation` warn
```

kind 切替の例:

```
failure attempt 2 dispatch success かつ Status active
  → schedule(kind=continuation, attempt = 1, ...)  -- counter リセット
continuation attempt 2 dispatch failed (runner_error)
  → schedule(kind=failure, attempt = 1, ...)  -- counter リセット
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
        "kind": "failure",
        "issue_number": 42,
        "attempt": 2,
        "due_at": "2026-05-09T00:00:50.000Z",
        "scheduled_at": "2026-05-09T00:00:30.000Z",
        "failure_reason": "runner_error",
        "last_run_id": "0190ce80-...",
        "last_error_summary": "claude exited with code 1: ...",
        "branch": "feature/42-foo",
        "workspace_path": "/home/user/.philharmonic/worktrees/issue-42"
      },
      {
        "kind": "continuation",
        "issue_number": 43,
        "attempt": 1,
        "due_at": "2026-05-09T00:01:00.000Z",
        "scheduled_at": "2026-05-09T00:00:50.000Z",
        "failure_reason": null,
        "last_run_id": "0190ce80-...",
        "last_error_summary": null,
        "branch": "feature/43-bar",
        "workspace_path": "/home/user/.philharmonic/worktrees/issue-43"
      }
    ]
  }
}
```

| フィールド                     | 型                              | 説明                                                                                                                |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `retry_queue`                  | object \| null                  | retry queue が無効 (`max_retry_attempts == 0`) または queue 未注入時は null                                         |
| `retry_queue.size`             | integer                         | 現在の entry 件数                                                                                                   |
| `retry_queue.max_attempts`     | integer                         | `agent.max_retry_attempts` の現値 (運用者の参照用)                                                                  |
| `retry_queue.max_backoff_ms`   | integer                         | `agent.max_retry_backoff_ms` の現値                                                                                 |
| `retry_queue.entries[]`        | array                           | dueAt 昇順                                                                                                          |
| `entries[].kind`               | `"failure"` \| `"continuation"` | retry の種類。`failure` は ADR-0008、`continuation` は ADR-0009                                                     |
| `entries[].issue_number`       | integer                         | Issue 番号                                                                                                          |
| `entries[].attempt`            | integer                         | 1-indexed retry 試行番号 (kind 内で独立にカウント)                                                                  |
| `entries[].due_at`             | ISO 8601                        | 次に dispatch される予定時刻                                                                                        |
| `entries[].scheduled_at`       | ISO 8601                        | この entry が積まれた時刻                                                                                           |
| `entries[].failure_reason`     | string \| null                  | failure: `workspace_provisioning` / `runner_error` / `timeout` / `stalled` / `hook_failed`。continuation: 常に null |
| `entries[].last_run_id`        | string                          | 直近の run id (failure: 失敗した run / continuation: success した run)                                              |
| `entries[].last_error_summary` | string \| null                  | failure 時のエラー先頭 500 文字。continuation では常に null                                                         |
| `entries[].branch`             | string                          | retry 対象 Issue の feature branch (#87)                                                                            |
| `entries[].workspace_path`     | string                          | retry 対象 Issue の worktree path (#87)。retry drain 時に `cleanupWorkspace` する path                              |

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

## Failure summary on exhaustion (Issue #86)

`kind=failure` の retry が上限に到達した瞬間に、運用者向けの失敗サマリを **per-run-id** の Markdown ファイルとして書き出す。

- 出力先: `<runnerLogsRoot>/<runId>/failure-summary.md` (= 通常の repo 配下では `.philharmonic/runs/<run-id>/failure-summary.md`)
- 既存 `createRunLog` が `<runId>` dir を mkdir 済みのため追加 mkdir は不要
- ファイル内容には issue number / final attempt / max attempts / last failure reason / last run id / branch / worktree path / exhausted at / 直近 error summary (先頭 500 文字) と、関連 run artifact (`summary.md` / `stream.jsonl` / `stderr.log` / `metadata.json`) への相対パス、人手での再実行手順 (`Project Status を Todo に戻す` ほか) を含める
- `kind=continuation` の exhaustion では failure summary は **書かない** (失敗ではなく「Status flip 漏れの上限到達」のため)。既存 `retry exhausted` warn ログだけが残る
- 書き込みに失敗した場合は `failure summary write failed` warn を 1 行残し、後続の `retry exhausted` warn の `failureSummaryPath` を `null` にして処理継続する (Issue #86 完了条件「comment / log 投稿に失敗しても orchestrator 本体の failure handling は壊れない」を満たす)

~~ADR-0005「orchestrator は GitHub に書き込まない」方針との関係上、Issue comment 投稿 / `Failed` Status 遷移は本 spec の範囲では **行わない**。~~ Issue #103 / ADR-0010 で方針を更新し、`kind=failure` の exhaustion に限定して orchestrator が Project Status 更新 + Issue コメント投稿を行うようにした (詳細: [Exhaustion notify](#exhaustion-notify-issue-103))。`kind=continuation` の exhaustion では引き続き file + 構造化ログのみで、Status / コメントは触らない。

## Exhaustion notify (Issue #103)

`kind=failure` の retry が上限に到達した瞬間、orchestrator は safety-net として **GitHub Projects の Status を `status_transitions.failed` に遷移し、Issue に運用者向けコメントを 1 件投稿する** (ADR-0010)。

- 通常の Status 遷移 / PR 作成 / Issue コメントは ADR-0005 通り agent 委譲を維持する。**retry exhausted (`kind=failure`) の 1 点のみ** の例外
- `kind=continuation` の exhaustion では notify を **行わない** ([Failure summary on exhaustion](#failure-summary-on-exhaustion-issue-86) と同じ理由: 失敗ではなく Status flip 漏れの上限到達のため)

### 動作

1. 既存コメント取得 (`gh issue view <num> --json comments`) で `<!-- philharmonic-run-failed:run_id=<lastRunId> -->` marker の有無を確認する
   - marker が既に存在: comment 投稿を **skip** (`exhaustion notify skipped (already commented)` info ログ)
   - 取得自体が失敗: 安全側に倒し comment 投稿を skip + `exhaustion comment dedup check failed` warn ログ
2. `gh project field-list` + `gh project item-edit` で Project Item の Status field を `status_transitions.failed` に倒す
3. `gh issue comment <num> --body-file <path>` で marker 付きのコメントを投稿する。body は `<runnerLogsRoot>/<runId>/issue-comment.md` に書き出してから渡す (改行 / markdown を CLI 引数で渡さない)
4. Status 更新 / Comment 投稿は **それぞれ独立に try/catch**。片方が失敗してももう一方は試みる。両方とも失敗時はそれぞれ warn ログを 1 行残して return する (orchestrator は throw しない)

### コメント本文に含める情報

- 先頭: `<!-- philharmonic-run-failed:run_id=<lastRunId> -->` HTML コメントマーカ
- Issue 番号 / final attempt / max attempts / failure reason / last run id / branch / workspace path / exhausted at
- failure-summary.md / summary.md / stream.jsonl / stderr.log / metadata.json への相対 path
- 手動復旧手順 (`philharmonic retry <num>` ほか)

### 構造化ログ

| level | msg                                             | 出力タイミング                                                  |
| ----- | ----------------------------------------------- | --------------------------------------------------------------- |
| info  | `exhaustion notify skipped (already commented)` | 既存コメントに同じ run_id の marker が見つかり skip した        |
| info  | `exhaustion status updated`                     | Status 更新が成功                                               |
| info  | `exhaustion comment posted`                     | Issue コメント投稿が成功                                        |
| warn  | `exhaustion comment dedup check failed`         | `gh issue view --json comments` が throw した (comment を skip) |
| warn  | `exhaustion status update failed`               | Status 更新が throw した (comment 投稿は続行)                   |
| warn  | `exhaustion comment post failed`                | Comment 投稿が throw した                                       |
| warn  | `exhaustion notify threw`                       | 上記 3 系統以外の想定外 throw (run.ts 側で catch した)          |

### DI / 配線

- 新規 module `src/orchestrator/exhaustion-notify.ts` が `notifyFailureExhausted(input, deps)` を export する
- `runOnce` / `runConcurrent` の `RunOnceDeps` に `runGh?: GhRunner` / `notifyFailureExhausted?` を追加。`runGh` 未注入なら no-op (= `philharmonic run` 互換)
- serve では `defaultGhRunner` を渡し、推奨経路として `GITHUB_TOKEN` / `GH_TOKEN` を env で透過させる (ADR-0005 §3 と同じ token を共用)

### 構造化ログとの対応

`retry exhausted` warn (kind=`failure`) には failure summary 関連フィールドが追加で乗る:

| field                | 値                                                    |
| -------------------- | ----------------------------------------------------- |
| `failureSummaryPath` | 書き出した absolute path (失敗時 null)                |
| `summaryPath`        | `.philharmonic/runs/<runId>/summary.md` (相対 path)   |
| `streamPath`         | `.philharmonic/runs/<runId>/stream.jsonl` (相対 path) |
| `stderrPath`         | `.philharmonic/runs/<runId>/stderr.log` (相対 path)   |
| `branch`             | feature branch                                        |
| `workspacePath`      | retry 対象 Issue の worktree path                     |

## 永続化 (ADR-0011)

retry queue の attempt counter / dueAt / failureReason を `<repoRoot>/.philharmonic/state/retry-queue.json` に保存し、daemon 再起動を跨いで復元する (Issue #104)。

### state file の schema

```json
{
  "version": 1,
  "entries": [
    {
      "kind": "failure",
      "issueNumber": 42,
      "repository": { "owner": "hexylab", "name": "philharmonic" },
      "branch": "feature/42-foo",
      "workspacePath": "/abs/.philharmonic/worktrees/issue-42",
      "attempt": 2,
      "dueAt": "2026-05-09T00:00:50.000Z",
      "scheduledAt": "2026-05-09T00:00:30.000Z",
      "failureReason": "runner_error",
      "lastRunId": "0190ce80-...",
      "lastErrorSummary": "claude exited with code 1: ..."
    }
  ]
}
```

- `version`: 現行は `1`。将来の破壊的変更で bump する
- `entries`: `Map<issueNumber, RetryEntry>` を flatten した配列。`Date` は ISO 8601 文字列
- `RetryEntry` の field 構成は [`RetryEntry` (in-memory)](#retryentry-in-memory) と 1:1 で対応

### write 経路 (atomic + 直列化)

queue の mutation (`schedule` / `remove` / `drainDue` / `reschedule`) が実際に in-memory state を変更したときに 1 件 1 write 発生する。

1. `mkdir -p .philharmonic/state/` (初回起動向け)
2. `<state.json>.tmp` に JSON を書く
3. `rename(tmp, state.json)` で atomic swap

`save()` の重複呼び出しは store 内部で `lastWrite = lastWrite.then(...)` の chain で直列化し、後勝ち snapshot で確定する。`drainDue` で 0 件 / 存在しない issue に対する `remove` は no-op として save を呼ばない (write 無駄を避ける)。

save が throw した場合は `retry queue persist failed` warn を 1 行残し、**in-memory state はそのまま保持** する (orchestrator 本体は throw しない)。次の mutation で再 save される (degraded behavior)。

### 起動時の load

`philharmonic serve` 起動時、`acquireServeLock` 後、`recoverInProgress` の前に state file を 1 回 load する。

| 状況                         | 挙動                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| file 不在                    | `retry queue restore empty` info ログ + empty queue で起動                                                            |
| JSON parse 失敗              | `<state.json>` を `<state.json>.bak` に rename + `retry queue restore parse failed` warn + empty queue で起動         |
| `version` mismatch           | `retry queue restore version mismatch` warn + empty queue で起動 (bak には rename しない)                             |
| entry 単位の schema 違反     | その entry のみ skip + `retry queue restore entry invalid` warn 1 行 (`field` / `reason` を含む)。残りの entry は採用 |
| entry 単位の重複 issueNumber | 最後に出現したものを採用 (Map 上書きの自然挙動)                                                                       |

load 成功時は `retry queue restored` info を 1 行 (`path` / `count` / `version` を含む) 出す。

### 復元後の release pass

load 直後に queue へ積み戻したあと、startup 1 回限定の release 判定を行う。drain phase で再確認する terminal / inactive status はここでは扱わない (重複削減)。

| 状態                                         | アクション                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `getIssue` が `state === 'closed'`           | drop + `retry skipped reason=closed via=restore` info                            |
| `listOpenPullRequests` が 1 件以上           | drop + `retry skipped reason=open_pr via=restore` info                           |
| `getIssue` / `listOpenPullRequests` が throw | queue に残置 + `retry queue restore fetch error` warn (次の drain tick で再判定) |

open PR の特殊性: agent が PR を作ったが Status flip 前という稀ケースで残骸 retry を発射しないための safety-net。`drainRetryQueue` には毎 tick で open PR を fetch するコストを掛けず、復元時の 1 回だけ実施する。

### orphan recovery 経路 (#109)

active run watchdog (#105) が `orphaned + stale` を **同時に** 立てた entry のうち、安全条件 ([serve-daemon.md#orphan-recovery-109](./serve-daemon.md#orphan-recovery-109)) を満たすものだけが本 queue に **`kind=failure`, `failureReason=stalled`** で schedule される。`attempt` は永続化された既存 entry が同 Issue に残っていれば `existing.attempt + 1`、それ以外は `1`。`nextAttempt > max_retry_attempts` のときは `recovery` 経路と同様に `handleFailureExhaustion` (ADR-0010) が走り、`retry exhausted via=watchdog` warn と Failed safety-net comment が 1 セットで発火する。

合格条件のいずれかに失敗した entry は queue に積まず、`tracker.setWatchdog` で `operatorActionRequired: true` を立てる。dashboard / Snapshot API に `running[].watchdog.operator_action_reasons` として露出する (`orphaned_only` / `stale_only` / `open_pr` / `retry_disabled` / `unsafe_workspace_path` / `recover_error`)。

### recovery 経路での attempt counter 継続

`recoverInProgress` (`src/orchestrator/recovery.ts`) が `In Progress` Item を引き取って failed を返したとき、persisted entry が同 Issue に残っていれば **`attempt + 1` を継続** する。kind が `failure` と一致するときのみ +1、それ以外 (continuation など) は 1 から始める。`nextAttempt > max_retry_attempts` のときは `retry exhausted via=recovery` warn を残し queue から落とす。

これにより serve 起動 → recovery 再 dispatch → 再失敗 → persisted attempt が 1 に潰される事故が起きない。

### 永続化ログ

| level | msg                                          | fields                                                                |
| ----- | -------------------------------------------- | --------------------------------------------------------------------- |
| info  | `retry queue restored`                       | `path`, `count`, `version`                                            |
| info  | `retry queue restore empty`                  | `path`                                                                |
| info  | `retry queue restore release pass completed` | `inspected`, `released`, `retained`, `skipped`                        |
| info  | `retry skipped` `reason=open_pr`             | `issueNumber`, `kind`, `attempt`, `via=restore`                       |
| warn  | `retry queue restore parse failed`           | `path`, `backupPath`, `error`                                         |
| warn  | `retry queue restore version mismatch`       | `path`, `version`, `expected`                                         |
| warn  | `retry queue restore entry invalid`          | `index`, `issueNumber`, `reason`, `field`                             |
| warn  | `retry queue restore fetch error`            | `issueNumber`, `stage` (`getIssue` / `listOpenPullRequests`), `error` |
| warn  | `retry queue persist failed`                 | `path`, `error`                                                       |

## 構造化ログ

| level | msg                             | fields                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| info  | `retry scheduled`               | `kind`, `issueNumber`, `attempt`, `delayMs`, `dueAt`, `failureReason` (continuation では null), `lastRunId`, `via` (recovery 経由のとき)                                                                                                                                                                                               |
| info  | `retry due`                     | `kind`, `issueNumber`, `attempt`, `lastRunId`                                                                                                                                                                                                                                                                                          |
| info  | `retry skipped`                 | `kind`, `issueNumber`, `attempt`, `reason` (`closed` / `terminal_status` / `inactive_status` / `fetch_error` / `tracker_in_flight`)                                                                                                                                                                                                    |
| warn  | `retry exhausted`               | `kind`, `issueNumber`, `attempt`, `failureReason` (continuation では null), `lastRunId`。**kind=`failure` のみ** さらに `branch`, `workspacePath`, `failureSummaryPath` (書き込み失敗時 null), `summaryPath`, `streamPath`, `stderrPath` を含む (Issue #86 / [Failure summary on exhaustion](#failure-summary-on-exhaustion-issue-86)) |
| warn  | `failure summary write failed`  | `issueNumber`, `runId`, `attempt`, `path`, `error` — `kind=failure` exhaustion 時に Markdown 書き込みが失敗したとき (Issue #86)                                                                                                                                                                                                        |
| warn  | `retry drain error`             | `error`                                                                                                                                                                                                                                                                                                                                |
| info  | `continuation released`         | `issueNumber`, `reason` (`closed` / `terminal_status` / `inactive_status` / `fetch_error`), `status` (取得できたとき), `lastRunId`                                                                                                                                                                                                     |
| info  | `skip candidate (retry queued)` | `issueNumber` — `DispatchGuard.inRetryQueue` が true で fresh selection から skip した                                                                                                                                                                                                                                                 |

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
- continuation 専用の cap / delay を `agent.continuation_*` で別設定可能にする — failure と同 cap で運用上問題が出てから検討
- retry queue を `/api/v1/refresh` で強制 drain する API — 認証導入後の別 Issue
- TUI dashboard (ADR-0006) の Retry section 表示 — 後続 PR で `retry_queue` field を購読する
- multi-host 跨ぎの retry queue 共有 — multi-host orchestration ADR で扱う (MVP out-of-scope)
- attempt counter を runlog に記録する — 個別 retry の root cause を後追いするため。`<run-id>/metadata.json` に `retryAttempt` を追加する案あり (本 spec では未採用)
- continuation drain 時に DAG (ADR-0007) を再評価して blocked なら release する — 短い delay の間に依存先が増えるケースは稀だが、別 PR で追加する余地あり
- ~~failure exhaustion の Issue comment 投稿 (hidden marker `<!-- philharmonic-run-failed:issue=...;run_id=... -->` で重複防止)~~ — ADR-0010 / Issue #103 で実装済み ([Exhaustion notify](#exhaustion-notify-issue-103))
- ~~failure exhaustion 時の Project Status `Failed` 自動遷移 (opt-in 設定)~~ — ADR-0010 / Issue #103 で実装済み (opt-in ではなく `runGh` 注入時の default 挙動)
- exhaustion notify の dedup チェックを `gh api ... --paginate` 経由に切り替える — 現状は `gh issue view --json comments` の 1 ページ取得で marker を探している。コメント数が大量にあって marker が古いページに埋もれた Issue で dedup miss → 二重コメントが起きうるが、同一 run_id の notify は構造的に 1 回しか呼ばれないため MVP では許容する

## MVP でやらないこと

- ~~retry queue の永続化 (`.philharmonic/retry-queue.jsonl` 等)~~ — ADR-0011 / Issue #104 で実装済み ([永続化](#永続化-adr-0011))
- retry の即時 sleep (`philharmonic run` の同期 retry)
- failure reason 別の retry on/off 切り替え
- jitter の追加 (固定 backoff のみ)
- multi-host 同期
- ~~failure exhaustion 時の Issue comment 投稿~~ — ADR-0010 / Issue #103 で実装済み
- ~~failure exhaustion 時の Project Status `Failed` 自動遷移~~ — ADR-0010 / Issue #103 で実装済み
