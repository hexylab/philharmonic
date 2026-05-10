# Manual Retry CLI (`philharmonic retry`)

## 概要

自動 retry queue (#84 / ADR-0008) で復旧できなかった Issue や、恒久原因を修正したあとに人間が明示的に再実行したい Issue を、単一コマンド `philharmonic retry <issue-number>` で安全に再 dispatch 可能な状態へ戻すための fallback コマンド。Project Status を dispatch 対象状態 (default: `Todo`) に戻し、stale な worktree を cleanup する。serve daemon が動いていれば次 tick で再 pick される。

## 関連 Issue

- #88 — `philharmonic retry <issue-number>` で手動再実行できるようにする
- #86 — retry exhausted 時の failure-summary.md / 復旧導線 (本コマンドが復旧経路として参照される)
- #84 — in-memory retry queue (本コマンドとの相互作用)
- 設計前提: [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md), [ADR-0008 in-memory retry queue](../adr/0008-in-memory-retry-queue.md)

## 要件

- `philharmonic retry <issue-number>` を CLI に追加する
- 対象 Issue の **Project Item / Issue / open PR / worktree** の現状を読み取って「次に何が起こるか」を **plan** として提示する (`--dry-run` でも実 plan を出す)
- 安全条件をすべて満たしたら以下を順に実行する:
  1. **worktree cleanup** — 対象 Issue の `<workspace_root>/issue-<番号>` ディレクトリを `WorkspaceManager.cleanupWorkspace` で削除する。`feature/<issue番号>-` 形式のローカルブランチも併せて削除する (`shouldDeleteBranch` ガードを通過したときのみ)
  2. **Project Status 書き戻し** — Project Status を **`--target-status`** または `dispatch_statuses[0]` (default: `Todo`) に `gh project item-edit` で更新する。既に target と同じなら skip
- **open PR が存在する場合は default で abort** する (`feature/<issue番号>-` で始まる head.ref を持つ open PR を `listOpenPullRequests` で確認)。`--force` を付けたときのみ続行する
- **Issue が close 済みなら abort** する (再実行する意味がない)
- **対象 Issue が Project Item に紐付いていないなら abort** する
- `--dry-run` では **副作用ゼロ** で plan を stdout に出力する。`gh project item-edit` も `cleanupWorkspace` も呼ばない (なお `--dry-run` は `gh project field-list` も呼ばないため、`--target-status <status>` の存在検証は実行時まで遅延する。invalid な status を指定した場合は本実行で `StatusOptionNotFoundError` で落ちる)
- exit code: 成功 0 / 安全条件違反 / 実行失敗 1

## 非機能要件

- **性能**: GitHub API 呼び出しは tick あたり最大 4 回 (`fetchProjectContext` の GraphQL 1 回 / `getIssue` 1 回 / `listOpenPullRequests` 1 回 / `gh project item-edit` 経由 1 回 + `gh project field-list` 経由 1 回)
- **可用性**: 単一コマンド・単一ターン実行。実行中にクラッシュした場合の中間状態 (worktree 削除完了 → Status 書き戻し失敗 等) は手動で再実行すれば回復する (worktree 既不在は無視、Status は idempotent)
- **セキュリティ**:
  - GitHub 認証は既存の `resolveGitHubToken` 経路を流用 (env / `gh auth` / auto)。`gh project item-edit` は env (`GITHUB_TOKEN` / `GH_TOKEN`) を自動で拾う
  - prompt 本文 / token 等の機微情報は stdout/stderr に出さない
- **アクセシビリティ**: 該当しない (CLI のみ)

## ADR-0005 との関係

ADR-0005 は「orchestrator は Status field を **読むだけ**、書かない」と決めている。本コマンドは **手動の user-initiated 復旧操作** であり、auto-dispatch 経路とは別モードのため、orchestrator が直接 GraphQL mutation で Status を書く代わりに **agent と同じ `gh project item-edit` 経路** を取る。これにより:

- ADR-0005 の境界 (orchestrator は GraphQL の write 系を持たない) を維持できる
- agent が普段使う Status 書き戻しと同じ option-id 解決経路を共有できる (Project Status options の表記揺れに同じ振る舞いをする)

新規 ADR は不要。

## データモデル

### `RetryPlan`

`philharmonic retry <issue>` 実行時に 1 件ずつ作るプラン。`--dry-run` でも `--no-dry-run` (= 実行モード) でも同じ shape を組み立てる。

```ts
type RetryPlan = {
  issueNumber: number;
  issueTitle: string;
  issueState: 'open' | 'closed';
  itemId: string; // Project Item ID
  projectId: string;
  currentStatus: string | null;
  targetStatus: string;
  willChangeStatus: boolean;
  /** worktree が `<workspace_root>/issue-<番号>` に存在するか */
  worktreePath: string;
  worktreeExists: boolean;
  /** `feature/<番号>-` 形式に一致したときのみ非 null */
  branch: string | null;
  branchDeletable: boolean; // shouldDeleteBranch の判定結果
  openPullRequests: ReadonlyArray<{ number: number; headRef: string; htmlUrl: string }>;
};
```

| フィールド         | 説明                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `currentStatus`    | Project Item から読んだ現在の Status (raw 文字列)。Status field 未設定なら null                                      |
| `targetStatus`     | 書き戻し先の Status 文字列。default は `dispatch_statuses[0]` (= 通常 `Todo`)。`--target-status` で上書き可          |
| `willChangeStatus` | `currentStatus !== targetStatus` のとき true                                                                         |
| `worktreeExists`   | `<workspace_root>/issue-<番号>` の path 存在判定 (fs.stat ベース)                                                    |
| `branch`           | `git worktree list --porcelain` で対象 worktree が見えれば、その branch ref。`feature/<番号>-` で始まらないなら null |
| `branchDeletable`  | `shouldDeleteBranch(taskKey, branch)` の戻り値。main 等を構造的に保護するためのガード                                |
| `openPullRequests` | `head.ref` が `feature/<番号>-` で始まる open PR の一覧 (上限 100 件、推測順)。`--force` なしで 1 件以上あれば abort |

## API / インターフェース

### CLI

```sh
philharmonic retry <issue-number> [--dry-run] [--target-status <status>] [--force] [-c <config>]
```

| オプション                 | 説明                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<issue-number>` (必須)    | 再実行したい Issue 番号 (正の整数)                                                                               |
| `--dry-run`                | plan を stdout に表示するだけで `gh project item-edit` も `cleanupWorkspace` も呼ばない                          |
| `--target-status <status>` | 書き戻し先の Project Status 名。default は `dispatch_statuses[0]` (= 通常 `Todo`)                                |
| `--force`                  | open PR があっても続行する                                                                                       |
| `-c, --config <path>`      | 設定ファイルのパス (default: `.philharmonic/philharmonic.yaml`、不在なら legacy `philharmonic.yaml` に fallback) |

### 内部処理フロー

```
1. Bootstrap (既存と同じ)
   1.1 .philharmonic/philharmonic.yaml を loadConfig
   1.2 GITHUB_TOKEN を resolveGitHubToken
   1.3 GitHubClient / ProjectsClient / WorkspaceManager を生成
2. Plan 構築
   2.1 projectsClient.fetchProjectContext で {projectId, candidates} を取得
   2.2 candidates から target issueNumber に一致する Candidate を探す。無ければ exit 1
   2.3 githubClient.getIssue で最新 state / title を取得 (closed なら exit 1)
   2.4 githubClient.listOpenPullRequests で `feature/<番号>-` prefix の open PR を確認
   2.5 listIssueWorktrees で対象 worktree のパス + 既存 branch を確認
   2.6 RetryPlan を組み立てる
3. 安全条件チェック
   3.1 issue.state === 'open' でなければ abort (3.0 で既に弾いているので念のため)
   3.2 openPullRequests.length > 0 かつ --force でなければ abort
4. Plan 表示 (stdout)
5. --dry-run の場合は exit 0 (副作用ゼロ)
6. 実行
   6.1 worktreeExists なら workspaceManager.cleanupWorkspace({ taskKey, branch?, deleteBranch })
       - deleteBranch は branchDeletable のときのみ true
   6.2 willChangeStatus なら updateProjectItemStatus(runGh, { ... }) で gh project item-edit を呼ぶ
       - target option name → option id 解決は `gh project field-list` で行う
       - status_field 名 (config.statusField) と target_status を case-sensitive で一致させる
   6.3 結果を stdout に出す
7. exit 0
```

### `ProjectsClient.fetchProjectContext`

既存 `fetchProjectCandidates` と同じ GraphQL query を流用しつつ、レスポンスから project ID も plumb する read-only な拡張。

```ts
type ProjectContext = {
  projectId: string;
  candidates: readonly Candidate[];
};

type ProjectsClient = {
  fetchProjectCandidates(input): Promise<Candidate[]>;
  fetchProjectContext(input): Promise<ProjectContext>;
};
```

`fetchProjectCandidates` は backward 互換のため残す (既存の orchestration / recovery / serve は触らない)。

### `updateProjectItemStatus`

`src/projects/status-update.ts` (新規) に置く。`gh` CLI subprocess に依存する write 操作のためテスト容易性目的で `runGh` を DI 可能にする。

```ts
type GhRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

type UpdateProjectItemStatusInput = {
  owner: string;
  projectNumber: number;
  projectId: string;
  itemId: string;
  statusFieldName: string; // = config.statusField
  targetStatus: string;
};

async function updateProjectItemStatus(
  runGh: GhRunner,
  input: UpdateProjectItemStatusInput,
): Promise<void>;
```

内部で 2 回 `gh` を呼ぶ:

1. `gh project field-list <projectNumber> --owner <owner> --format json` → `statusFieldName` に一致する `ProjectV2SingleSelectField` を探し、`options[]` から `targetStatus` に一致する option ID を解決
2. `gh project item-edit --id <itemId> --project-id <projectId> --field-id <fieldId> --single-select-option-id <optionId>` → 書き戻し

field name / option name が見つからなければ専用エラーメッセージで throw する (CLI 側で stderr に出して exit 1)。

### Plan の表示形式

stdout 出力例 (`--dry-run` 時):

```
plan for issue #42
  current status: In Progress
  target status:  Todo  (will update via gh project item-edit)
  worktree:       .philharmonic/worktrees/issue-42  (will cleanup)
  branch:         feature/42-foo  (will delete)
  open PRs:       none

dry-run: no changes applied
```

実行時の最終出力例:

```
plan for issue #42
  current status: In Progress
  target status:  Todo  (will update via gh project item-edit)
  worktree:       .philharmonic/worktrees/issue-42  (will cleanup)
  branch:         feature/42-foo  (will delete)
  open PRs:       none

removed worktree .philharmonic/worktrees/issue-42
updated status In Progress -> Todo
done issue=#42
```

すでに target と同じ Status / worktree 不在の場合は `(no change)` を該当行に付ける。

## 自動 retry queue (in-memory) との交互作用

`philharmonic serve` の retry queue (#84 / ADR-0008) は **daemon プロセス内 in-memory** であり、`philharmonic retry` (別プロセスの一発 CLI) からは直接触れない。Snapshot HTTP API も read-only で eviction エンドポイントは持たない。

そのため本コマンドは以下のように振る舞う:

- `philharmonic retry <issue>` は **Project Status と worktree の reset** のみを行う
- 同 Issue の retry queue entry が serve 内に残っているなら、`dueAt` 到来時の `drainRetryQueue` が再度 `getIssue` / `fetchProjectCandidates` を呼んで Status を再判定する。dispatch 対象 status (= 本コマンドが書き戻した値) を見て普通に dispatch される
- CLI から in-memory retry queue を即時 evict する手段は提供しない。retry queue は serve 停止 / 再起動で消える

この扱いは spec として明記する (= 利用者は「retry CLI で reset したから serve も即座に拾う」と期待してよい)。

## エラーハンドリング

| エラー                                      | 発生条件                                                        | 扱い方針                                                             |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Issue が Project Item として存在しない      | `fetchProjectContext` の candidates に対象 issueNumber が居ない | stderr に `issue #N is not in project ...` を出して exit 1           |
| Issue が GitHub 上で close 済み             | `getIssue` の `state === 'closed'`                              | stderr に `issue #N is closed` を出して exit 1                       |
| open PR がある (`--force` なし)             | `listOpenPullRequests` の戻り値が 1 件以上                      | stderr に PR 一覧と再実行ヒントを出して exit 1                       |
| `--target-status` が field の option に無い | `gh project field-list` の結果に該当 option が見つからない      | stderr に `target status '...' not found in field options` で exit 1 |
| `gh project item-edit` が non-zero exit     | gh が認証 / 権限 / network エラー                               | stderr に gh stderr 抜粋を出して exit 1                              |
| `cleanupWorkspace` が失敗                   | git コマンド失敗 (lock / 権限 / disk)                           | stderr に詳細を出して exit 1。Status 書き戻しは行わない (順序固定)   |
| `loadConfig` / `resolveGitHubToken` 失敗    | 既存と同じ                                                      | 既存 CLI と同じ整形で stderr → exit 1                                |

## 外部依存

- 既存 GitHub Octokit 経路 (`getIssue` / `listOpenPullRequests` / `fetchProjectContext` GraphQL)
- **`gh` CLI** — `gh project field-list` / `gh project item-edit` を subprocess で呼ぶ。auth は env (`GITHUB_TOKEN` / `GH_TOKEN`) または host の `gh auth login` (既存の token resolve 経路と同じ前提)
- 既存 `WorkspaceManager.cleanupWorkspace` / `listIssueWorktrees` / `shouldDeleteBranch`

## オープンクエスチョン

- `--target-status` を multiple Status に対応させるべきか (例: 複数 dispatch_statuses が並ぶ運用)。default は `dispatch_statuses[0]` で十分と判断したが、複雑な運用では設定/CLI を拡張する余地あり
- 同じ feature ブランチで commit が積まれている場合の保護 (= worktree 内の uncommitted change の保護) は本 spec の対象外。`cleanupWorkspace` は `--force` で worktree を消すため、ユーザは事前に `git stash` / `git push` を済ませる前提
- **動作中の serve との race**: 対象 Issue が serve daemon で in-flight (= runner 起動中) のときに retry CLI を実行すると、`cleanupWorkspace` が動作中の worktree を破壊しうる。本 spec では「retry CLI は自動 retry で復旧できなかった fallback」想定で in-flight 検知は実装しないが、安全側に倒すなら以下のいずれかを将来追加する:
  - `.philharmonic/serve.lock` の存在を見て serve 動作中なら default abort (`--force` でも警告のみ続行)
  - Snapshot HTTP API (`/api/v1/<issue>`) を叩いて in-flight 判定し、in-flight なら abort (`server.port` 設定時のみ有効)
  - 当面は guide ([operations.md](../guide/operations.md#philharmonic-retry-issue-number--手動再実行)) で「実行前に dashboard / Snapshot API で `running[]` を確認」と運用面でカバーする
- 並列対応: 同一 Issue の二重 retry CLI 実行は想定しない (1 ユーザが 1 ターミナルで連打しない前提)
