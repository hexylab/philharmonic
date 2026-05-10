# Stale Worktree Cleanup

## 概要

GitHub Projects v2 上で **terminal state** (`Done` 等) に到達した Issue や、GitHub Issue 自体が close 済みの Issue について、対応 worktree (`<workspace_root>/issue-<番号>`) を安全条件を満たす場合のみ cleanup する仕組み。`philharmonic serve` 起動直後 (recovery 完了後 / `serveLoop` 開始前) と、独立 CLI `philharmonic clean-stale` の 2 経路で実行する。

Symphony が起動時に terminal state Issue の workspace を cleanup する挙動を Philharmonic で踏襲したもの。retention-based の `philharmonic clean` (#56) とは目的が直交し、共存する。

## 関連 Issue

- #89 — terminal Issue と安全な stale worktree cleanup を実装する
- #88 — `philharmonic retry <issue>` (個別 Issue の手動再実行。同じ safety 条件 / `WorkspaceManager.cleanupWorkspace` 経路を共有する)
- #56 — `philharmonic clean` (retention-based。`mtime` 経過済み worktree を消す)
- 設計前提: [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md)
- 関連 spec: [workspace-manager.md](./workspace-manager.md), [manual-retry.md](./manual-retry.md), [serve-daemon.md](./serve-daemon.md)

## 用語

| 用語               | 意味                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **terminal**       | Project Status が `terminal_statuses` (default `['Done']`) に含まれる、または Issue が `state=CLOSED` |
| **stale worktree** | terminal Issue に対応するが残存している worktree (= 元の作業は完了 / 終了している)                    |
| **safety 条件**    | open PR が無い / active run が無い / branch 削除が `feature/<番号>-` パターン一致時のみ               |

## 要件

- terminal とみなす Project Status は config の `terminal_statuses` で指定する (default: `['Done']`)
- 以下のいずれかに該当する worktree を cleanup 対象 (= safe-to-clean) とする:
  - Project Item の Issue が `state === 'CLOSED'`
  - Project Status が `terminal_statuses` に含まれる
- 以下のいずれかに該当する worktree は cleanup を **skip** し、理由を構造化ログに残す:
  - Project Item に対応する Issue が見つからない (`no_project_item`) — 手動作成 / 削除済み 等
  - Open Issue かつ Project Status が non-terminal (`issue_open_non_terminal`) — Todo / In Progress / In Review / Failed 等
  - Project Item は見つかるが Issue state が CLOSED でも status が無い (`non_terminal_status`)
  - `feature/<番号>-` prefix の open PR が 1 件以上ある (`open_pr_exists`)
  - run tracker で in-flight に積まれている (`active_run`)
- 安全条件を満たす worktree は `WorkspaceManager.cleanupWorkspace` で削除する。branch は `shouldDeleteBranch(taskKey, branch)` が true のときのみ `git branch -D` まで進める (main / 別 feature ブランチを構造的に保護する)
- 1 件の cleanup が失敗してもループは継続し、最後に `failed > 0` のときだけ exit code を非ゼロにする (CLI 経路)
- `philharmonic serve` 起動直後は `recoverInProgress` の **後**、`serveLoop` の **前** に実行する。GraphQL / GitHub API が失敗しても daemon の起動を止めず、warn ログを残して `serveLoop` に進む
- `philharmonic clean-stale` CLI は `--dry-run` を持ち、`--dry-run` 指定時は `cleanupWorkspace` を呼ばずに plan のみを stdout に出す
- `philharmonic clean-stale` は serve daemon との競合を避けるため、`.philharmonic/serve.lock` が存在するときは default で abort する (`--force` で続行可)

## 非機能要件

- **性能**: 1 起動あたり GraphQL 1 回 + worktree 件数分の REST `pulls.list` (each `per_page=100`)。typical には worktree 1〜数件のため軽い。
- **可用性**: GraphQL / REST が失敗しても serve は起動継続。CLI は exit 1。
- **セキュリティ**:
  - cleanup は `WorkspaceManager.cleanupWorkspace` を経由するため path traversal / branch sanitize は既存 manager の保証に乗る
  - branch 削除は `shouldDeleteBranch` (taskKey の prefix と branch ref の対応一致) を通過した場合に限る
  - GitHub token は既存の `resolveGitHubToken` 経路 (`env` / `gh` / `auto`) を流用
- **アクセシビリティ**: 該当しない (CLI / daemon のみ)

## ADR との関係

- **ADR-0005**: orchestrator は Status を **書かない**。本機能は worktree の **削除** のみを行い、Project Status は書き戻さない (Status は agent が管理する)。`philharmonic retry` (#88) のような Status 書き戻し責務は持たない。
- **ADR-0007** (dependency DAG scheduler): 本機能は dependency filter を **使わない**。terminal Issue は dependency 解決の対象外であり、cleanup 判定に dependency state は影響しない。
- 新規 ADR は不要 (実装パターンの追加であり、既存方針を覆さない)。

## データモデル

### `StaleCleanupCandidate` (cleanup 対象)

| フィールド         | 型                                    | 説明                                              |
| ------------------ | ------------------------------------- | ------------------------------------------------- |
| `worktree`         | `IssueWorktree`                       | `listIssueWorktrees` 経由で取得した worktree 情報 |
| `issueNumber`      | `number`                              | taskKey から抽出した正の整数                      |
| `status`           | `string \| null`                      | Project Status (null = Status field 未設定)       |
| `reason`           | `'terminal_status' \| 'issue_closed'` | cleanup 理由                                      |
| `branchDeletable`  | `boolean`                             | `shouldDeleteBranch(taskKey, branch)` の結果      |
| `openPullRequests` | `readonly OpenPullRequest[]`          | cleanup 対象では常に空配列                        |

### `StaleCleanupSkip` (skip 対象)

| フィールド         | 型                           | 説明                                                                                                    |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `worktree`         | `IssueWorktree`              | 同上                                                                                                    |
| `issueNumber`      | `number`                     | 同上                                                                                                    |
| `status`           | `string \| null`             | 同上                                                                                                    |
| `reason`           | `StaleCleanupSkipReason`     | `no_project_item` / `non_terminal_status` / `issue_open_non_terminal` / `open_pr_exists` / `active_run` |
| `openPullRequests` | `readonly OpenPullRequest[]` | `open_pr_exists` 時のみ非空                                                                             |

### `StaleCleanupPlan`

```ts
type StaleCleanupPlan = {
  cleanups: readonly StaleCleanupCandidate[];
  skips: readonly StaleCleanupSkip[];
};
```

## API / インターフェース

### Public API (`src/workspace/index.ts`)

```ts
export function planStaleWorktreeCleanup(
  input: PlanStaleWorktreeCleanupInput,
): Promise<StaleCleanupPlan>;

export function executeStaleCleanup(
  input: ExecuteStaleCleanupInput,
): Promise<ExecuteStaleCleanupResult>;
```

### Public API (`src/orchestrator/index.ts`)

```ts
export function cleanupStaleWorktreesAtStartup(
  deps: CleanupStaleWorktreesAtStartupDeps,
): Promise<CleanupStaleWorktreesSummary>;
```

`philharmonic serve` の bootstrap 経路から 1 度だけ呼ばれる。GraphQL / REST が失敗しても daemon を落とさないよう、内部で try/catch して warn ログを残す。

### CLI

```sh
philharmonic clean-stale [--dry-run] [--terminal-status <status>] [--force] [-c <config>]
```

| オプション                   | 説明                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--dry-run`                  | plan を stdout に表示するだけで `cleanupWorkspace` を呼ばない                                                    |
| `--terminal-status <status>` | terminal とみなす Project Status を **繰り返し指定可** で上書き (省略時は config の `terminal_statuses`)         |
| `--force`                    | `.philharmonic/serve.lock` が存在しても続行する (race を許容する場合のみ)                                        |
| `-c, --config <path>`        | 設定ファイルのパス (default: `.philharmonic/philharmonic.yaml`、不在なら legacy `philharmonic.yaml` に fallback) |

### Plan 表示形式

```
plan (terminal_statuses=Done):
  cleanups: 1
    issue-42 status=Done reason=terminal_status branch=feature/42-foo (will delete) path=/repo/.philharmonic/worktrees/issue-42
  skips:    2
    issue-7 status=Todo reason=issue_open_non_terminal branch=feature/7-bar
    issue-8 status=Done reason=open_pr_exists branch=feature/8-baz openPRs=#123

removed issue-42 status=Done reason=terminal_status path=/repo/.philharmonic/worktrees/issue-42

done removed=1 failed=0 skipped=2
```

`--dry-run` 時は最後の `removed` 行を出さず、代わりに `dry-run: no changes applied` を出す。

## エラーハンドリング

| エラー                             | 発生条件               | 扱い方針                                                                   |
| ---------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `ConfigFileNotFoundError` 等       | config 読み込み失敗    | 既存 CLI と同じ整形で stderr → exit 1                                      |
| `GitHubTokenNotSetError` 等        | token 解決失敗         | 既存 CLI と同じ                                                            |
| `fetchProjectCandidates` が throw  | GraphQL 失敗 / network | CLI: stderr → exit 1 / serve: warn ログのみで `serveLoop` に進む           |
| `listOpenPullRequests` が throw    | REST 失敗 / rate limit | その worktree を `open_pr_exists` 扱いで skip (安全側)                     |
| `cleanupWorkspace` が throw (個別) | git lock / 権限 / disk | warn ログを残して次の worktree に進む。CLI は最後に `failed > 0` で exit 1 |
| `serve.lock` 存在 (`--force` なし) | daemon 動作中          | stderr → exit 1。`--force` で続行可                                        |

## 自動 retry queue / `philharmonic retry` との関係

- 自動 retry queue (#84 / ADR-0008) は in-memory で daemon プロセス内のみ。本機能の cleanup と直接干渉しない。daemon 再起動時の本機能と retry queue の蒸発は spec として共存する
- `philharmonic retry <issue>` (#88) は **個別 Issue を Status まで含めて再 dispatch 状態に戻す**。本機能は **terminal Issue の worktree を消す**だけで Status は触らない。両者は責務が直交し、cleanup 対象 (terminal) と retry 対象 (Failed → Todo) も重ならない (terminal は再実行しない)

## 外部依存

- 既存 `WorkspaceManager.cleanupWorkspace` / `listIssueWorktrees` / `shouldDeleteBranch`
- 既存 `ProjectsClient.fetchProjectCandidates`
- 既存 `GitHubClient.listOpenPullRequests`
- 既存 `RunTracker.getRunningByIssue` (serve 経路のみ。CLI 経路は tracker 無し)

## オープンクエスチョン

- 起動時だけでなく poll tick ごとに本 cleanup を回す必要があるか — 現状は起動時のみで十分 (terminal 化は通常レアイベント)。継続的に必要になった場合は `agent.stale_cleanup_interval_ticks` 等で間引き設定を後付けする
- terminal_statuses に Status だけでなく label (`agent:done` 等) を許容するか — MVP では Status 一本に絞る
- worktree 内の uncommitted change の保護 — `cleanupWorkspace` は `git worktree remove --force` を使うため未 push 変更は失われる。前段で警告を出す方針も検討するが MVP では skip 条件として明文化しない

## MVP でやらないこと

- non-terminal な Todo / In Progress 状態の worktree の自動 cleanup (運用ミス由来の stale が dispatch を妨げるケースは `philharmonic retry` で個別解決する設計)
- multi-host 跨ぎの worktree cleanup
- `philharmonic clean` (retention-based) とのオプション統合 (現状は別コマンドとして共存)
