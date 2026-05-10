# ADR-0010: retry exhausted (kind=failure) 時に orchestrator が safety-net として GitHub Projects Status を Failed へ遷移し Issue にコメントする

- **ステータス**: Accepted
- **決定日**: 2026-05-11

---

## コンテキスト

ADR-0005 で「orchestrator は GitHub に書き込まない (Status 遷移 / PR 作成 / Issue コメントは agent に委譲する)」方針を確定した。通常 flow ではこの方針で問題ないが、agent / runner 自体が `runner_error` / `timeout` / `stalled` / `hook_failed` / `workspace_provisioning` で失敗するケースでは、agent 自身に後処理を任せられない。

ADR-0008 で導入した in-memory retry queue は、これらの失敗を指数バックオフで自動 retry するが、`agent.max_retry_attempts` に到達して `kind=failure` の retry が exhausted した時点では、agent はもはや起動されない (= Status flip / Issue コメントの担い手が居ない)。

Issue #86 では「failure-summary.md と構造化ログだけ残す。Issue comment / Status は行わない」と決め、ADR-0005 方針との整合を優先した。その結果、運用上は以下の問題が発生している。

- retry exhausted 後も Project board 上は `In Progress` のまま残り、運用者から見ると philharmonic がサイレントに停止したように見える
- 復旧手順 (failure-summary.md / 各種 log の path / worktree path / 手動 retry コマンド) が `.philharmonic/runs/<run-id>/failure-summary.md` にしか残らず、Issue 単体を見ても気付けない
- 実例として #89 では Claude 側 limit による `runner_error` で `In Progress` 残りが発生し、手動 worktree cleanup と Status 戻しが必要になった

retry-queue.md の Open Questions では「ADR-0005 方針を覆すため、新 ADR で別途検討する」と記している。本 ADR はその新 ADR にあたる。

## 決定

retry queue が `kind=failure` の exhaustion を検知した瞬間に限り、**例外的に** orchestrator が GitHub へ最小限の書き込みを行う。具体的には以下 2 件のみ。

1. Project Item の Status field を `status_transitions.failed` (default `Failed`) に書き換える (既存 `updateProjectItemStatus` を再利用)
2. Issue にコメントを 1 件投稿する。本文には run id / failure reason / retry attempt / failure-summary path / summary path / stream path / stderr path / branch / worktree path / 手動復旧手順を含め、先頭に `<!-- philharmonic-run-failed:run_id=<lastRunId> -->` HTML コメントマーカを付ける

ADR-0005 の「orchestrator は GitHub に書き込まない」原則の例外として位置付け、以下の制約を厳格に守る。

### 1. trigger は `kind=failure` の exhaustion 1 点のみ

- `kind=continuation` の exhaustion では **書かない**。これは「失敗」ではなく「success 後 Status flip 漏れの上限到達」であり、agent / 運用者の関与が前提のため
- 通常 dispatch / fresh failure / retry 中の attempt 失敗 (= まだ schedule 続行) では **書かない**
- recovery 経路で `kind=failure` exhaustion が発生した場合は schedule path と同じ扱いで書く

### 2. 重複 notify を防ぐ

- Issue コメントには `<!-- philharmonic-run-failed:run_id=<lastRunId> -->` marker を必ず先頭行に含める
- 投稿前に `gh issue view <num> --json comments` で既存コメントを取得し、同じ run id の marker がいずれかのコメントに含まれていれば skip する
- run id は exhaustion 時点で確定済みで一意なため、同じ run の二重 notify は構造的に発生しない
- 既存コメント取得自体が失敗した場合は「skip + warn」で安全側に倒す (Issue 完了条件「重複コメントしない」を最優先)

### 3. 書き込み失敗は warn ログで吸収する

- Status 更新 / 既存コメント取得 / Comment 投稿の 3 操作はそれぞれ独立に try/catch する
- いずれが失敗しても orchestrator は throw せず serve を継続する
- 失敗時は構造化ログに `failed status update on exhaustion` / `failed comment on exhaustion` を warn で 1 行残す
- Status 更新が失敗しても Comment 投稿は試みる (逆も同じ)

### 4. 認証経路は agent と同じ (`gh` CLI / env)

- 新規モジュール `src/orchestrator/exhaustion-notify.ts` は `GhRunner` を DI で受け取り、`gh project field-list` / `gh project item-edit` / `gh issue view` / `gh issue comment` を呼ぶ
- 既存 `src/projects/status-update.ts` の `updateProjectItemStatus` をそのまま再利用する
- `serve.ts` で `defaultGhRunner` を `runOnce` / `runConcurrent` に追加 DI として渡す。`philharmonic run` (1 ターン CLI) では runner 未注入 = safety-net 無効 (= 旧挙動互換)
- GitHub token は ADR-0005 §3 と同じく `GITHUB_TOKEN` / `GH_TOKEN` を env から透過、または host の `gh auth` で解決する

### 5. notify body は failure-summary.md をベースに最小再構築する

- HTML コメントマーカ (`<!-- philharmonic-run-failed:run_id=... -->`) を先頭行に置く
- Summary table (Issue / final attempt / max attempts / last failure reason / last run id / branch / workspace path / exhausted at)
- Run artifacts への相対 path (failure-summary.md / summary.md / stream.jsonl / stderr.log)
- 手動復旧手順 (`philharmonic retry #<num>` ほか)
- `gh issue comment --body-file` で渡す (`--body` の shell 引数渡しは改行 / markdown / 引用符で壊れやすいため)
- body file は `<runnerLogsRoot>/<runId>/issue-comment.md` に書き出して再利用可能にする

### 6. 失敗 reason に依らず常に Failed に倒す

Issue 本文に列挙されている `runner_error`, `timeout`, `stalled`, `hook_failed`, `workspace_provisioning` は現行 `FailureReason` の全件と一致する。reason 別に Status 遷移先を分けない (= 常に `status_transitions.failed`)。reason 情報は Issue コメント本文に残るため、Status 側で詳細を分割する必要はない。

## 結果

### 良い結果

- retry exhausted 後の Project board が `In Progress` のまま残らず、運用者が一目で「自動 retry を諦めた Issue」を識別できる
- Issue 単体を見るだけで復旧に必要な情報 (run id / log path / worktree / 手動 retry コマンド) が揃う
- failure-summary.md と構造化ログだけでは気付けなかった「サイレント停止」問題が解消される
- 既存の通常 success / failure (まだ schedule 続行) flow には一切手を入れないため、ADR-0005 の「state ownership を agent 側に」方針は維持される

### トレードオフ・悪い結果

- ADR-0005 の「orchestrator は GitHub に書き込まない」原則を一点だけ破る。将来 ADR を読む人が「ここは例外」を理解する必要がある
- token / `gh` CLI 認証が serve 自身にも必要になる。ADR-0005 §3 で既に runner に渡している経路と共用するため追加 surface は無いが、orchestrator が直接書き込む先 (issue / project) は fine-grained PAT の scope 設計に含める必要がある
- 大きな失敗 (= retry exhausted) のタイミングで `fetchProjectContext` / `gh project field-list` / `gh issue view` / `gh issue comment` の 4 系統の追加 API call が発生する。retry exhausted は本質的に稀なので rate limit 影響は無視できる

### 影響を受けるコンポーネントや今後の作業

- 新規 module: `src/orchestrator/exhaustion-notify.ts` (Status 更新 + comment 投稿 + dedup)
- `src/orchestrator/run.ts`: `processDispatchFailureForRetry` の exhaustion branch で `notifyFailureExhausted` を呼ぶ。`RunOnceDeps` / `RunConcurrentDeps` に `runGh?: GhRunner` を追加
- `src/cli/serve.ts`: `defaultGhRunner` を `runOnce` / `runConcurrent` / `recoverInProgress` に DI 経由で渡す
- spec 更新: `docs/specs/retry-queue.md` の Failure summary on exhaustion / Open Questions / MVP でやらないこと
- recovery 経路 (`recoverInProgress`) も同じ exhaustion path に乗るため自動的に safety-net が効く
- `philharmonic run` (1 ターン CLI) は runner 未注入で no-op を維持 (既存挙動互換)

## 検討した他の選択肢

### 選択肢 A: ADR-0005 を維持して spec 上で「failure-summary.md と構造化ログのみ残す」現状継続

- 概要: 何も変えない。運用者は構造化ログを監視する責任を持つ
- 採用しなかった理由:
  - #89 の実例で運用上の問題が顕在化しており、「ログを見ない / 気付かない」運用者の負担を解消できない
  - Issue 単体を見ても気付けないため、外部レビュアー (= Issue 起票者) も状態を確認できない

### 選択肢 B: failure reason 別に異なる Status (`Failed` / `Stalled` / `Timeout` 等) へ遷移する

- 概要: `status_transitions.failed` のほかに reason 別のオプションを追加する
- 採用しなかった理由:
  - Project board に reason 別の Status option を作る運用負荷が増える
  - reason 情報は Issue コメント本文に残るため、Status 側で分割する意義が薄い
  - config schema の複雑化を避ける (現状 `status_transitions: { in_progress, in_review, failed }` の 3 key のみ)

### 選択肢 C: agent に exhaustion 通知を頼む (agent 起動を 1 回追加する)

- 概要: retry exhausted を検知したら最後にもう 1 回だけ agent を起動し、`Failed` flip + Issue コメントを agent に依頼する
- 採用しなかった理由:
  - そもそも retry exhausted は「agent / runner が連続失敗した」状況。同じ agent 起動経路が成功する保証がない
  - 失敗 reason が `workspace_provisioning` / `hook_failed` のとき agent 起動以前で死んでいるため、agent を呼ぶこと自体ができない
  - 追加 dispatch tick の slot を消費し、他の Issue を遅延させる副作用がある

### 選択肢 D: GraphQL で直接 Status を書く (Octokit GraphQL 経由)

- 概要: `updateProjectV2ItemFieldValue` mutation を Octokit から直接叩く
- 採用しなかった理由:
  - 既存 `updateProjectItemStatus` が `gh project item-edit` 経由で実装済みで、`philharmonic retry` (#88) と同じ経路を再利用できる
  - `gh` CLI 経由のほうが agent (ADR-0005) と認証経路を統一でき、運用者が手で再現しやすい
  - GraphQL を直接叩くなら projectId / fieldId / optionId の解決ロジックを別途実装する必要がある (`gh project field-list` 相当)
