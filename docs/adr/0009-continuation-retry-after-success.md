# ADR-0009: agent run の正常終了後に Issue が active のままなら continuation retry で再確認する

- **ステータス**: Accepted
- **決定日**: 2026-05-10

---

## コンテキスト

ADR-0005 で「Status は agent が書く」と決めた結果、orchestrator は agent process が exit code 0 で終わったかどうかしか直接観測できない。しかし「runner プロセスが正常終了した」ことと「Issue の作業が完了した」ことは一致しない。

具体的には以下のような失敗モードが発生する。

- agent が Status を `In Review` / `Failed` に flip するための tool 呼び出しを忘れて exit する (max_turns 到達 / prompt の指示落ち)
- agent が PR 作成に失敗したのに Status を flip せず exit する
- 一過性の `gh` API エラーで Status 遷移コマンドだけ失敗するが exit code は 0

これらのケースでは:

- `dispatchSelected` は `success` を返す → orchestrator は worktree を cleanup する (ADR-0005 §7)
- Project Status は `Todo` / `In Progress` のまま残る
- 次の poll tick の candidate selection で同じ Issue が再 pick される **まで**、daemon は何もしない

ADR-0008 の retry queue は **失敗** の自動再試行を扱うが、**正常終了 + Status 不更新** のケースは対象外。本家 Symphony では worker が正常終了しても Issue が active state のままなら約 1 秒後に continuation retry を入れ、再度 tracker 状態を確認する設計になっている。

philharmonic の現状で次 tick まで待つのは:

- `polling.interval_ms` が 30 秒〜数分のため、Status 更新漏れが続くと daemon の応答が体感的に遅い
- 二重 dispatch ガード ([ADR-0005 §5](./0005-thin-orchestrator-agent-delegation.md)) は worktree 存在 / in-flight tracker しか見ないため、worktree が cleanup されたタイミング次第で `Todo` の Issue が即時再 pick されるが、これは「retry 仕様を経由していない」突発再 dispatch であり、ログ・状態上で区別できない
- continuation retry 経路に乗せれば、Symphony 互換の運用直感 (再 dispatch のスケジュール時刻 / kind / attempt が snapshot とログから観測できる) が得られる

本 ADR は、ADR-0008 の in-memory retry queue を **継続して使い回し**、正常終了後の Status 再確認 → 必要なら短い固定 delay で再 dispatch する仕組みを追加する。

## 決定

### 1. `dispatchSelected` の `success` 直後に Project Status を再確認する

`dispatchSelected` が `success` を返したら、`fetchProjectCandidates` で当該 Issue の最新 Project Status を再取得する (`getIssue` は呼ばない: `Candidate.issueState` で OPEN/CLOSED 判定が取れる)。

| Status                                   | 判定     | アクション                                                         |
| ---------------------------------------- | -------- | ------------------------------------------------------------------ |
| `dispatch_statuses` のいずれか           | active   | continuation retry を schedule (kind=continuation, fixed delay)    |
| `status_transitions.in_progress`         | active   | continuation retry を schedule (recovery と同じ active 範囲を使う) |
| `status_transitions.in_review`           | terminal | release (queue から落として何もしない)                             |
| `status_transitions.failed`              | terminal | release                                                            |
| `Done` / その他                          | inactive | release                                                            |
| Issue が close 済み / candidate に居ない | inactive | release                                                            |
| `fetchProjectCandidates` 失敗            | unknown  | release (warn ログ。次 tick の通常 selection に委ねる)             |

active 範囲は ADR-0008 §4 の retry drain と同一 (`dispatch_statuses ∪ {status_transitions.in_progress}`)。「`In Progress`」も含めるのは agent が Todo→In Progress flip のあとで Status 更新を忘れた場合を救うため。

### 2. continuation retry は **既存の in-memory retry queue を再利用** する

ADR-0008 の `RetryQueue` を再利用し、`RetryEntry` に `kind: 'failure' | 'continuation'` を追加して両者を 1 本の queue で扱う。

- 同一 Issue は queue 内に 1 件のみ (Map で dedup)。kind が異なっても同居しない
- `failureReason` は kind=`continuation` のとき null
- `lastErrorSummary` も kind=`continuation` のとき null

### 3. continuation の delay は **指数バックオフではなく短い固定値** とする

固定値 `CONTINUATION_RETRY_DELAY_MS = 10_000` ms。設定は config 化しない。

理由:

- Symphony は約 1 秒だが、philharmonic の `polling.interval_ms` は通常 30 秒以上。1 秒では tick の coalescing 効果が得られず、agent が flip 中の Status を読み取れない race を増やすだけ
- 10 秒は tick 間隔に対して十分小さく、かつ Symphony より大きく取って agent 側の Status 更新ラグを吸収する
- `agent.max_retry_backoff_ms` を流用すると「失敗 retry の backoff 上限」と「continuation の固定 delay」が config 上一致しなくなり、運用上の混乱を招く

### 4. continuation の attempt cap も `agent.max_retry_attempts` に従う (separate counter)

continuation も無限再試行はせず、`agent.max_retry_attempts` で上限を切る。ただし failure の counter とは **独立** に数える (= kind 切替時にカウンタはリセット)。

```
fresh dispatch success (Status active)
  → continuation attempt 1 schedule (delay 10s)
continuation attempt 1 dispatch success (Status active)
  → continuation attempt 2 schedule (delay 10s)
continuation attempt 5 dispatch success (Status active) [max_retry_attempts = 5]
  → drop + `continuation exhausted` warn

continuation attempt 2 dispatch failed (runner_error)
  → failure attempt 1 schedule (delay 10s, exponential)  -- counter リセット
failure attempt 1 dispatch success (Status active)
  → continuation attempt 1 schedule -- counter リセット
```

`agent.max_retry_attempts == 0` のとき continuation 機能も off (= 既存挙動)。

### 5. 重複 dispatch ガードに `inRetryQueue` 述語を追加する

`dispatchSelected` の success 直後に worktree は cleanup される ([ADR-0005 §7](./0005-thin-orchestrator-agent-delegation.md))。続けて continuation entry が queue に積まれるが、`dueAt` まで 10 秒の窓が空く。この間に poll tick が走ると、二重 dispatch ガードが以下の状態になる:

- `workspaceExists`: false (cleanup 済み)
- `isRunning`: false (dispatch 終了済み)
- → fresh candidate selection が同じ Issue を pick して再 dispatch する

これは「同一 Issue の重複 dispatch が起きない」(Issue #85 完了条件) に違反する。failure retry の場合は worktree が保持される (ADR-0005 §7) ため `workspaceExists` で弾かれていたが、continuation はその防御が効かない。

そこで `DispatchGuard` に `inRetryQueue(issueNumber): boolean` を追加し、`checkDispatchGuard` の最初で skip する。skip reason は `retry_queued`。

```ts
type DispatchGuard = {
  workspaceExists(issueNumber): Promise<boolean>;
  isRunning(issueNumber): boolean;
  inRetryQueue(issueNumber): boolean; // 新設
};
```

これで failure / continuation を問わず、queue に entry がある間は fresh selection が pick しない。retry drain 経路は queue から pop してから dispatch するため自分自身を弾くことはない。

`RetryQueue` interface にも `has(issueNumber): boolean` を追加する。

### 6. recovery 経路でも success → continuation を判定する

`recoverInProgress` で `dispatchSelected` が success を返した場合も、active なら continuation を schedule する。serve 起動直後の recovery 後に start する `serveLoop` で消化される。

既存の `recovery dispatch success` ログは維持する。continuation 判定は `recovery dispatch success` の後に走り、必要なら `retry scheduled` (via=recovery, kind=continuation) を追加で出す。

### 7. observability

ログ:

| level | msg                     | 追加 fields                                                                                                                |
| ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| info  | `retry scheduled`       | `kind` (`failure`/`continuation`)                                                                                          |
| info  | `retry due`             | `kind`                                                                                                                     |
| info  | `retry skipped`         | `kind`, `reason` (既存 + `retry_queued` は `skip candidate` 側)                                                            |
| warn  | `retry exhausted`       | `kind`                                                                                                                     |
| info  | `continuation released` | `issueNumber`, `reason` (`closed` / `terminal_status` / `inactive_status` / `fetch_error`) — success 時に release した記録 |

Snapshot HTTP API の `retry_queue.entries[]` に `kind` field を追加する (failure と continuation の比率が運用上見えるように)。

### 8. dependency filter (ADR-0007) は continuation では再評価しない (MVP)

continuation retry は失敗ではなく「直前の dispatch が完了したばかりの Issue」を扱う。短い delay の間に依存先が新たに blocked になるケースは稀で、依存解決の追加 fetch コストに見合わない。

将来 continuation drain 時に DAG 評価を入れるかは別 Issue で検討する (本 ADR 範囲外)。

## 結果

### 良い結果

- agent の Status flip 漏れが 10 秒で自動回復する (Symphony 互換の体感)
- failure retry と continuation retry を 1 本の retry queue で扱えるため、in-memory state / snapshot / ログの設計が単純
- `inRetryQueue` ガード追加で「retry 中なのに fresh selection が拾う」競合を全 retry kind で根絶できる

### トレードオフ・悪い結果

- success 1 回ごとに `fetchProjectCandidates` が 1 回追加で走る (runConcurrent では同 tick 内の全 success で 1 回に共有される)
- continuation が無限再試行されないよう attempt cap は必要だが、`agent.max_retry_attempts` を流用しているため「failure と continuation の cap を別々にしたい」運用要望が将来出る可能性がある (別 ADR 化する余地は残す)
- delay 10 秒は固定。短すぎる (agent 側の Status 更新を観測できない) / 長すぎる (運用上の体感) どちらにも振れない柔軟性は config 化されていない (将来要件)

### 影響を受けるコンポーネントや今後の作業

- spec:
  - `docs/specs/retry-queue.md` — 既存 spec を「failure + continuation」両対応に改訂
- code:
  - `src/orchestrator/retry-queue.ts` — `kind` / `has` / continuation delay
  - `src/orchestrator/select.ts` — `DispatchGuard.inRetryQueue` / `'retry_queued'` reason
  - `src/orchestrator/run.ts` — `runOnce` / `runConcurrent` / `drainRetryQueue` / success 後の continuation schedule
  - `src/orchestrator/recovery.ts` — recovery success → continuation
  - `src/server/snapshot.ts` — `retry_queue.entries[].kind`
- 後続 (本 ADR 範囲外):
  - continuation 専用 cap / delay の config 化
  - continuation drain 時の DAG 再評価
  - TUI dashboard (ADR-0006) の retry section に kind を表示

## 検討した他の選択肢

### 選択肢 A: success 時に schedule せず、常に短い間隔の追加 poll を走らせる

- 概要: continuation 専用 queue を持たず、daemon に追加の高頻度 (例: 5 秒間隔) poll を 1 つ持って Status の差分を検出する
- 採用しなかった理由:
  - daemon 全体の rate limit / API call 量が数倍に膨らむ (Issue #85 の対象は「直前に dispatch 完了した Issue のみ」なのにオーバーキル)
  - 既存 `polling.interval_ms` 設計と二重化する複雑度
  - retry queue を持つ前提の Snapshot API / log 設計を再利用できない

### 選択肢 B: 通常 candidate selection に頼り、continuation を独立機能として作らない

- 概要: success 後に何もしない。次 tick の candidate selection が `Todo` / `In Progress` 状態の Issue を再 pick する既存挙動に任せる
- 採用しなかった理由:
  - polling.interval_ms = 30 秒だと Status 更新漏れの体感修復に最低 30 秒かかる (Symphony は 1 秒)
  - fresh selection 経由のため、ログ上「retry である」と区別できない (運用上「なぜこの Issue が再 dispatch されたのか」を遡るのが難しい)
  - 二重 dispatch ガードは worktree 存在しか見ないため、worktree cleanup 済みの直後に競合 dispatch される race が残る

### 選択肢 C: `Status` を orchestrator 側で flip する (agent 委譲を一部ロールバック)

- 概要: success exit を観測したら orchestrator が `In Progress → In Review` を書き戻すことで Status 更新漏れを解消する
- 採用しなかった理由:
  - ADR-0005 「Status は agent が書く」を破壊する
  - PR 作成成否 / Acceptance Criteria 達成判定を orchestrator が再実装する必要があり、agent 委譲型の利点が消える

### 選択肢 D: continuation 専用の `agent.continuation_retry_*` config を新設する

- 概要: `agent.max_continuation_attempts` / `agent.continuation_delay_ms` を設けて failure と独立に設定可能にする
- 採用しなかった理由:
  - MVP の現時点では separate counter のロジックがあれば十分で、cap 値を別にしたい強い要件は出ていない
  - config が増えると運用初学者の認知負荷が上がる
  - 別 PR で安全に追加できる (`max_retry_attempts` を default fallback にすれば後方互換性を保てる)
