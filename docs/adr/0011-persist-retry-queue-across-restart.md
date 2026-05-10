# ADR-0011: retry queue を local state file に永続化し serve 再起動を跨いで retry を継続する

- **ステータス**: Accepted
- **決定日**: 2026-05-11

---

## コンテキスト

[ADR-0008 §3](./0008-in-memory-retry-queue.md#3-retry-queue-は-in-memory-only永続化しない) は、`philharmonic serve` の retry queue を **in-memory only** とし、daemon 再起動で消えるのは「次回 `serve` 起動時の recovery が `In Progress` の Item を引き取る既存経路」に委ねる、と決めていた。これは ADR-0005 の「永続 retry-state は持たない」方針との整合を優先した判断だった。

しかし [ADR-0010](./0010-retry-exhaustion-github-safety-net.md) で `kind=failure` の retry exhausted 時に Project Status を `Failed` に倒し Issue にコメントする safety-net を入れ、retry attempt counter が exhaustion 判定の唯一の入力になった。in-memory only のままだと以下の現実的な失敗モードが残る:

- runner failure 後に retry 待機中だった Issue がある状態で daemon が再起動すると、attempt counter が 0 にリセットされる
- Project Status が `In Progress` のまま再起動した場合は recovery が引き取るが、attempt=0 から再開するため、本来 exhausted 直前だった Issue が運用上不可視に「やり直し」になる
- daemon の頻繁な再起動 (デプロイ更新 / クラッシュ) を跨いで「どの run が何回 retry されたか」が log を時系列に追わないと分からない

ADR-0008 §3 は「永続 fs を介した cross-process race condition が発生しない」のメリットを挙げていたが、`serve.lock` で single daemon process を強制している以上、retry queue ファイルへの並行書き込みは構造的に発生しない (cross-process race は起きない)。

ADR-0005 §8 の「永続 retry-state は持たない」は **Status 書き戻し駆動の旧 RetryScheduler** に対する撤廃であって、本 ADR の永続化対象は **agent に Status 書き換えを委ねたままで attempt counter だけを跨ぐ** スコープに限定される。orchestrator が Status を書く責務に戻るわけではない。

## 決定

ADR-0008 §3 の「永続化しない」決定を **本 ADR で supersede** する。retry queue を `<repoRoot>/.philharmonic/state/retry-queue.json` に永続化し、serve 再起動後も retry entry を復元可能にする。

### 1. state file の配置と schema

- パス: `<repoRoot>/.philharmonic/state/retry-queue.json` (固定)
- schema は将来変更に備えて `version` field を持つ
- 現行 version は `1`。schema が破壊的に変わる場合は version を上げ、古い version は warn + empty queue で起動する

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

`Map<issueNumber, RetryEntry>` の中身を network byte order なく直接 JSON にする。`Date` は ISO 8601 文字列で persist する。

### 2. atomic write と save の直列化

queue の mutation (schedule / remove / drainDue / reschedule) が走るたびに in-memory state を JSON dump し、以下の手順で disk に書き出す。

1. `<state.json>.tmp` に payload を書く
2. `rename(tmp, state.json)` で atomic swap
3. mkdir は recursive で `.philharmonic/state/` を作る (初回起動向け)

複数の mutation が立て続けに発生したとき、async write の完了順が逆転すると古い snapshot で上書きされかねないため、内部で **直列化** する。具体的には `lastWrite = lastWrite.then(() => doWrite(payload))` の chain で前の write が終わってから次を始める。

save が失敗した場合 (disk full / 権限不足) は warn ログを 1 行残し、**in-memory state はそのまま保持** する。後続 mutation の再 save で復帰する可能性があるため orchestrator 本体は throw しない (= degraded behavior)。

### 3. drainDue 後の永続化境界

`drainDue` は entry を queue から取り出した時点で **queue が「entry を持たない」状態** を save する。dispatch の結果 (success / failed) が出るまでの window で process が落ちると、disk 上にも in-memory にも entry が消えた状態になり attempt counter が失われる。

この window は許容する。次回 serve 起動時の recovery が `In Progress` として拾い、`scheduleRetryAfterRecovery` の中で **既存 persisted entry が無ければ attempt=1 から始める** という既存挙動が degraded fall-back として機能する。drain 直前まで dispatch が成功していれば retry queue は空のまま (or schedule で再書き換え) なので情報損失はない。

### 4. recovery 経路での attempt counter 継続

recovery 経路 (`recoverInProgress` / `scheduleRetryAfterRecovery`) は failed 時に retry queue へ schedule する設計だが、既存実装は **常に `attempt = 1`** で書き戻す ([recovery.ts:354](../../src/orchestrator/recovery.ts))。

本 ADR では完了条件「attempt / dueAt / failureReason / lastRunId / branch / workspacePath が維持される」を満たすため、recovery schedule 前に `retryQueue.list()` で既存 entry を引き、見つかれば `attempt + 1` で継続する (kind が一致するときのみ。kind が違えば 1 リセット = 既存 spec 通り)。

これにより serve 起動 → recovery が同 Issue を再 dispatch して fail → persisted attempt=3 を 1 に潰す事故が起きない。

### 5. 復元後の release 条件

serve 起動時の load 直後、entry を queue に積み戻したうえで以下の release 判定を **1 回だけ** 行う。失敗時は warn ログを 1 行残して queue に残置する (= 次の drain tick が拾う degraded fall-back)。

- `getIssue` で `state === 'closed'` → 落とす + `retry skipped reason=closed via=restore` info ログ
- `listOpenPullRequests` (head branch prefix `feature/<issueNumber>-`) で 1 件以上 → 落とす + `retry skipped reason=open_pr via=restore` info ログ
- terminal status (`In Review` / `Failed`) と inactive status は **既存の `drainRetryQueue` が drain phase で再確認** するため、本 ADR の restore phase では再現しない (drain の重複削減)

open PR の特殊性: agent が PR は作ったが Status flip 前という稀ケースで残骸 retry を発射しないための safety-net。`drainRetryQueue` には毎 tick で open PR を fetch するコストを掛けない (= 復元時のみの一度きり)。

### 6. invalid / 古い entry の取り扱い

state file の整合性チェックは load 時に行う。failure mode 別の degraded behavior は以下。

| 状況                       | 挙動                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| file 不在                  | empty queue で起動 (情報ログを 1 行残す程度に留める)                                                                              |
| JSON parse 失敗            | warn `retry queue restore parse failed` 1 行 + `<state.json>.bak` に rename + empty queue で起動 (運用者が後で復旧できるよう退避) |
| `version` mismatch         | warn `retry queue restore version mismatch` 1 行 + empty queue で起動 (bak には rename しない: 既知の未対応 version は破棄が安全) |
| entry 単位の schema 違反   | その entry のみ skip + warn `retry queue restore entry invalid` 1 行 (issueNumber / 原因)。残りの entry は採用                    |
| entry 単位の field 欠落 等 | 上記と同じく entry 単位 skip                                                                                                      |
| 重複 `issueNumber`         | 最後に出現したものを採用 (Map 上書きの自然挙動)                                                                                   |

JSON parse 失敗時に `.bak` リネームを行うのは、不正 state を破棄しつつ運用者の後解析を可能にするため。version mismatch は **既知の非互換** なのでリネームせず empty 起動で十分。

### 7. observability

新規 / 更新する構造化ログ:

| level | msg                                    | fields                                                                            |
| ----- | -------------------------------------- | --------------------------------------------------------------------------------- |
| info  | `retry queue restored`                 | `path`, `count`, `version` — load 成功時 1 行                                     |
| info  | `retry queue restore empty`            | `path` — file 不在で empty 起動した場合                                           |
| warn  | `retry queue restore parse failed`     | `path`, `backupPath`, `error`                                                     |
| warn  | `retry queue restore version mismatch` | `path`, `version`, `expected`                                                     |
| warn  | `retry queue restore entry invalid`    | `index`, `issueNumber` (取れたら), `reason` (`missing_field` / `invalid_type` 等) |
| warn  | `retry queue persist failed`           | `path`, `error` — atomic write が throw した                                      |
| info  | `retry skipped` `reason=open_pr`       | 既存 retry skip ログに `reason=open_pr` を 1 種追加。`via=restore` を併記する     |

Snapshot API には新 field を増やさない: 復元された entry は in-memory entry と区別なく `list()` 経由で見える。

### 8. 影響範囲 / non-goal

- 永続化スコープは **retry queue のみ**。run tracker や dependency tracker は対象外
- multi-host 共有は引き続き out-of-scope (single daemon `serve.lock` の前提を維持)
- `philharmonic run` (1 ターン CLI) は retry queue を持たないため store も無効 (file は触らない)
- 旧 `RetryScheduler` (Status 書き戻し駆動) の復活ではない: orchestrator は引き続き Status を書かない

## 結果

### 良い結果

- daemon 再起動 / クラッシュ / デプロイ更新を跨いで attempt counter が維持される (= ADR-0010 の Failed safety-net が安定する)
- 「いま何件 retry 待ちで、いつ dispatch される予定か」が `<repoRoot>/.philharmonic/state/retry-queue.json` を `cat` するだけで人間にも見える運用 UX
- recovery 経路の attempt 継続が直感通りになる (= 既存挙動の不整合を修正)

### トレードオフ・悪い結果

- write が mutation あたり 1 回発生する (ローカル fs / atomic rename, 数 KB 程度なので overhead は無視できる範囲だが zero ではない)
- ADR-0008 §3 と spec 「MVP でやらないこと」を **本 ADR で supersede** する。古い議論を辿る読者向けに supersede 関係を明記する
- drain → dispatch 間の crash window で attempt が 1 失われ得る (許容、recovery で fall-back)

### 影響を受けるコンポーネントや今後の作業

- spec 更新:
  - `docs/specs/retry-queue.md` — 永続化セクションを追加、「MVP でやらないこと」から削除
  - `docs/guide/operations.md` — state file の位置と削除手順
- code:
  - `src/orchestrator/retry-queue-store.ts` (新規) — load / atomic write
  - `src/orchestrator/retry-queue.ts` — `createRetryQueue` に `store?` / `initialEntries?` 注入、mutation 後の save chain
  - `src/orchestrator/retry-queue-restore.ts` (新規) — open PR / closed の release-on-restore
  - `src/orchestrator/recovery.ts` — `scheduleRetryAfterRecovery` の attempt 継続
  - `src/orchestrator/index.ts` — export 追加
  - `src/cli/serve.ts` — store DI と restore phase の wiring
- ADR cross-ref:
  - `docs/adr/0008-in-memory-retry-queue.md` ステータスに `Superseded by ADR-0011 (§3 のみ)` の補足
  - `docs/adr/0005-thin-orchestrator-agent-delegation.md` §8 の「永続 retry-state は捨てる」は本 ADR と概念的に独立 (Status 駆動 retry の復活ではないため) を文中で明示

## 検討した他の選択肢

### 選択肢 A: JSONL append-only にする

- 概要: `.philharmonic/state/retry-queue.jsonl` に schedule / remove / drain を log として append、起動時に replay する
- 採用しなかった理由:
  - retry queue は entry 件数が高々 `max_concurrent_agents` 程度で、snapshot で書き直す方が file サイズ的にも実装的にも単純
  - replay logic を持つと crash 復旧の不変条件が増える (どの event まで replay 済みかを覚える必要)

### 選択肢 B: 既存 `serve.lock` に retry state を相乗りさせる

- 概要: `serve.lock` の payload に retry entries を含める
- 採用しなかった理由:
  - lock file は二重起動防止という **責務が独立** している。混ぜると lock 取得失敗時のリカバリが複雑になる
  - lock release 時に retry 情報が消える挙動になり、graceful shutdown 後の再起動で逆に retry が失われる

### 選択肢 C: sqlite に切り替える

- 概要: `.philharmonic/state.db` を sqlite で持ち、retry / dependency / tracker を一元管理
- 採用しなかった理由:
  - 依存と運用負荷が増える (Node 22 + ESM の sqlite はネイティブビルドが要る)
  - 永続化したいスコープが retry queue のみで、ファイル 1 つで足りる
  - 将来 multi-host や複数 tracker の永続化が必要になったタイミングで別 ADR で検討する

### 選択肢 D: 永続化せず recovery 経路で attempt を引き継ぐ

- 概要: `In Progress` Item を recovery が拾うときに、`failure-summary.md` 等から attempt を逆算して引き継ぐ
- 採用しなかった理由:
  - failure-summary.md は **exhaustion 時のみ** 書かれるため attempt の SoT にはなれない
  - 「In Progress でなく Todo のまま retry 待機中」のケースは recovery が拾わないため fall-back にならない
  - 結局 attempt の SoT を retry queue 以外に作ることになり責務が分裂する
