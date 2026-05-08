# Orchestration MVP

## 概要

GitHub Projects v2 上のアイテムを起点に Claude Code (headless mode) を分離 worktree で実行し、生成された差分を Pull Request として提出するまでの 1 ターン分の orchestration フローを定義する。本 spec は実装に先行する設計仕様であり、ADR-0001 で確定済みの技術判断を前提に、実行時の振る舞い・状態遷移・失敗時の扱いを明文化する。

## 関連 Issue

- #3 — Philharmonic MVP orchestration 仕様書を作成する
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)

## 用語と登場アクター

| 用語             | 意味                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| **Orchestrator** | `philharmonic` CLI 本体の Node.js プロセス。GitHub API・git・Runner 起動・PR 作成を司る |
| **Runner**       | Claude Code CLI を headless mode で起動した子プロセス                                   |
| **Workspace**    | タスク 1 件ごとに作成される git worktree                                                |
| **Project Item** | GitHub Projects v2 board 上の item。1 つの Issue を参照する                             |
| **Status**       | Project の単一選択フィールド `Status`。Orchestrator が値遷移を駆動する                  |
| **Run**          | 1 ターンの orchestration 実行単位。`run-id` (UUIDv7) で識別                             |

## 要件

- Orchestrator は CLI コマンド 1 回 (`philharmonic run`) で **1 ターン = 1 Project Item** を処理する
- 候補選定から Status 更新・Workspace 作成・Runner 実行・PR 作成までを **同一プロセス** で逐次実行する
- Runner には GitHub token を **一切渡さない** (環境変数からも除外)。GitHub API 操作はすべて Orchestrator が行う
- Status の遷移はすべて Orchestrator が GitHub Projects v2 GraphQL 経由で行う
- Runner の起動は ADR-0001 で定めた `claude -p ... --output-format stream-json --verbose --permission-mode <auto|bypass>` を用い、worktree は subprocess の `cwd` で渡し、stream-json をローカルに永続化する (Claude Code CLI に `--cwd` フラグは存在しないため。詳細は [claude-runner.md](./claude-runner.md))
- Workspace は git worktree (per task) を採用し、Runner はその worktree 内のみで操作する
- PR 作成は Orchestrator が Octokit (REST) 経由で行い、PR 本文には `Closes #<番号>` と Acceptance Criteria の達成状況を含める
- 失敗 (timeout / runner 異常終了 / push 失敗 / 差分ゼロ等) の場合は Status を `Failed` に遷移させ、Issue に失敗コメントを残し、exit 1 で終了する
- MVP では自動 retry / 自動 merge / 並列実行を行わない

## 非機能要件

- **性能**: 1 ターンの所要時間はデフォルト timeout 30 分以内に収めることを目安とする (Runner 単体 timeout)
- **可用性**: 単一プロセス・単一ターン実行を前提とする。クラッシュ時の自動再開は MVP out-of-scope
- **セキュリティ**:
  - GitHub PAT は Orchestrator プロセスのみが保持し、Runner プロセスの環境変数からは削除する
  - prompt 本文・worktree 内ファイル・ログいずれにも token を埋め込まない
  - PAT は fine-grained PAT を推奨し、対象リポジトリと Project に絞った最小権限で運用する
  - `--permission-mode bypass` を使う場合の副作用範囲はホストファイルシステム全体であることをユーザに明示警告する (ADR-0001 で言及)
- **アクセシビリティ**: 該当しない (非対話 / CLI のみ)

## データモデル

### Project Item Status (単一選択フィールドの値)

| 値            | 意味                                                                                        | 遷移方向                             |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------ |
| `Todo`        | 未着手。candidate selection の対象となる                                                    | (初期) → `In Progress`               |
| `In Progress` | Orchestrator が選定し Runner 実行中                                                         | `Todo` ← / → `In Review` or `Failed` |
| `In Review`   | PR 作成完了。人間レビュー待ち                                                               | `In Progress` ← / → `Done` (外部)    |
| `Done`        | PR が main にマージ済み。Orchestrator は **`Done` 遷移を駆動しない** (merge 時に運用で更新) | (Orchestrator 範囲外)                |
| `Failed`      | 任意のフェーズで失敗。Issue に失敗コメントを残した後に到達                                  | `In Progress` → `Failed`             |

`Failed` から `Todo` への戻しは MVP では **手動運用** (自動 retry なし)。

### Status Transition

```
   (人間が Project に追加)
            │
            ▼
          Todo  ◀──────────── (手動で再実行する場合は人手で戻す)
            │
            │  candidate selection
            ▼
       In Progress
        │       │
        │       │  runner timeout / 異常終了 / push 失敗 / 差分ゼロ
        │       ▼
        │     Failed
        │
        │  PR 作成成功
        ▼
     In Review
        │
        │  human review + merge (orchestrator 範囲外)
        ▼
       Done
```

### Workspace

- パス: `<repo-root>/.philharmonic/worktrees/issue-<番号>/`
- ブランチ命名: `feature/<番号>-<slug>`
  - `<slug>` は Issue title を ASCII 化・kebab-case 化・先頭 30 文字で丸めたもの
  - 空文字になる場合は `task` を採用する
- ベース: 実行直前に `git fetch origin main` した後の `origin/main` HEAD
- `.philharmonic/` は `.gitignore` 済み (run ログと worktree が同居)

### Run Log (ローカル永続化)

- パス: `<repo-root>/.philharmonic/runs/<run-id>/`
- run-id 採番: **UUIDv7** を使用する。Claude Code CLI `--session-id <UUID>` の制約 (UUID 文字列) を満たしつつ、先頭 48bit のミリ秒タイムスタンプで時刻順ソートが可能になる
- 書き手の責務分割:
  | ファイル | 書き手 | 内容 |
  | --------------- | ----------------------------------- | --------------------------------------------------------------- |
  | `stream.jsonl` | Runner (`src/runner/`) | Claude Code の stdout を 1 行ずつ追記 |
  | `stderr.log` | Runner (`src/runner/`) | Claude Code の stderr を全文追記 |
  | `metadata.json` | Orchestrator (`src/runlog/`) | run-id / issue 番号 / PR 番号 / branch 等 Runner が知らない情報 |
  | `summary.md` | Orchestrator (`src/runlog/`) | `RunResult.finalText` を Markdown に整形 |
- `metadata.json` の項目 (snake_case):
  - `run_id` (UUIDv7 文字列)
  - `issue_number` (number)
  - `started_at` / `finished_at` (ISO 8601 文字列。`finished_at` は実行中は `null`)
  - `status` (`success` / `failed`)
  - `failure_reason` (失敗フェーズキー文字列もしくは `null`)
  - `total_cost_usd` (number もしくは `null`)
  - `branch` (PR 用 head ブランチ。決定前は `null`)
  - `pr_number` (作成済み PR 番号もしくは `null`)
- `summary.md` の構成: 先頭にメタ情報のリスト (run-id / issue / status / duration / cost / stop_reason 等) を置き、`## Final response` セクションに `RunResult.finalText` を貼る。`finalText` が空の場合はその旨のプレースホルダを入れる
- 永続化 API: `src/runlog/` モジュールが `generateRunId()` / `createRunLog({ runId, runsRoot })` / `writeMetadata(runLog, metadata)` / `writeSummary(runLog, input)` を提供する。`createRunLog` は `<runsRoot>/<runId>/` を mkdir し、Runner の `logDir` としてそのまま渡せる `RunLog.dir` を返す
- 保管期間: MVP では削除しない (後続 Issue で `philharmonic clean` を仕様化)

## API / インターフェース

### Orchestration Loop (step-by-step)

```
1. Bootstrap
   1.1 philharmonic.yaml を読み込み zod でバリデート
   1.2 GitHub PAT を環境変数から取得 (未設定なら exit 1)
   1.3 run-id を採番し .philharmonic/runs/<run-id>/ を作成

2. Candidate Selection
   2.1 GraphQL で対象 Project の items を取得 (page size 100)
   2.2 後述の Candidate Selection Rule で最初に一致する 1 件を選ぶ
   2.3 0 件なら何もせず exit 0 (success / no-op)

3. Status Update: Todo → In Progress
   3.1 updateProjectV2ItemFieldValue mutation で Status を更新
   3.2 失敗時は exit 1。Workspace 作成にも進まない (失敗コメントも残さない)

4. Workspace Provisioning
   4.1 git fetch origin main
   4.2 git worktree add .philharmonic/worktrees/issue-<番号> -b feature/<番号>-<slug> origin/main
   4.3 同パス / 同ブランチが既存なら abort → 9. Failure へ

5. Prompt Construction
   5.1 Issue body (Goal / Constraints / Acceptance Criteria) を取得
   5.2 後述の Prompt Construction の規約に従い prompt 文字列を組み立てる
   5.3 必要に応じ <run-id>/prompt.md として保存 (デバッグ用)

6. Runner Execution
   6.1 子プロセスとして claude -p "<prompt>" を起動
        - subprocess の cwd を <worktree> に設定 (Claude Code CLI に --cwd フラグは無い)
        - --output-format stream-json --verbose
        - --permission-mode <auto|bypass>  (philharmonic.yaml から決定)
        - --session-id <run-id>            (将来の resume 用に予約)
   6.2 環境変数からは GitHub token (GH_TOKEN / GITHUB_TOKEN 等) を削除して継承
   6.3 stdout を <run-id>/stream.jsonl に逐次追記
   6.4 timeout (デフォルト 30 分) を超過したら SIGTERM → 5 秒後 SIGKILL
   6.5 終了コード / 最終 result event を回収

7. Result Triage
   7.1 Runner exit != 0           → 9. Failure (reason: runner_error)
   7.2 Runner timeout              → 9. Failure (reason: timeout)
   7.3 worktree に commit が 0 件  → 9. Failure (reason: no_changes)
   7.4 上記以外                    → 8. PR Submission

8. PR Submission (Orchestrator 側)
   8.1 git -C <worktree> push -u origin feature/<番号>-<slug>
   8.2 Octokit pulls.create
        - base: 設定の base_branch (default: main)
        - head: feature/<番号>-<slug>
        - title: "<Issue title>" (必要なら "[#<番号>]" を prefix)
        - body: 後述 PR Body 構成
   8.3 Status Update: In Progress → In Review
        - 失敗しても PR は既に作成済みのため warning ログのみで exit 0
   8.4 worktree を git worktree remove --force <path> でクリーンアップ
   8.5 metadata.json を success として確定し exit 0

9. Failure
   9.1 Issue (Issue 本体, PR ではない) に失敗コメントを投稿
        - 失敗フェーズ / reason / 所要時間 / total_cost / run-id / Runner summary 抜粋
   9.2 Status Update: In Progress → Failed
   9.3 worktree は保持 (debug 用)。後続の clean コマンドで削除
   9.4 metadata.json を failed として確定し exit 1
```

### Candidate Selection Rule

- 対象 Project は `philharmonic.yaml` で `owner` と `project_number` を必須指定する
- 抽出条件 (AND):
  - Status = `Todo`
  - linked Issue が存在し、かつ open
  - Issue の assignee は (a) 未指定 もしくは (b) 設定の `agent_user_login` (例: `philharmonic-bot`) と一致するものを 1 件以上含む
  - Issue に `agent:skip` ラベルが付いていない
- 並び順: ProjectV2.items の **GraphQL デフォルト順** (board 上の上から下) を使用する。`orderBy` は GraphQL v2 で限定的なため MVP では追加ソートしない
- 取得サイズ: 1 ページ (100 件) のみ取得し、その中で先頭一致を選ぶ。ページネーションが必要なケースは MVP out-of-scope
- 該当 0 件: exit 0 で正常終了 (no-op を CI 等から区別したい場合は stdout に `no candidate` を出す)

### Workspace Lifecycle

| フェーズ | 動作                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 作成     | `git fetch origin main` 後に `git worktree add .philharmonic/worktrees/issue-<N> -b feature/<N>-<slug> origin/main`                             |
| 既存衝突 | 同名 worktree / 同名ローカルブランチが存在する場合 abort → Failure。MVP では auto-cleanup しない                                                |
| 実行中   | Runner はこの worktree のみで作業する。Orchestrator は worktree 内ファイルを書き換えない (read のみ)                                            |
| 成功時   | PR push 後に `git worktree remove --force <path>`、ローカルブランチも `git branch -D` で削除                                                    |
| 失敗時   | worktree とローカルブランチを **保持** する (debug 用)。手動で `git worktree remove`/`git branch -D` するか、後続の `philharmonic clean` で削除 |

### Claude Code Runner Prompt Construction

prompt は以下のセクションを上から順に連結して 1 つの文字列にする。

1. **System / Context**
   - リポジトリ owner/repo、base ブランチ (default `main`)
   - Issue 番号・タイトル・URL
   - 作業対象 worktree の絶対パス
   - 「`AGENTS.md` および `CLAUDE.md` を必ず参照すること」の明示
2. **Goal** — Issue body の `## Goal` セクションをそのまま貼り付け
3. **Constraints** — Issue body の `## Constraints` をそのまま貼り付けたうえで、以下を Orchestrator 側で追記:
   - `git push を実行しないこと` (push は Orchestrator が行う)
   - `Pull Request を作成しないこと` (PR 作成は Orchestrator が行う)
   - `GitHub token を期待しないこと` (token は与えられない)
   - `現在の worktree のブランチ上で Conventional Commits 形式で commit すること`
4. **Acceptance Criteria** — Issue body の `## Acceptance Criteria` をそのまま貼り付け
5. **Definition of Done (Runner 向け)** — `AGENTS.md` の Definition of Done のうち、PR 作成・レビュー承認は除外し、Runner が満たす範囲のみに絞ったチェックリスト

prompt は `<run-id>/prompt.md` にも保存する (再現性とデバッグのため)。Runner プロセスへ渡す環境変数からは GitHub token を必ず除外する (`GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` / `OCTOKIT_*` 等)。

### PR 作成方針

- **PR 作成は必ず Orchestrator が行う**。Runner には PR を作る能力 (token) を与えない
- 採用理由:
  - GitHub token を Runner プロセスに渡さない方針との整合
  - PR 本文に Runner ログサマリと run-id を含めたいため、Orchestrator 側のコンテキストが必要
  - PR 作成タイミングを Orchestrator が制御することで、差分 0 件 / push 失敗時に PR を作らない判定が可能
- 使う API: Octokit REST `pulls.create` (`@octokit/rest`)
- パラメータ:
  - `base`: `philharmonic.yaml` の `base_branch` (default `main`)
  - `head`: `feature/<番号>-<slug>`
  - `title`: Issue title (実装段階で `[#<番号>] ` prefix を付けるか後続 Issue で確定)
- PR Body 構成 (固定セクション):
  - `Closes #<番号>`
  - `## Acceptance Criteria` — Issue 本文から再掲したチェックリスト (Runner の最終応答に基づき自己評価結果を反映)
  - `## 実行ログ` — `run-id` / 所要時間 / `total_cost_usd` / 主要 tool use 件数
  - `## Runner Summary` — `summary.md` の冒頭抜粋
  - `## 動作確認手順` — Runner が `summary.md` に書いた検証手順をそのまま転記

### Failure / Timeout / Retry の扱い

- **Timeout**: Runner プロセスのみが対象。デフォルト 30 分。設定で上書き可能。SIGTERM → 5 秒後 SIGKILL の順で終了させる
- **Failure 共通処理**:
  1. Issue (PR ではない) に失敗コメントを 1 件投稿。コメント本文は次を含む:
     - 失敗フェーズ (`workspace_provisioning` / `runner_error` / `timeout` / `no_changes` / `push` / `pr_create`)
     - 失敗 reason の短い説明
     - 所要時間 / `total_cost_usd` (取れる範囲で)
     - run-id (ローカル参照用)
     - Runner の `summary.md` 抜粋 (token を含み得るログ全文は **貼らない**)
  2. Status を `In Progress` → `Failed` に更新
  3. worktree とローカルブランチを保持
  4. Orchestrator は exit 1
- **Retry**: MVP では **自動 retry を行わない**
  - 同 Issue を再度実行したい場合は人間が `Failed` → `Todo` に戻す
  - 再実行時に同名 worktree / 同名ブランチが残っていれば衝突 → 再度 Failure (clean コマンドが先に必要)
- **冪等性 (限定的)**: 同じ run-id で同じ Issue を 2 回実行することは想定しない。Run-id は実行ごとに新規採番される

## エラーハンドリング

| エラー                                      | 発生条件                                   | 扱い方針                                                                 |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| 候補なし                                    | Status=`Todo` の item が条件下で 0 件      | exit 0、Status 更新も Workspace 作成も行わない                           |
| Status 更新失敗 (`Todo`→`In Progress`)      | GraphQL エラー                             | exit 1。Workspace 作成にも進まない。Issue へのコメントも行わない         |
| Workspace 衝突                              | 同名 worktree / 同名ローカルブランチが既存 | Failure (reason: `workspace_conflict`)。Status を `Failed` に            |
| `git fetch` / `git worktree add` 失敗       | ネットワーク / ディスク容量 / 権限         | Failure (reason: `workspace_provisioning`)                               |
| Runner 異常終了                             | exit code != 0                             | Failure (reason: `runner_error`)。stream.jsonl と exit code をログに残す |
| Runner timeout                              | デフォルト 30 分超過                       | SIGTERM→SIGKILL の後、Failure (reason: `timeout`)                        |
| Runner 差分なし                             | worktree に commit が 0 件                 | Failure (reason: `no_changes`)。PR は作成しない                          |
| `git push` 失敗                             | 認証 / 競合 / ネットワーク                 | Failure (reason: `push`)。PR は作成しない                                |
| PR 作成失敗                                 | Octokit エラー (権限不足等)                | Failure (reason: `pr_create`)。Status は `Failed` に                     |
| Status 更新失敗 (`In Progress`→`In Review`) | GraphQL エラー (PR 作成は成功済み)         | warning ログのみ。exit 0 (PR は人間が拾える状態のため)                   |
| Issue コメント投稿失敗                      | GraphQL/REST エラー                        | warning ログのみ。Status の `Failed` 遷移は試みる                        |

## 外部依存

- **GitHub Projects v2 GraphQL API** — `@octokit/graphql` 経由 (項目取得・Status 更新)
- **GitHub REST API** — `@octokit/rest` 経由 (Issue body 取得、Issue コメント、PR 作成)
- **Claude Code CLI** — subprocess 起動、`--output-format stream-json` を要求 (ADR-0001)
- **git** — 2.40 以上推奨 (`git worktree` の安定性とフラグ互換性)
- **認証** — Personal Access Token (fine-grained 推奨)
  - 必要 scope: 対象リポジトリの `Contents: RW`, `Pull requests: RW`, `Issues: RW`, および対象 organization/user の `Projects: RW`
  - GitHub Apps 化は MVP out-of-scope (ADR-0001)

## オープンクエスチョン

- 複数 Project view を横断する candidate selection を許容すべきか (MVP では 1 view 固定で十分か)
- Issue 失敗コメントに `stream.jsonl` 抜粋をどこまで含めるか (token 漏洩リスクと有用性のバランス)
- worktree のベース更新方針 (常に `origin/main` の最新を fetch するか、設定で固定 ref を許すか)
- `philharmonic clean` の retention 仕様 (失敗 worktree を何日保持するか)
- `--permission-mode` のデフォルト (`auto` / `bypass`) — ADR-0001 でも未確定。実装着手前の後続 Issue で確定する
- 同一 Issue の再実行ガード (既存 PR が open のときに再実行されたら何をするか)

## MVP でやらないこと

ADR-0001 の Out-of-scope と整合を取り、本 spec の範囲としても以下は対象外とする。

- 並列実行 (1 ターン 1 タスク)
- 自動 retry / 自動再開
- 自動 merge (PR 作成までで止める。merge は人間判断)
- コンテナ / VM ベースの実行隔離 (git worktree のみ)
- Web UI / リアルタイム dashboard
- 複数リポジトリ対応 (シングルリポジトリ前提)
- GitHub Apps 認証 (PAT のみ)
- MCP サーバの自動セットアップ (ユーザが Claude Code 側で設定済みである前提)
- Project Item の `Done` 遷移の駆動 (merge 時に運用で更新する)
