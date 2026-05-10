# ADR-0005: Philharmonic を薄い orchestrator に再設計し、Status 遷移 / PR 作成 / Issue コメントを agent に委譲する

- **ステータス**: Accepted
- **決定日**: 2026-05-10

---

## コンテキスト

ADR-0001 で確定した MVP は「state ownership を orchestrator に単一化する」方針を採り、`Todo → In Progress → In Review / Failed` の Status 遷移、PR 作成、Issue コメント投稿のすべてを Philharmonic 本体が担う設計だった。ADR-0003 はこの方針を前提に、Issue body の `## Goal` / `## Constraints` / `## Acceptance Criteria` を必須セクションとして抽出する `parseIssueBody` を Liquid テンプレートと組み合わせて使う構造を確立した。

しかし運用に乗せた結果、以下 2 点が顕在化している。

1. **Issue 本文の構造化制約**: 必須セクションが欠けていると `MissingPromptSectionError` で dispatch が落ちる。想定外の節 (`## Background` / `## Notes` 等) は agent に届かず、prompt がリポジトリの実情と乖離する。
2. **対話的 state を扱えない**: PR feedback sweep / rework / workpad コメント編集のような対話的フローは、agent 側に Status 遷移 / PR 作成 / Issue コメントの権限が無いと完結できない。本家 OpenAI Symphony との大きな差分。

`philharmonic serve` の自動 retry (#22) や recovery (#23) はこの「state ownership を orchestrator に置く」前提に強く依存しており、半端な拡張ではこの 2 点を解消できない。

本 ADR は Philharmonic の責務を **「worktree を作って Claude Code を起動するまで」** に縮小し、Status 遷移 / PR 作成 / Issue コメントは agent (Claude Code + `gh` CLI) が行う **agent 委譲型 (hybrid)** に方針転換する。Issue 本文の構造化制約も撤廃し、自由フォーマットの本文がそのまま agent に渡るようにする。後方互換は維持しない (一括変更)。

## 決定

### 1. 責務分担

| 責務                                          | 担当 (旧 ADR-0001/0003) | 担当 (本 ADR)                           |
| --------------------------------------------- | ----------------------- | --------------------------------------- |
| Project Item の候補選定 (poll)                | Orchestrator            | Orchestrator (変更なし)                 |
| worktree 作成 / fetch                         | Orchestrator            | Orchestrator (変更なし)                 |
| prompt 構築 / Claude Code 起動                | Orchestrator            | Orchestrator (変更なし)                 |
| stream-json / stderr の永続化                 | Orchestrator            | Orchestrator (変更なし)                 |
| **Status `Todo → In Progress` 遷移**          | Orchestrator            | **Agent** (`gh project item-edit`)      |
| **commit / push / PR 作成**                   | Orchestrator            | **Agent** (`git push` / `gh pr create`) |
| **Status `In Progress → In Review`**          | Orchestrator            | **Agent**                               |
| **失敗時の Issue コメント / Status `Failed`** | Orchestrator            | **Agent**                               |
| 起動時の In Progress 引き取り (recovery)      | Orchestrator            | Orchestrator (維持)                     |
| daemon 中の自動 retry                         | Orchestrator            | **撤廃** (agent 側で対話的に)           |

orchestrator は Status field を **読むだけ** (candidate selection 用)、書かない。

### 2. permission_mode は実質 `bypass` 一択

`acceptEdits` (`auto`) は **file edit のみ自動承認** で Bash tool は対話プロンプトが上がる。headless runner では Bash tool が permission denied になり、agent は `gh` / `git push` を呼べない = agent 委譲が成立しない。`--allowedTools` で個別許可する案もあるが、`gh` を許可した時点で実質 bypass 相当の副作用範囲になるため、簡素化を優先して **`bypass` を運用上のデフォルト** とする (Symphony が `--dangerously-skip-permissions` を採用しているのと同じ理由)。

- config schema 上のデフォルトは引き続き `auto` (= 安全側) のままにし、ユーザが明示的に `bypass` を指定する形を維持する
- ADR / spec / guide で「`auto` では agent 委譲が機能しない」ことを明示する
- `philharmonic serve` での `bypass` opt-in env (`PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1`) は維持する

### 3. agent への GitHub 認証経路

agent が `gh` CLI から GitHub に書き込むための認証は、以下 **両方** をサポートする。

- **(a) env 経由 (default 推奨)**: Runner subprocess の env allowlist に `GITHUB_TOKEN` / `GH_TOKEN` を追加する。`gh` CLI は環境変数を自動的に拾う。daemon 用途や CI 用途で確実に動く
- **(b) host の `gh auth` 経由**: `~/.config/gh/hosts.yml` を agent から参照させる。`XDG_CONFIG_HOME` 等は既に allowlist で透過しているため追加変更は不要

env (a) が無くとも host の `gh auth login` 済みなら動作するが、daemon を別ユーザで動かす / コンテナで動かす場合は (a) が確実。

### 4. token と permission_mode の相互作用 (再評価)

旧方針では「Runner には token を一切渡さない」と「`bypass` はホスト全体への副作用」が独立した安全装置だった。本 ADR で token を渡す以上、両者の相互作用を再評価する。

- `bypass` + `GITHUB_TOKEN` の組み合わせは「git worktree 内で agent が GitHub に対しても自由に書き込める」ことを意味する。これは本 ADR の **意図された設計** であり、agent 委譲型に必要な前提
- ただし `bypass` の本質的なリスク (worktree 外 / ホスト全体への副作用) は変わらない。env で渡す token は **対象リポジトリと Project に絞った fine-grained PAT** を強く推奨する
- `philharmonic serve` の `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE` opt-in env は引き続き必須。意図しない長時間連続発火を抑止する

### 5. 同一 Issue の二重 dispatch を防ぐ

旧方針では orchestrator が `Todo → In Progress` を瞬時に flip していたため、次 tick の candidate selection が同一 Issue を再 pick することは無かった。新方針では flip が agent の手に渡るため、agent が flip する前に次 tick (default 30 秒) が来ると同 Issue を再 pick しうる。

candidate selection の最終フィルタとして以下二段ガードを入れる。

- **(a) worktree 存在チェック**: `<workspace_root>/issue-<番号>` が存在すれば skip
- **(b) in-flight tracker チェック**: `runTracker.getRunningByIssue(issueNumber) !== null` なら skip

(a) は cross-process / cross-tick の防御、(b) は同 tick 内の並列 dispatch の防御。両方を `select` 関数の DI で受け取り、どちらかにヒットしたら skip する。

### 6. recovery と「daemon 中の自動救済」の境界

`philharmonic serve` 起動時の recovery (Status が `In Progress` のまま残った Item を引き取って force reset → 再 dispatch) は **維持**。worktree が残っていれば force reset、無ければ新規作成、open PR があれば skip という現行の判定ロジックはそのまま流用する。

一方で **daemon 連続稼働中の自動救済** (runner exit ≠ 0 の後で agent が Failed flip 前に死んだケース) は MVP では行わない。spec に明記したうえで:

- 該当 Item は次回 `serve` 起動時の recovery で拾われる
- それまでに人手で `Failed` または `Todo` に戻す運用も許容する

これは「state を agent 側で完結させる」という本 ADR の方針と整合する (orchestrator が Status を勝手に書かない)。

### 7. worktree cleanup の trigger 簡素化

旧方針では「PR 作成成功 → cleanup」だった。orchestrator は PR が立ったかを知れなくなるため、以下のシンプルルールに倒す。

- runner exit 0 (= `RunResult.status === 'success'`) → cleanup (`git worktree remove --force` + ローカルブランチ削除)
- それ以外 (`failed` / `timeout` / `stalled`) → 保持 (debug 用 / agent が Failed flip し損ねたケースの救済余地)

agent が PR 作成や Status 遷移に失敗しても、`claude` プロセス自体は exit 0 で完了するため cleanup される (= 保持されない)。これは正しい挙動: agent の責務範囲のミスは agent 側のリトライで対処する。

### 8. retry-state は撤廃

`RetryScheduler` / `promoteRetryReady` / `.philharmonic/retry-state.json` / template 変数 `attempt` は **すべて削除**。理由:

- 「対話的 state を agent 側で完結」する以上、retry も agent 領域 (agent が `gh` で `Failed → Todo` に戻すか、人間判断に委ねる)
- 半端に残すと「Status は agent が書くが retry-state は orchestrator が書く」という分裂状態になる
- 既存の retry 実装は In Progress / Failed の Status 駆動を前提としており、agent 委譲型では機能しない

### 8.5. 遷移先 Status 名は config 駆動 (`status_transitions`)

旧 prompt フッタは `In Progress` / `In Review` / `Failed` を文字列固定で埋めていたが、これは **`dispatch_statuses` を config 化している建付け** と矛盾する (Status field 周りはユーザ設定が SoT)。本 ADR 確定後の修正として、`philharmonic.yaml` に `status_transitions: { in_progress, in_review, failed }` を追加し、3 key とも default あり (`In Progress` / `In Review` / `Failed`) で省略可能にする。

- Orchestrator は値を **解釈せず** prompt のフッタとテンプレート変数 `status_transitions.*` にそのまま埋め込む。Project の Status options に該当値が存在することは利用者が担保する (orchestrator 側で fetch / validation はしない)
- agent は埋め込まれた値を `gh project item-edit` の `--single-select-option-id` 解決に使う。invalid なら `gh` がエラーを返し、agent が Issue コメントで失敗を残す経路に乗る
- WORKFLOW.md template でも `{{ status_transitions.in_progress }}` 等で参照可能 (ユーザがフッタを上書きしたいケースでも値を再利用できる)

「config から組み立てる」案 (本案) と「具体名を抜いて agent の自己発見に任せる」案を比較した結果、`dispatch_statuses` と直交する config 駆動が一貫性で勝るため本案を採る (#62 PR レビューで確定)。

### 9. Issue 本文の構造化制約撤廃

`parseIssueBody` / `MissingPromptSectionError` を削除する。Issue body 全文をそのまま agent に渡し、構造化は agent の解釈に委ねる。

WORKFLOW.md (Liquid テンプレート) からも `issue.goal` / `issue.constraints` / `issue.acceptance_criteria` 変数を撤廃する。`issue.body` のみ提供する。

`AGENTS.md` の「Issue 起票」フローと `.github/ISSUE_TEMPLATE/task.md` も追従する (必須セクションを解除し、自由フォーマットに置換)。

### 10. ADR-0001 / ADR-0003 の Superseded 範囲

ADR-0001 の **以下のみ** を本 ADR で Superseded とする (全体の Superseded ではない):

- 「PR 作成は Orchestrator が Octokit REST 経由で行う」
- 「Status 遷移は Orchestrator が GitHub Projects v2 GraphQL 経由で行う」
- 「Runner には GitHub token を一切渡さない (環境変数からも除外)」
- In-scope の「対応 Issue へのリンクを含む Pull Request を作成」「Project Item の Status を更新」

言語 / runtime / pnpm / Octokit / Claude Code subprocess 起動方式 / git worktree per task / `permission_mode: auto / bypass` の枠組みは本 ADR でも生きている。

ADR-0003 の **以下のみ** を本 ADR で Superseded とする:

- Issue body 必須セクション (`MissingPromptSectionError`) の前提
- テンプレート変数 `issue.goal` / `issue.constraints` / `issue.acceptance_criteria`
- テンプレート変数 `attempt` (retry が消えるため)

LiquidJS の採用 / Orchestrator フッタの存在 (テンプレート末尾に無条件で連結する設計) は維持する。フッタの**中身**が「push しない / PR 作らない / token 期待しない / Conventional Commits」から「Status 遷移する / PR を作る / 必要に応じて Issue にコメントする / Conventional Commits」に変わる。

## 結果

### 良い結果

- 想定外の節 (`## Background` / `## Notes` / `## Open Questions` 等) を含む Issue が dispatch 失敗しなくなる
- agent が PR feedback sweep / rework のような対話的フローに踏み込めるようになる (本家 Symphony との差分が縮む)
- orchestrator の責務が大幅に縮小し、コードベースが薄くなる (`format.ts` / `git.ts` / `status.ts` / `retry-promote.ts` / `serve/retry.ts` / `prompt/parse.ts` を削除可能)
- Status field の option 検証 (`In Review` / `Failed` の存在チェック) が不要になり、Project の Status カスタマイズの自由度が増す

### トレードオフ・悪い結果

- agent に GitHub token を渡すことになるため、worktree 外への副作用リスクが増える (本 ADR では fine-grained PAT 推奨で受容)
- daemon 連続稼働中に runner が落ちて agent が Failed flip 前に死んだケースは次回 `serve` 起動まで救済されない (人手介入が必要)
- 二重 dispatch ガードを candidate selection に追加する複雑度が増す (worktree 存在チェック + in-flight tracker チェック)
- 既存の WORKFLOW.md / Issue テンプレートを使っていたユーザは書き換えが必要 (後方互換なし)
- agent が gh / git の使いかたを誤った場合の失敗モードが見えづらくなる (orchestrator の構造化ログだけでは追えず、Issue コメントや run-log の `summary.md` から解釈する必要がある)

### 影響を受けるコンポーネントや今後の作業

- spec: `orchestration-mvp.md` / `prompt-construction.md` / `workflow.md` / `claude-runner.md` / `serve-daemon.md` / `snapshot-api.md` / `config-schema.md` / `observability.md` 全面更新
- code: `src/orchestrator/` / `src/prompt/` / `src/workflow/` / `src/runner/env.ts` / `src/serve/` / `src/cli/` / `src/github/client.ts` / `src/runlog/runlog.ts` を改修・削除
- ガイド: `README.md` / `docs/guide/*` / `.github/ISSUE_TEMPLATE/task.md` 更新
- 後続: 実機検証 (このリポジトリ内で実 dispatch して agent が PR を立てることを確認するスモークテスト) は別 Issue で行う

## 検討した他の選択肢

### 選択肢 A: 既存方針 (orchestrator が Status / PR / コメントをすべて握る) を維持し、Issue 構造化制約のみ撤廃する

- 概要: `parseIssueBody` を「ベストエフォート抽出 (欠けても warn にとどめる)」に緩めるだけ
- 採用しなかった理由:
  - Issue #62 の Goal の片方 (構造化撤廃) は満たすが、もう片方 (対話的 state を agent 側で完結) を満たさない
  - PR feedback sweep / rework といった対話的フローを agent 側で完結できない設計のままになる
  - 本家 Symphony との設計差分が解消されない

### 選択肢 B: 全責務を agent に委譲し、orchestrator は worktree も作らない

- 概要: orchestrator は Project poll + Claude Code 起動だけ。worktree 作成も agent が行う
- 採用しなかった理由:
  - worktree 作成は host の git 状態に対する破壊的操作で、隔離環境を agent に作らせると失敗時の影響範囲が読めない
  - 「Philharmonic を使う最大の旨み」(隔離 worktree が常に出来上がっている) を捨てることになる
  - Issue #62 の Goal の文言「worktree を作って Claude Code を起動するまで」と整合しない

### 選択肢 C: agent に直接 token を渡さず GitHub Apps の installation token を都度発行する

- 概要: orchestrator が runner 起動時に短命 installation token を発行して env で渡す
- 採用しなかった理由:
  - GitHub Apps 化は ADR-0001 で MVP out-of-scope と確定済み (PAT のみ)
  - 本 ADR の範囲外 (将来の hardening として別 ADR で扱う)

### 選択肢 D: permission_mode を `auto` のままにし、`--allowedTools` で `gh` / `git` / `bash` を個別許可する

- 概要: Bash tool 全許可ではなく specific command のみ許可
- 採用しなかった理由:
  - `gh` を許可した時点で実質 bypass 相当の副作用範囲 (`gh` は内部で任意の API call が可能)
  - `--allowedTools` の組み立てが複雑になり、agent が想定外の操作で失敗するエッジケースが増える
  - Symphony は `--dangerously-skip-permissions` をそのまま採用しており、本家との運用差分を増やす意義が薄い

### 選択肢 E: retry-state を残し、agent が Failed flip した後の自動 `Failed → Todo` だけ orchestrator が行う

- 概要: state を半分 agent / 半分 orchestrator に分担する
- 採用しなかった理由:
  - 「Status は agent が書くが retry-state は orchestrator が書く」分裂状態になり、責務境界が曖昧化する
  - agent 側で「これは何回目の試行か」を Issue コメント / PR コメントから読み取って判断できる以上、orchestrator が retry を駆動する意義が小さい
  - 半端に残すと将来の対話的フロー (PR feedback sweep) と整合させづらい
