# ADR-0008: 失敗 / stalled run を指数バックオフで再 dispatch する in-memory retry queue を導入する

- **ステータス**: Accepted (§3 は ADR-0011 で supersede)
- **決定日**: 2026-05-10

---

## コンテキスト

ADR-0005 で「対話的 state を agent に集約する」方針に倒した結果、Philharmonic 本体 (orchestrator) は以下の自動 retry 機能を持たなくなった ([ADR-0005 §8](./0005-thin-orchestrator-agent-delegation.md#8-retry-state-は撤廃))。

- 旧 `RetryScheduler` (`.philharmonic/retry-state.json` で永続化) が `Failed → Todo` に Status を **書き戻す** 駆動
- prompt template の `attempt` 変数

これは「Status は agent が書く」設計と整合させるための決定であり、本 ADR でも **永続 + Status-driven な retry** を復活させない方針は維持する。

しかし運用すると、`philharmonic serve` が稼働中に以下のような **agent が Status を flip する前に死ぬ** 失敗モードがほぼ毎日発生する。

- runner の異常終了 (subprocess crash / network blip / Claude API の一時的なエラー)
- runner の timeout / stalled (stdout が無音のまま `agent.stall_timeout_ms` を超過)
- workspace provisioning 失敗 (一過的な disk full / git fetch failure)
- `before_run` / `after_run` hook の一過性失敗

これらのケースでは、orchestrator が `dispatchSelected` 段階で `failed` を返し、worktree は debug 用に保持される ([ADR-0005 §7](./0005-thin-orchestrator-agent-delegation.md#7-worktree-cleanup-の-trigger-簡素化))。Project Status は agent が flip 前に死んだため `In Progress` のまま (or `Todo` のまま)、自動回復は **次回 `serve` 起動時の recovery** ([orchestration-mvp.md#tracker-driven-recovery-serve-起動時](../specs/orchestration-mvp.md#tracker-driven-recovery-serve-起動時)) に頼るしかない。

つまり長時間稼働の daemon でも一過性の失敗で `In Progress` worktree が雪だるま式に増え、人間が手動で `serve` を再起動して recovery を回す必要がある。これは Symphony との UX 差分が最も大きい部分のひとつでもある (Symphony は worker abnormal exit / stall を `10s * 2^(attempt-1)` の指数バックオフで自動再試行する)。

本 ADR は、ADR-0005 の「Status 書き換えは agent」「永続 retry-state は持たない」方針を **維持したうえで**、daemon プロセス内に **in-memory な retry queue** を 1 つ持ち、内部失敗起因の失敗を自動再 dispatch するメカニズムを追加する。Status 駆動でも永続でもないため、ADR-0005 §8 とは概念的に独立な追加機構である (§8 は **撤廃のまま**)。

## 決定

### 1. retry の対象は「orchestrator の内部失敗」に限定する

`dispatchSelected` の戻り値が `failed` で、かつ `failureReason` が以下のいずれかのときのみ retry queue に積む。

- `workspace_provisioning`
- `runner_error`
- `timeout`
- `stalled`
- `hook_failed`

これらは **orchestrator が観測できる失敗モード全件** ([orchestration-mvp.md エラーハンドリング表](../specs/orchestration-mvp.md#エラーハンドリング)) と一致する。区別を入れずに「failed なら retry」とした理由は、保守的に「人間 / agent が `Failed` flip するまで全て一過性とみなす」のが Symphony の設計とも揃うため。

agent 側で Status を `Failed` に flip した Issue は、retry 前の Status 再取得 (本決定 §4) で `inactive_status` として捨てられる。orchestrator が再 dispatch を続けて agent の判断を上書きすることはない。

### 2. backoff は `10s * 2^(attempt-1)` を `agent.max_retry_backoff_ms` で clamp する

Symphony と同じ指数バックオフ式を採用する。

```
delayMs(attempt) = min(10_000 * 2^(attempt - 1), max_retry_backoff_ms)
```

| `attempt` | 計算値  | clamp (default 300_000) |
| --------- | ------- | ----------------------- |
| 1         | 10_000  | 10_000                  |
| 2         | 20_000  | 20_000                  |
| 3         | 40_000  | 40_000                  |
| 4         | 80_000  | 80_000                  |
| 5         | 160_000 | 160_000                 |
| 6         | 320_000 | 300_000 (clamp)         |
| 7         | 640_000 | 300_000 (clamp)         |

`attempt` は **retry 試行番号** (1-indexed)。初回 dispatch は `attempt=0` 扱いで queue に入らない。初回失敗で attempt=1 が `dueAt = now + 10s` で積まれ、attempt=1 が再失敗すれば attempt=2 が `now + 20s` で積み直される。

retry 上限 (`agent.max_retry_attempts`) を超えたら queue から落とし、`retry exhausted` (warn) ログを 1 行出すだけで、Status は **触らない**。後続の処理は人間 / agent / 次回 recovery に委ねる。

base delay (10s) を config 化はしない: Symphony との UX 揃えを優先し、調整の必要性が見えてから別 ADR で考える。`max_retry_backoff_ms` と `max_retry_attempts` は config 化する (本決定 §6)。

### 3. retry queue は **in-memory only**。永続化しない (ADR-0011 で supersede)

> **更新 (2026-05-11)**: ADR-0011 で本節を supersede し、`.philharmonic/state/retry-queue.json` に永続化する方針に変更した。永続化対象は **retry queue の attempt counter のみ** で、ADR-0005 の「Status は agent が書く」方針は維持される。以下は元の議論として残す。

retry entry は `philharmonic serve` プロセスの daemon-lifetime のみで存在する。

- daemon が再起動 (SIGTERM / クラッシュ) すれば queue は失われる
- 失われた retry は **次回 `serve` 起動時の recovery で拾う** (Status が `In Progress` のままの Item を引き取る既存経路)
- 永続ファイル (`.philharmonic/retry-state.json` 等) は **作らない**。ADR-0005 で「永続 retry-state を捨てる」と決めた方針は維持する

これにより:

- (a) retry queue と Status 書き換えの責務が再分裂する事故が起きない (orchestrator は Status を読むだけ、書かない)
- (b) 永続 fs を介した cross-process の race condition が発生しない (single daemon process が in-memory に持つだけ)
- (c) 既存の recovery 経路が「daemon 跨ぎの retry」の役割を引き受ける (daemon が落ちなければ in-memory queue が引き受ける)

### 4. 各 retry の **dispatch 直前** に Issue / Project Status を再取得する

retry queue から `dueAt <= now` の entry を pop した直後、`dispatchSelected` を呼ぶ前に以下の検証を行い、合格したものだけ dispatch する。

| 状態                                                   | 判定                                       | アクション                                                                                       |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Issue `state === 'closed'`                             | terminal                                   | drop (`retry skipped` info, `reason: closed`)                                                    |
| Project Status が `dispatch_statuses` に含まれる       | active (Todo 等)                           | re-dispatch                                                                                      |
| Project Status が `status_transitions.in_progress`     | active (recovery と同等)                   | re-dispatch                                                                                      |
| Project Status が `status_transitions.in_review`       | agent が PR 作成成功                       | drop (`retry skipped`, `reason: terminal_status`)                                                |
| Project Status が `status_transitions.failed`          | agent / 人間が明示的に Failed              | drop (`retry skipped`, `reason: terminal_status`)                                                |
| Project Status が `Done` / その他                      | inactive                                   | drop (`retry skipped`, `reason: inactive_status`)                                                |
| 同一 Issue が `runTracker.getRunningByIssue` で run 中 | 並列 dispatch 衝突 (recovery とのレース等) | re-schedule (1 attempt 加算せず) — Issue #84 AC「retry 中は同一 Issue が重複 dispatch されない」 |

「`dispatch_statuses` ∪ `status_transitions.in_progress`」を許容範囲とするのは、recovery が `In Progress` を引き取る既存挙動と整合させるため (orchestration-mvp.md §Tracker-driven Recovery)。

`getIssue` / `fetchProjectCandidates` の追加 GitHub API call が retry 1 件あたり 1 〜 2 回発生する。tick あたりの retry 件数は `agent.max_concurrent_agents` を超えないため許容範囲とする (rate limit が懸念されるなら `agent.max_concurrent_agents` を下げる運用で対処)。

### 5. retry 経路は **worktree を force reset してから** `dispatchSelected` を呼ぶ

`dispatchSelected → markFailed('runner_error', ...)` の後 ([ADR-0005 §7](./0005-thin-orchestrator-agent-delegation.md#7-worktree-cleanup-の-trigger-簡素化)) は worktree を保持する。retry queue から再 dispatch する際、`createWorkspace({ reuse: false })` は path / branch 衝突で `WorkspaceConflictError` を throw する (`src/workspace/manager.ts:103-138`)。

そのため retry 経路では recovery (`recoverInProgress`) と同じパターンで:

1. `cleanupWorkspace({ taskKey, branch, deleteBranch: true })` を呼んで worktree とローカルブランチを削除
2. その後 `dispatchSelected` を呼ぶ (内部で `createWorkspace({ reuse: false })` が新規 worktree を作る)

この cleanup を retry queue 側でなく `dispatchSelected` の中に隠さない理由:

- 「retry / recovery は worktree を force reset」「通常 dispatch は衝突したら fail」は **意図的に異なる挙動** (通常 dispatch は人間が掃除すべき残骸を上書きしないように衝突 fail にする設計)
- 呼び出し元 (retry queue / recovery) が cleanup の責任を持つ方が SoT が明確

### 6. config 追加

`agent.max_retry_attempts` と `agent.max_retry_backoff_ms` を新設する。両 key とも default あり。

```yaml
agent:
  max_retry_attempts: 5 # default 5。0 なら retry 無効
  max_retry_backoff_ms: 300000 # default 5min
```

| キー                         | 型               | 必須 | デフォルト | 説明                                                                      |
| ---------------------------- | ---------------- | ---- | ---------- | ------------------------------------------------------------------------- |
| `agent.max_retry_attempts`   | `integer (>= 0)` | no   | `5`        | 1 つの Issue が retry queue に積み直される最大回数。`0` で retry 機能 off |
| `agent.max_retry_backoff_ms` | `integer (>= 1)` | no   | `300000`   | `10s * 2^(attempt-1)` の clamp 上限 (ms)                                  |

`0` を retry 無効として扱う設計上、`agent.max_retry_attempts` は `nonnegative()` (>= 0) を許容する。`agent.max_retry_backoff_ms` は `positive()` (>= 1) — 0 にする意味がないため。

### 7. tick の中での retry の扱い

`philharmonic serve` の poll tick は以下の順序で動く。retry が「fresh candidate より先に slot を消費する」のは、Symphony と同じく「pending な失敗の再試行を最優先で消化する」という運用直感のため。

```
each tick:
  1. retry queue から dueAt <= now の entry を pop (FIFO)
  2. 各 retry entry について:
       - Issue / Project Status を再取得して active 判定 (本決定 §4)
       - active なら dispatch 用 task に積む。drop 判定なら queue から落とす
  3. retry tasks の件数 = M。残り slot = max(0, max_concurrent_agents - M)
  4. 残り slot 件数だけ通常の candidate selection を呼ぶ (既存の dispatch_statuses / dependency filter / 二重 dispatch ガード)
  5. retry tasks + fresh tasks を `dispatchPool` に投入し Promise.allSettled で待つ
  6. 各 dispatch 結果について:
       - failed (retry-eligible) かつ attempt < max_retry_attempts → retry queue に再 schedule
       - failed (retry-eligible) かつ attempt == max_retry_attempts → drop (`retry exhausted` warn)
       - その他は何もしない
  7. sleep
```

`max_concurrent_agents == 1` の互換: retry が常に最優先のため、retry が pending なら fresh candidate は dispatch されない (= 1 tick 1 issue の互換挙動を保ちつつ retry も走る)。

通常 dispatch のロジックは変更しない: 「retry queue に居る Issue を fresh candidate selection が拾わない」のは、retry 中は worktree が cleanup → 再作成中 (= 一時的に存在しない瞬間がある) でも、二重 dispatch ガード (`runTracker.getRunningByIssue`) が in-flight になった時点で同 Issue を弾く。同 tick 内では retry tasks が先に slot を取り、`runTracker.runStarted` を呼ぶため、fresh candidate selection が動く時点では既に in-flight tracker に積まれている。

### 8. recovery 経路にも retry queue を渡す

`recoverInProgress` (`src/orchestrator/recovery.ts`) で `dispatchSelected` を呼んだ結果が `failed` のとき、retry queue が渡されていれば本 ADR の retry 規則で **同様に schedule する**。recovery 後に start する `serveLoop` で在庫として消化される。

これを忘れると「再起動して recovery で 1 回試して再失敗 → 何も起きない」という dead end になり、daemon が稼働中の他失敗との挙動差が大きくなる。

### 9. observability

retry の進行は **structured log** と **Snapshot HTTP API** の両方で見える化する (Issue #84 AC「retry attempt / next retry time / last error がログまたは status snapshot から確認できる」)。

structured log (詳細は spec [retry-queue.md](../specs/retry-queue.md)):

| level | msg               | 主な fields                                                                                                 |
| ----- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| info  | `retry scheduled` | `issueNumber`, `attempt`, `dueAt`, `delayMs`, `reason`, `lastRunId`                                         |
| info  | `retry due`       | `issueNumber`, `attempt`, `lastRunId`                                                                       |
| info  | `retry skipped`   | `issueNumber`, `attempt`, `reason` (`closed` / `terminal_status` / `inactive_status` / `tracker_in_flight`) |
| warn  | `retry exhausted` | `issueNumber`, `attempt`, `reason`, `lastRunId`                                                             |

Snapshot HTTP API: `/api/v1/state` の response に `retry_queue` field を追加する。`scheduler` と同じく **optional** (古い serve に対して dashboard / 外部 client が安全に fall-back できるように null も返す)。詳細フィールドは `docs/specs/snapshot-api.md` の改訂で確定。

TUI dashboard (ADR-0006) への表示は本 ADR の範囲外。後続 PR で `retry_queue` field を購読する section を追加する。

## 結果

### 良い結果

- 一過性の `runner_error` / `timeout` / `stalled` / `hook_failed` / `workspace_provisioning` で daemon が手当無しに止まる体感がなくなる (Symphony 互換の自動回復)
- 永続 retry-state を持たないため、ADR-0005 の「Status は agent が書く」設計と矛盾しない (orchestrator は依然 Status を書かない)
- recovery 経路に統一的に乗るので、daemon 跨ぎでも単発 daemon 内でも回復ロジックが対称になる
- Issue / Project Status を retry 前に再取得するため、人間 / agent が手動で Failed / Done に flip した Issue を orchestrator が無視せず尊重できる

### トレードオフ・悪い結果

- retry 1 件あたり `getIssue` + `fetchProjectCandidates` の追加 GitHub API call が発生する (rate limit を嫌うユーザは `max_retry_attempts: 0` で機能を off にできる)
- daemon が落ちると in-memory queue が消える (= 進行中 retry が失われる)。次回 `serve` 起動時の recovery で拾う設計だが、attempt counter は引き継がれない
- `max_concurrent_agents` の slot を retry が先に取るため、fresh candidate のレイテンシが伸びるケースがある (運用上は retry 件数 << slot 数で無視できる想定)
- 既存ユーザにとって config に新 key が増える (どちらも default あり、未指定でも従来挙動は壊れない)

### 影響を受けるコンポーネントや今後の作業

- spec (新規 / 改訂):
  - `docs/specs/retry-queue.md` — 本機能の単独 spec (新規)
  - `docs/specs/serve-daemon.md` — tick の流れに retry を追記、structured log の表に追記
  - `docs/specs/orchestration-mvp.md` — エラーハンドリング表に retry 影響を追記、Failure / Timeout の扱いを更新
  - `docs/specs/snapshot-api.md` — `retry_queue` field 追加
  - `docs/specs/config-schema.md` — `agent.max_retry_*` を追加
- code:
  - `src/orchestrator/retry-queue.ts` (新規) — in-memory queue + delay 計算
  - `src/orchestrator/run.ts` — `runOnce` / `runConcurrent` に retry drain + schedule を統合
  - `src/orchestrator/recovery.ts` — 失敗時に retry queue に積む (queue 渡されていれば)
  - `src/orchestrator/index.ts` — export 追加
  - `src/cli/serve.ts` — daemon bootstrap で queue を生成、各経路に DI で渡す
  - `src/config/schema.ts` — `agent.max_retry_attempts` / `agent.max_retry_backoff_ms` 追加
  - `src/server/snapshot.ts` — `retry_queue` field
- guide:
  - `docs/guide/operations.md` — retry の運用例と無効化方法
- 後続 (本 ADR 範囲外):
  - TUI dashboard (`src/dashboard/runtime.tsx`) に Retry section 追加
  - 失敗理由ごとに retry 適用可否を絞る (例: `hook_failed` は人間が直すまで retry させない) のような config 拡張

## 検討した他の選択肢

### 選択肢 A: ADR-0005 §8 の旧 `RetryScheduler` (Status-driven, 永続) を復活させる

- 概要: 旧 `.philharmonic/retry-state.json` ベースの retry を再採用し、`Failed → Todo` を orchestrator が書き戻す
- 採用しなかった理由:
  - ADR-0005 で「Status は agent が書く」と決めた中心方針を破壊する。再分裂状態が再発する
  - 永続ファイルへの cross-process 書き込みは race condition / lock の煩雑さを招く (旧実装はそこを十分に解けないまま撤廃された)
  - Issue #84 の Symphony 参照は **Status 書き換えではなく in-memory queue + 指数バックオフ** で達成できる

### 選択肢 B: dispatch 失敗を即座に同 tick 内で再試行する (queue を持たない)

- 概要: `runner_error` / `timeout` で失敗したら、その tick の中で `await sleep(10s); dispatchSelected(...)` を最大 N 回ループする
- 採用しなかった理由:
  - 1 tick の中で長時間 sleep するため、他の Issue の dispatch を待たせる (`max_concurrent_agents` の意味が壊れる)
  - 指数バックオフが時間軸を超えると 1 tick の長さがコントロールできなくなる
  - graceful shutdown (SIGTERM) の応答性が悪化 (sleep 中の中断は出来るが、設計が複雑化)

### 選択肢 C: 永続 queue を独立ファイルで持つ (`.philharmonic/retry-queue.jsonl` 等)

- 概要: in-memory ではなく append-only JSONL にして daemon 再起動を跨いで attempt counter を引き継ぐ
- 採用しなかった理由:
  - Issue #84 のスコープを超える複雑度 (lock / atomic swap / format migration)
  - daemon 再起動跨ぎは既存の `recoverInProgress` が引き受けており、attempt counter が消える代わりに「再起動後は 0 から」という直感的な挙動になる
  - 永続化が欲しくなる規模 (multi-host / 高 SLA) は ADR-0001 の MVP out-of-scope と整合しない。将来要件として別 ADR で検討する

### 選択肢 D: failureReason 別に retry on/off を細かく設定可能にする

- 概要: `agent.retry: { runner_error: true, hook_failed: false, ... }` のような config を入れる
- 採用しなかった理由:
  - 初期実装としては YAGNI (どの reason を off にしたいかは運用してみないと分からない)
  - 全件 retry → Status 再取得で agent / 人間の意図を尊重する設計で既に「不要な retry」は発生しにくい (agent が `Failed` flip すれば retry は止まる)
  - 後付けで追加するのは破壊的変更にならないため、必要になったら別 PR で拡張する

### 選択肢 E: retry を `philharmonic run` (1 ターン CLI) でもサポートする

- 概要: `philharmonic run` は 1 ターン処理して exit するが、その中で retry queue を回す
- 採用しなかった理由:
  - `philharmonic run` は MVP で「1 ターン = 1 Issue を処理して exit」と定義されており、retry 中の sleep / 待機は CLI ユーザの直感に反する (CI / ad-hoc 実行が前提)
  - retry が必要な運用は `philharmonic serve` daemon の領域である ([orchestration-mvp.md MVP でやらないこと](../specs/orchestration-mvp.md#mvp-でやらないこと))
  - CLI には `--retry` flag を将来追加する余地を残せば十分
