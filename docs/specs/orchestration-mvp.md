# Orchestration

## 概要

GitHub Projects v2 上のアイテムを起点に Claude Code (headless mode) を分離 worktree で実行するまでを Philharmonic が担う。Status 遷移 (Todo → In Progress / In Review / Failed)、commit / push、Pull Request 作成、Issue コメント投稿は agent (Claude Code + `gh` CLI) が prompt instruction に従って実行する。本 spec は ADR-0001 / ADR-0005 を前提に、1 ターン分の orchestration の振る舞い・候補選定・recovery・worktree ライフサイクルを明文化する。

実装エントリポイントは `philharmonic run` CLI コマンドで、本 spec の Bootstrap → Failure の各ステップは `src/orchestrator/` の `runOnce` に対応する。`philharmonic run` は 1 ターン分の処理が終わると exit する (常駐しない)。

常駐ポーリングデーモンとして `runOnce` を一定間隔で繰り返したい場合は `philharmonic serve` を使う。daemon の loop 制御 / signal handling / structured ログは [serve-daemon.md](./serve-daemon.md) を参照。

## 関連 Issue

- #3 — Philharmonic MVP orchestration 仕様書を作成する
- #23 — Tracker-driven recovery (起動時に In Progress を再開) を実装する
- #62 — Philharmonic を薄い orchestrator に再設計し、state 遷移 / PR 作成を agent に委譲する
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md), [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md)

## 用語と登場アクター

| 用語             | 意味                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** | `philharmonic` CLI 本体の Node.js プロセス。GitHub API 経由で候補選定、worktree 作成、Runner 起動、結果ログ永続化を司る   |
| **Runner**       | Claude Code CLI を headless mode で起動した子プロセス                                                                     |
| **Agent**        | Runner 内で動く Claude Code。prompt 指示に従い `gh` / `git` で Status 遷移 / commit / push / PR 作成 / コメント投稿を行う |
| **Workspace**    | タスク 1 件ごとに作成される git worktree                                                                                  |
| **Project Item** | GitHub Projects v2 board 上の item。1 つの Issue を参照する                                                               |
| **Status**       | Project の単一選択フィールド `Status`。Orchestrator は **読むだけ** (candidate selection 用)、書かない                    |
| **Run**          | 1 ターンの orchestration 実行単位。`run-id` (UUIDv7) で識別                                                               |

## 要件

- Orchestrator は CLI コマンド 1 回 (`philharmonic run`) で **1 ターン = 1 Project Item** を処理する
- 候補選定から Workspace 作成・Runner 実行・結果ログ永続化までを **同一プロセス** で逐次実行する
- Runner 環境変数には `GITHUB_TOKEN` / `GH_TOKEN` を allowlist で透過させ、agent が `gh` / `git push` を実行できるようにする (ADR-0005)
- Status の遷移 (Todo → In Progress / In Review / Failed) は **agent が `gh project item-edit` 等で行う**。orchestrator は Status field を読むだけ
- PR 作成 / Issue コメント投稿は **agent が `gh pr create` / `gh issue comment` 等で行う**。orchestrator は API を一切呼ばない
- Runner 起動は ADR-0001 の `claude -p ... --output-format stream-json --verbose <permission-flag>` を用いる。`<permission-flag>` は `permission_mode` に応じて `--permission-mode acceptEdits` (`auto`) または `--dangerously-skip-permissions` (`bypass`)。**`auto` では agent が Bash tool (gh / git) を呼べないため、agent 委譲型では実用上 `bypass` を選択する** (ADR-0005)
- Workspace は git worktree (per task) を採用し、Runner はその worktree 内で git push まで完結する
- 同一 Issue の二重 dispatch を防ぐため、candidate selection の最終フィルタとして「worktree 既存」「in-flight tracker に積まれている」を skip 条件に加える (ADR-0005)
- Runner 終了後の worktree cleanup は **runner exit 0 のみ**。`failed` / `timeout` / `stalled` 時は保持する (debug 用 / agent が Status flip し損ねたケースの救済余地)
- `philharmonic run` (1 ターン実行) では自動 retry / 並列実行を行わない。`philharmonic serve` daemon は並列 dispatch (#24) / 起動時 recovery (#23) / in-memory retry queue (#84 / ADR-0008) を持つ。永続 / Status 駆動な旧 retry は ADR-0005 で撤廃された ([serve-daemon.md](./serve-daemon.md), [retry-queue.md](./retry-queue.md))

## 非機能要件

- **性能**: 1 ターンの所要時間はデフォルト timeout 30 分以内に収めることを目安とする (Runner 単体 timeout)
- **可用性**: 単一プロセス・単一ターン実行を前提とする。クラッシュ時の自動再開は MVP out-of-scope。daemon 連続稼働中の自動救済 (runner exit ≠ 0 + agent が Failed flip 前に死亡) は MVP では行わず、次回 `serve` 起動時の recovery で拾う
- **セキュリティ**:
  - `GITHUB_TOKEN` / `GH_TOKEN` は agent が `gh` / `git push` で利用するため Runner 環境変数に allowlist 経由で渡す。fine-grained PAT (対象リポジトリと Project に絞ったもの) を強く推奨
  - prompt 本文・worktree 内ファイル・ログいずれにも token を埋め込まない
  - `permission_mode: bypass` を使う場合の副作用範囲はホストファイルシステム全体であることをユーザに明示警告する (Orchestrator が runner 起動前に WARN ログを 1 行出す)
- **アクセシビリティ**: 該当しない (非対話 / CLI のみ)

## データモデル

### Project Item Status (単一選択フィールドの値)

Status の値は agent と人間の運用で駆動される。orchestrator は **読むだけ** で、以下のセマンティクスを期待する。

| 値                                               | 意味                                                                      | 駆動元                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------- |
| `Todo`                                           | 未着手。dispatch 対象 (`dispatch_statuses` で別 Status 名へ変更可能、#38) | 人間が起票時に設定                        |
| `In Progress` (`status_transitions.in_progress`) | Agent が処理中                                                            | **Agent** (prompt 受領直後に flip)        |
| `In Review` (`status_transitions.in_review`)     | PR 作成完了。人間レビュー待ち                                             | **Agent** (PR 作成成功後に flip)          |
| `Done`                                           | PR が main にマージ済み                                                   | 人間 (orchestrator も agent も駆動しない) |
| `Failed` (`status_transitions.failed`)           | 任意のフェーズで失敗。Issue に失敗コメントを残した後に到達                | **Agent** (失敗判断時に flip)             |

`In Progress` / `In Review` / `Failed` 列に書いてある値は default。`philharmonic.yaml` の `status_transitions` で Project の Status options に合わせて差し替えできる (#62)。Orchestrator は値を解釈せず prompt のフッタにそのまま埋め込み、agent が `gh` で書き込む。

`Failed` から `Todo` への戻しは **人間** または **agent (PR レビューの差し戻し対応等)** が判断する。orchestrator は自動 retry を行わない。

### Status Transition

```
   (人間が Project に追加)
            │
            ▼
          Todo  ◀──────────── (人間 or agent が手動で戻す)
            │
            │  orchestrator が candidate を pick → worktree 作成 → Claude 起動
            ▼
        (Agent が in-process)
            │
            │  Agent が prompt 指示に従い `gh project item-edit` で Todo → In Progress flip
            ▼
       In Progress
        │       │
        │       │  Agent が失敗判断 (gh issue comment + In Progress → Failed flip)
        │       ▼
        │     Failed
        │
        │  Agent が `gh pr create` 後に In Progress → In Review flip
        ▼
     In Review
        │
        │  human review + merge → Status を Done に手動更新
        ▼
       Done
```

### Workspace

- パス: `<repo-root>/.philharmonic/worktrees/issue-<番号>/`
- ブランチ命名: `feature/<番号>-<slug>`
  - `<slug>` は Issue title を ASCII 化・kebab-case 化・先頭 30 文字で丸めたもの
  - 空文字になる場合は `task` を採用する
- ベース: 実行直前に `git fetch origin main` した後の `origin/main` HEAD
- `.philharmonic/` は `.gitignore` 済み

agent は worktree 内で `git commit` → `git push -u origin <branch>` → `gh pr create` を行う。push 先 remote の認証は agent が `GITHUB_TOKEN` / `GH_TOKEN` env 経由で持つ。

### Run Log (ローカル永続化)

- パス: `<repo-root>/.philharmonic/runs/<run-id>/`
- run-id 採番: **UUIDv7** を使用する。Claude Code CLI `--session-id <UUID>` の制約を満たしつつ、先頭 48bit のミリ秒タイムスタンプで時刻順ソートが可能になる
- 書き手の責務分割:

  | ファイル        | 書き手                       | 内容                                      |
  | --------------- | ---------------------------- | ----------------------------------------- |
  | `stream.jsonl`  | Runner (`src/runner/`)       | Claude Code の stdout を 1 行ずつ追記     |
  | `stderr.log`    | Runner (`src/runner/`)       | Claude Code の stderr を全文追記          |
  | `metadata.json` | Orchestrator (`src/runlog/`) | run-id / issue 番号 / branch 等のメタ情報 |
  | `summary.md`    | Orchestrator (`src/runlog/`) | `RunResult.finalText` を Markdown に整形  |

- `metadata.json` の項目 (snake_case):
  - `run_id` (UUIDv7 文字列)
  - `issue_number` (number)
  - `started_at` / `finished_at` (ISO 8601 文字列。`finished_at` は実行中は `null`)
  - `status` (`success` / `failed`)
  - `failure_reason` (失敗フェーズキー文字列もしくは `null`)
  - `total_cost_usd` (number もしくは `null`)
  - `branch` (worktree のローカル feature ブランチ。決定前は `null`)
- `summary.md` の構成: 先頭にメタ情報のリスト (run-id / issue / status / duration / cost / stop_reason 等) を置き、`## Final response` セクションに `RunResult.finalText` を貼る。`finalText` が空の場合はその旨のプレースホルダを入れる
- 永続化 API: `src/runlog/` モジュールが `generateRunId()` / `createRunLog({ runId, runsRoot })` / `writeMetadata(runLog, metadata)` / `writeSummary(runLog, input)` を提供する
- 保管期間: MVP では削除しない (Run Log は `philharmonic clean` の対象外)

PR 番号は orchestrator が知れないため `metadata.json` には含めない。

## API / インターフェース

### Orchestration Loop (step-by-step)

```
1. Bootstrap
   1.1 .philharmonic/philharmonic.yaml を読み込み zod でバリデート (default 不在時は legacy `philharmonic.yaml` を warning 付き fallback)
   1.2 GitHub PAT を環境変数から取得 (未設定なら exit 1)
   1.3 run-id を採番し .philharmonic/runs/<run-id>/ を作成

2. Candidate Selection
   2.1 GraphQL で対象 Project の items を取得 (page size 100)
   2.2 後述の Candidate Selection Rule で最初に一致する 1 件を選ぶ
   2.3 0 件なら何もせず exit 0 (success / no-op)

3. Workspace Provisioning
   3.1 git fetch origin main
   3.2 git worktree add .philharmonic/worktrees/issue-<番号> -b feature/<番号>-<slug> origin/main
   3.3 同パス / 同ブランチが既存なら abort → 6. Failure へ

4. Prompt Construction
   4.1 Issue body を取得 (構造化セクション抽出は行わず本文をそのまま渡す)
   4.2 .philharmonic/WORKFLOW.md (Liquid テンプレート) があればテンプレートを render し、無ければ buildPrompt にフォールバック (default 不在時は legacy `WORKFLOW.md` (repo root) を warning 付き fallback) (詳細: workflow.md / prompt-construction.md)
   4.3 Orchestrator フッタ (Status 遷移 / commit / push / PR 作成 / 必要に応じ失敗コメント / Conventional Commits) を Orchestrator が無条件で末尾に連結する
   4.4 <run-id>/prompt.md として保存 (デバッグ用)

5. Runner Execution
   5.1 子プロセスとして claude -p "<prompt>" を起動
        - subprocess の cwd を <worktree> に設定 (Claude Code CLI に --cwd フラグは無い)
        - --output-format stream-json --verbose
        - permission_mode に応じて --permission-mode acceptEdits (auto) または --dangerously-skip-permissions (bypass) を渡す (philharmonic.yaml から決定。bypass 時は runner 起動前に WARN ログを出す)
        - --session-id <run-id> (将来の resume 用に予約)
   5.2 環境変数は allowlist で絞ったうえで GITHUB_TOKEN / GH_TOKEN を透過させる (agent が gh / git push で使う)
   5.3 stdout を <run-id>/stream.jsonl に逐次追記
   5.4 timeout (デフォルト 30 分) を超過したら SIGTERM → 5 秒後 SIGKILL
   5.5 終了コード / 最終 result event を回収

6. Result Triage
   6.1 Runner exit 0                → 7. Cleanup (success)
   6.2 Runner exit != 0             → 6. Failure (reason: runner_error)
   6.3 Runner timeout                → 6. Failure (reason: timeout)
   6.4 Runner stall                  → 6. Failure (reason: stalled, #25)
   6.5 hook 失敗                     → 6. Failure (reason: hook_failed)

7. Cleanup (success)
   7.1 worktree を git worktree remove --force <path> でクリーンアップ
   7.2 ローカル feature ブランチを git branch -D で削除
   7.3 metadata.json を success として確定し exit 0
   7.4 Status 遷移 / PR 作成 / Issue コメントは agent が runner 内で済ませている前提

8. Failure
   8.1 worktree とローカルブランチを保持 (debug 用 / agent が Status flip し損ねたケースの救済余地)
   8.2 metadata.json を failed として確定し exit 1
   8.3 Issue コメント / Status 遷移は orchestrator は行わない (agent が完了する前に死んだケースは Issue に痕跡が残らないため、debug は run-log と structured log に頼る)
```

### Candidate Selection Rule

- 対象 Project は `philharmonic.yaml` で `owner` と `project_number` を必須指定する
- 抽出条件 (AND):
  - Status が `philharmonic.yaml` の `dispatch_statuses` に含まれる (未指定時のデフォルトは `['Todo']`。詳細: [config-schema.md](./config-schema.md))
  - linked Issue が存在し、かつ open
  - Issue の assignee は (a) 未指定 もしくは (b) 設定の `agent_user_login` (例: `philharmonic-bot`) と一致するものを 1 件以上含む
  - Issue に `agent:skip` ラベルが付いていない
  - **対応する worktree (`<workspace_root>/issue-<番号>`) が存在しない** (二重 dispatch ガード a)
  - **`runTracker.getRunningByIssue(issueNumber) === null`** (二重 dispatch ガード b。`philharmonic serve` の in-memory tracker を見る)
  - **dependency filter で `ready` 判定** (ADR-0007 §4 / [dependency-resolver.md](./dependency-resolver.md))
- 並び順: ProjectV2.items の **GraphQL デフォルト順** (board 上の上から下) を使用する
- 取得サイズ: 1 ページ (100 件) のみ取得し、その中で先頭一致を選ぶ。ページネーションが必要なケースは MVP out-of-scope
- 該当 0 件: exit 0 で正常終了

二重 dispatch ガードは ADR-0005 で導入された。Status flip が agent 任せになったため、orchestrator が同一 Issue を次 tick で再 pick するリスクを candidate selection 段階で打ち切る。

#### Dependency filter (ADR-0007)

- 既存 filter (status / assignee / `agent:skip` / worktree / in-flight) を全件通過した acceptable candidate に対して、最終段で `evaluateDependencyDag` を適用する
- `ready` のみを残し、board 順で先頭 N 件 (N = `agent.max_concurrent_agents`) を dispatch する
- `blocked` / `invalid_dependency` / `cycle` は **dispatch しない**。理由を 1 行ずつ structured log に出す (詳細: [serve-daemon.md#structured-log](./serve-daemon.md))
- `philharmonic run` (`limit=1`) でも同じ filter を経由する。先頭 candidate が blocked のとき、その次の `ready` を選ぶ
- recovery (`recoverInProgress`) は dependency filter を **適用しない**。既に着手済み (mid-execution) の Issue が依存先後退で永遠に停止しないように、recovery では Status `In Progress` の Item を依存判定なしで救済する
- API call の trade-off: filter のために acceptable 全件の `getIssue` を 1 周走査する。limit 件で打ち切る旧挙動より tick あたりの REST 呼び出しが増えるが、Issue body は依存解決に再利用するため、Project items 外の依存先に対する追加 fetch のみ tick scoped で発生する (ADR-0007 §6)

### Workspace Lifecycle

| フェーズ | 動作                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 作成     | `git fetch origin main` 後に `git worktree add .philharmonic/worktrees/issue-<N> -b feature/<N>-<slug> origin/main`                                                 |
| 既存衝突 | 同名 worktree / 同名ローカルブランチが存在する場合 abort → Failure。auto-cleanup しない                                                                             |
| 実行中   | Runner はこの worktree 内で commit / push まで完結する。orchestrator は worktree 内ファイルを書き換えない (read のみ)                                               |
| 成功時   | Runner exit 0 後に `git worktree remove --force <path>` + `git branch -D <branch>` で削除                                                                           |
| 失敗時   | worktree とローカルブランチを **保持** する (debug 用)。手動で `git worktree remove`/`git branch -D` するか、`philharmonic clean` で retention 経過後にまとめて削除 |

### Claude Code Runner Prompt Construction

prompt は **WORKFLOW.md (Liquid テンプレート)** が存在すればそれを上位レイヤとして render し、無ければ以下のフォールバック構成 (下位レイヤ = `buildPrompt`) で組み立てる。テンプレート利用時は末尾に `## Orchestrator からの追加指示` セクションが Orchestrator により無条件に連結される (workflow.md 参照)。

フォールバック (テンプレート不在) 時は以下のセクションを上から順に連結して 1 つの文字列にする。

1. **Context**
   - リポジトリ owner/repo、base ブランチ (default `main`)
   - Issue 番号・タイトル・URL
   - 作業対象 worktree の絶対パス
   - 「`AGENTS.md` および `CLAUDE.md` を必ず参照すること」の明示
2. **Issue 本文** — Issue body をそのまま貼り付け (構造化セクション抽出は行わない)
3. **Orchestrator からの追加指示 (Definition of Done)** — 以下を Orchestrator 側で常に追加する。`<status_transitions.*>` は `philharmonic.yaml` の `status_transitions` の値がそのまま埋め込まれる (default は `In Progress` / `In Review` / `Failed`):
   - 着手直後に Project Status を `<status_transitions.in_progress>` に遷移する (`gh project item-edit ...`)
   - リポジトリの `AGENTS.md` / `CLAUDE.md` を必ず参照する
   - 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit する
   - `git push -u origin <branch>` で push する
   - `gh pr create` で対応 Issue に紐づく Pull Request を作成し、本文に `Closes #<番号>` を含める
   - PR 作成成功後に Project Status を `<status_transitions.in_review>` に遷移する
   - 失敗時は Project Status を `<status_transitions.failed>` に遷移し、Issue に失敗の理由をコメントする (token / 機微情報を貼らない)
   - GitHub の認証は環境変数 `GITHUB_TOKEN` / `GH_TOKEN` (Orchestrator が allowlist で透過) または host の `gh auth` を使う

prompt は `<run-id>/prompt.md` にも保存する (再現性とデバッグのため)。Runner プロセスへ渡す環境変数からは GitHub 関連 token (`GITHUB_TOKEN` / `GH_TOKEN`) を **allowlist 経由で意図的に透過する** (ADR-0005)。AWS / npm / SSH 等の他 secret は引き続き allowlist で落とす。

### PR 作成方針

- **PR 作成は agent が `gh pr create` で行う** (ADR-0005 で旧方針を Superseded)
- orchestrator は Octokit を PR 作成・Issue コメント・Status 更新のいずれにも使わない (`getIssue` / `listOpenPullRequests` のみ recovery で使用)
- PR title / body の決定は agent に委ねる。Orchestrator フッタで `Closes #<番号>` を含めることだけは指示する

### Failure / Timeout の扱い

- **Timeout**: Runner プロセスのみが対象。デフォルト 30 分。設定で上書き可能。SIGTERM → 5 秒後 SIGKILL の順で終了させる
- **Failure 共通処理**:
  1. worktree とローカルブランチを保持 (debug 用)
  2. `metadata.json` を `failed` として確定 (`failure_reason` を含む)
  3. `summary.md` に `RunResult.finalText` (もしくは stderr 抜粋) を整形して保存
  4. structured log に `run failed` (error level, reason 付き) を出力
  5. orchestrator は exit 1
  6. **Issue コメント / Status 遷移は行わない** (agent が runner 内で完了するか、未完なら次回 `serve` 起動時の recovery で拾う運用)
- **Retry**:
  - `philharmonic run` (1 ターン実行) は **自動 retry を行わない** (ADR-0005 で永続 retry-state は撤廃したまま)
  - `philharmonic serve` daemon は **in-memory な retry queue** で `runner_error` / `timeout` / `stalled` / `hook_failed` / `workspace_provisioning` の失敗を最大 `agent.max_retry_attempts` 回まで自動再 dispatch する (#84 / ADR-0008)。詳細: [retry-queue.md](./retry-queue.md)
  - retry queue は永続化されず、daemon 再起動で消える。失われた retry は次回 `serve` 起動時の recovery で `In Progress` 引き取り経路として拾う
  - retry 上限を超えた / queue 未注入のときは worktree を保持したまま落とす。手動で `Failed → Todo` に戻すか `philharmonic clean` を打つ既存の運用が引き続き有効
- **冪等性 (限定的)**: 同じ run-id で同じ Issue を 2 回実行することは想定しない。Run-id は実行ごとに新規採番される

### Tracker-driven Recovery (`serve` 起動時)

`philharmonic serve` が前回プロセスのクラッシュ等で `In Progress` のまま残った Project Item を引き取って再実行するためのフェーズ。daemon の起動シーケンス内、lock 取得後 / `serveLoop` 開始前に **1 回だけ** 走る。永続 DB は使わず、Project Item の Status と FS (worktree) を source of truth とする。

#### 起動時シーケンスにおける位置付け

```
serve bootstrap
  ↓
1. token / config / bypass guard
2. lock 取得
3. signal subscription を張る (controller.signal は recovery にも渡す)
4. ★ Recovery フェーズ ← 本セクション
5. serveLoop (poll tick の繰り返し)
```

#### 入力

- 対象 Project (`philharmonic.yaml` の `owner` / `project_number`) の Items 全件取得
- Status が **`In Progress`** の Item のみを対象とする (`dispatch_statuses` の影響は受けない)
- AbortSignal: `serveLoop` と同じ controller を共有し、recovery 中の SIGTERM/SIGINT で次の item に進まずに break する

#### 各 Item に対する処理 (上から順に評価)

1. **対応する open PR が存在するか確認**
   - REST `pulls.list({ state: 'open', per_page: 100 })` で該当リポジトリの open PR を取得し、`head.ref` が `feature/<issue番号>-` で始まるものを対応 PR とみなす
   - 一致する PR が 1 つでもあれば **skip** (agent が PR を立てて In Review 遷移を忘れた等のエッジケース)
   - skip 時は `recovery skip (open PR exists)` を info ログ
2. **対応 worktree (`<repo-root>/.philharmonic/worktrees/issue-<番号>`) が存在するか確認**
   - 存在する場合: **強制 reset 後に再実行**
     - `WorkspaceManager.cleanupWorkspace({ taskKey, branch, deleteBranch: true })` を呼んで worktree とローカルブランチを削除する
     - 続いて新規 `createWorkspace({ reuse: false })` で `origin/main` から fresh worktree を再作成
   - 存在しない場合: **新規作成して再実行**
     - そのまま `createWorkspace({ reuse: false, ... })` を呼ぶ
   - 再開 (resume) は MVP では行わない (Claude Code session resume 連携は別 Issue。本 ADR では「強制 reset」を選択する)
3. **再実行 (`dispatchSelected`)**
   - `runOnce` の Workspace 作成以降の処理 (workspace 作成 → prompt 構築 → runner 起動 → cleanup) と同じパスを通す
   - Status は既に `In Progress` のため orchestrator は何もしない (agent が再度 prompt 受領時に flip 判断する)
   - 失敗時は通常の `runOnce` 同様 `failed` を return し、worktree を保持して **次の Item に進む** (recovery 全体は break しない)

#### Recovery 結果のログ

| level | msg                              | fields                                        | 説明                                           |
| ----- | -------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| info  | `recovery started`               | `inProgressCount`                             | フェーズ開始時 1 回                            |
| info  | `recovery skip (open PR exists)` | `issueNumber`, `headRef`, `prNumber`          | open PR ありで skip                            |
| info  | `recovery skip (issue closed)`   | `issueNumber`                                 | Issue が close 済みで skip                     |
| info  | `recovery dispatch success`      | `issueNumber`, `runId`                        | 1 件再実行が成功                               |
| warn  | `recovery dispatch failed`       | `issueNumber`, `runId`, `reason`              | 1 件再実行が失敗                               |
| warn  | `recovery dispatch error`        | `issueNumber`, `error`                        | 想定外 throw → recovery を打ち切らず次 item へ |
| info  | `recovery completed`             | `processed`, `succeeded`, `failed`, `skipped` | フェーズ終了時 1 回                            |

#### エラーハンドリング

- **Project metadata 取得失敗 (recovery 開始時)**: `BootstrapError` を throw し serve 起動自体を停止 (exit 1)。recovery が回らない状態で polling だけ動くのは危険なため
- **In Progress item の Issue 取得失敗**: warn ログを出して当該 item を skip し、次 item に進む (recovery 全体は止めない)
- **個別 item の `dispatchSelected` 失敗**: 通常の Failure 処理 (worktree 保持 + run-log) を経て次 item へ
- **AbortSignal による中断**: 現在処理中の item は完走 (途中強制終了は MVP 範囲外)。次 item には進まずに recovery を break する

#### MVP でやらないこと

- Claude Code session の resume (本 ADR は強制 reset で確定)
- recovery の自動 retry (1 回だけ起動時に走る。失敗した item は手動で `Failed` → `Todo` 戻し)
- 並列 recovery (1 件ずつ逐次)
- Project 全体の status 整合性チェック (`In Review` だが PR が closed されているケース等は対象外)
- daemon 連続稼働中の自動救済 (runner exit ≠ 0 + agent が Failed flip 前に死亡したケースは次回起動時の recovery で拾う)

### `philharmonic clean` (失敗 worktree のクリーンアップ)

失敗時に保持される `<workspace_root>/issue-*` worktree とそれに紐づくローカルブランチを、retention 経過後にまとめて削除するためのサブコマンド。

- **対象の限定**: `git worktree list --porcelain` を起点に、(a) workspace root 配下に位置し、かつ (b) ディレクトリ名が `issue-<番号>` パターンに一致するエントリのみを候補とする
- **age の判定**: 各候補ディレクトリの `mtime` を `Date.now()` と比較し、`mtime <= now - retentionDays * 1day` を満たすものだけを削除対象とする
- **Retention の指定**:
  - philharmonic.yaml の `clean_retention_days` (デフォルト 7) で日数を指定する
  - CLI フラグ `--retention-days <days>` で 1 回だけ上書き可能
- **`--dry-run`**: 削除対象を stdout に列挙するだけで、`cleanupWorkspace` を呼ばない
- **削除処理**: 候補ごとに `WorkspaceManager.cleanupWorkspace({ taskKey, branch, deleteBranch })` を呼び、worktree (とローカルブランチ) を削除する。`deleteBranch` は worktree に紐づく branch が `feature/<issueNumber>-` 形式に一致したときのみ `true` とし、それ以外は `false` で main 等を構造的に保護する
- **exit code**: 削除候補が 0 件、または全候補の削除が成功したときは exit 0。1 件でも失敗したときは stderr に詳細を出して exit 1
- **対象外**: `<repo-root>/.philharmonic/runs/<run-id>/` (Run Log) は本コマンドの対象外

## エラーハンドリング

| エラー                                | 発生条件                                                                         | 扱い方針                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 候補なし                              | Status=`Todo` の item が条件下で 0 件                                            | exit 0、Workspace 作成も行わない                                         |
| Workspace 衝突                        | 同名 worktree / 同名ローカルブランチが既存                                       | Failure (reason: `workspace_provisioning`)。worktree は保持              |
| `git fetch` / `git worktree add` 失敗 | ネットワーク / ディスク容量 / 権限                                               | Failure (reason: `workspace_provisioning`)                               |
| Runner 異常終了                       | exit code != 0                                                                   | Failure (reason: `runner_error`)。stream.jsonl と exit code をログに残す |
| Runner timeout                        | デフォルト 30 分超過                                                             | SIGTERM→SIGKILL の後、Failure (reason: `timeout`)                        |
| Runner stall                          | stdout 無音が `agent.stall_timeout_ms` を超過                                    | SIGTERM→SIGKILL の後、Failure (reason: `stalled`, #25)                   |
| hook 失敗                             | before_run / after_run / before_remove / after_create のいずれかが non-zero exit | Failure (reason: `hook_failed`)                                          |

## 外部依存

- **GitHub Projects v2 GraphQL API** — `@octokit/graphql` 経由 (項目取得のみ。Status 更新は撤廃)
- **GitHub REST API** — `@octokit/rest` 経由 (Issue body 取得 / open PR 列挙のみ。PR 作成 / Issue コメント / Status 更新は撤廃)
- **Claude Code CLI** — subprocess 起動、`--output-format stream-json` を要求 (ADR-0001)
- **`gh` CLI** — agent (Runner subprocess 内) が利用。orchestrator は使用しない
- **git** — 2.40 以上推奨
- **認証** — Personal Access Token (fine-grained 推奨)
  - 必要 scope: 対象リポジトリの `Contents: RW`, `Pull requests: RW`, `Issues: RW`, および対象 organization/user の `Projects: RW`
  - **Runner にも env 経由で透過する** (ADR-0005)。agent が `gh` / `git push` で利用

## オープンクエスチョン

- 複数 Project view を横断する candidate selection を許容すべきか
- worktree のベース更新方針 (常に `origin/main` の最新を fetch するか、設定で固定 ref を許すか)
- 同一 Issue の再実行ガード (既存 PR が open のときに再実行されたら何をするか) — recovery では skip だが通常 dispatch ではブランチ衝突で fail
- agent が PR 作成や Status 遷移に失敗したケースの観測性向上 (現状は Issue コメント / run-log / structured log から後追いするのみ)
- daemon 連続稼働中の自動救済 (runner exit ≠ 0 + agent が Failed flip 前に死亡) を将来サポートするか — Open。MVP では人手 / 次回起動時 recovery に任せる

## MVP でやらないこと

ADR-0001 / ADR-0005 の Out-of-scope と整合を取り、本 spec の範囲としても以下は対象外とする。

- `philharmonic run` の自動 retry (本 ADR で撤廃。`serve` daemon の retry queue は ADR-0008 で別途追加)
- 永続 / Status 駆動な retry-state (ADR-0005 で撤廃のまま。新 retry queue は in-memory)
- 自動 merge (PR 作成までで止める。merge は人間判断)
- コンテナ / VM ベースの実行隔離 (git worktree のみ)
- Web UI / リアルタイム dashboard
- 複数リポジトリ対応 (シングルリポジトリ前提)
- GitHub Apps 認証 (PAT のみ)
- MCP サーバの自動セットアップ (ユーザが Claude Code 側で設定済みである前提)
- Project Item の `Done` 遷移の駆動 (merge 時に運用で更新する)
- daemon 連続稼働中の自動救済
