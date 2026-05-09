# WORKFLOW.md (Prompt Templating)

## 概要

リポジトリ内の Markdown ファイル (デフォルト `WORKFLOW.md`) を Claude Code Runner 用 prompt の **上位レイヤ** として扱い、Liquid テンプレートで Issue 情報・attempt 番号・workspace パス等を埋め込めるようにする。`WORKFLOW.md` が無いリポジトリでは [prompt-construction.md](./prompt-construction.md) の `buildPrompt` を **下位レイヤ** としてフォールバック利用する。安全制約 (push しない / PR 作らない / token 期待しない / Conventional Commits) は Orchestrator が無条件で末尾に連結する。

## 関連 Issue

- #27 — WORKFLOW.md 相当の in-repo prompt + テンプレートエンジン + hot-reload を実装する
- 設計前提: [ADR-0003 prompt templating](../adr/0003-prompt-templating.md)
- 下位レイヤ: [prompt-construction.md](./prompt-construction.md)
- 上位フロー: [orchestration-mvp.md](./orchestration-mvp.md) の「5. Prompt Construction」「Claude Code Runner Prompt Construction」
- 設定: [config-schema.md](./config-schema.md)

## 用語と登場アクター

| 用語                 | 意味                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **WORKFLOW.md**      | リポジトリ直下に置かれる Liquid テンプレートファイル (ファイル名は config で変更可)                                        |
| **WorkflowSource**   | `src/workflow/` モジュールが提供する prompt 構築ハンドル。dispatch ごとに `render(vars)` が呼ばれ prompt 文字列を返す      |
| **テンプレート上位** | `WORKFLOW.md` が存在する場合、テンプレート本体が prompt の主構造を決める                                                   |
| **テンプレート下位** | テンプレート不在時の `buildPrompt` フォールバック、およびテンプレート末尾に連結される `Orchestrator からの追加制約` フッタ |

## 要件

Issue #27 の Acceptance Criteria を満たすために、以下を実現する。

- `WORKFLOW.md` パーサとテンプレート展開を `src/workflow/` に実装し、単体テストで検証する
- ファイル変更後の **新規 dispatch** が新しい prompt を生成することを単体テストで検証する (in-flight に影響しないことは render 結果が immutable な string であることで担保)
- テンプレートエンジン選定は ADR-0003 で `Accepted` 化する
- 本仕様書および `orchestration-mvp.md` / `prompt-construction.md` を更新する

### WorkflowSource API

```ts
export type WorkflowVariables = {
  repository: { owner: string; name: string };
  base_branch: string;
  issue: {
    number: number;
    title: string;
    url: string;
    body: string;
    goal: string;
    constraints: string;
    acceptance_criteria: string;
  };
  workspace_path: string;
  attempt: number;
  run_id: string;
};

export interface WorkflowSource {
  render(vars: WorkflowVariables): Promise<string>;
  close(): Promise<void>;
}

export type CreateWorkflowSourceOptions = {
  workflowPath: string;
  watch?: boolean; // default: false
  logger?: Logger;
};

export function createWorkflowSource(options: CreateWorkflowSourceOptions): Promise<WorkflowSource>;
```

- `workflowPath` は呼び出し側で `path.resolve(repoRoot, config.workflowFile)` した絶対パスを渡す
- `watch=true` のときのみ `fs.watch` を仕掛け、変更検出時に内部キャッシュを invalidate して `workflow reloaded` ログを 1 行 INFO で出す。`philharmonic serve` から有効化する
- `close()` は `fs.watch` を解除する。`watch=false` のときは何もしない

### prompt 構造 (テンプレート出力)

```
<WORKFLOW.md を Liquid で render した結果>

## Orchestrator からの追加制約

- `git push` を実行しないこと (push は Orchestrator が行う)
- Pull Request を作成しないこと (PR 作成は Orchestrator が行う)
- GitHub token を期待しないこと (token は Runner プロセスに渡されない)
- 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit すること
```

- `Orchestrator からの追加制約` セクションは Orchestrator が **無条件で** 末尾に連結する。テンプレート側でこのセクションを書いていても重複する点はユーザの選択 (= 重複しないように書くか、Orchestrator フッタに任せるか) に委ねる
- 末尾は改行 1 つで終わる (既存 `buildPrompt` と同じ整形)

### `WORKFLOW.md` 不在時の挙動

- 既存 `buildPrompt(input)` にフォールバックして従来どおり prompt を組み立てる
- この場合 Orchestrator フッタは従来どおり Constraints セクション末尾に埋め込まれた形 (= ADR-0003 の「テンプレートあり」の場合とは出力位置が異なる) で出る
- `philharmonic.yaml` で `workflow_file` を明示指定しているのに ファイルが無い場合は **エラー** (typo を疑うべきため)。デフォルト `WORKFLOW.md` のままで無い場合のみフォールバックを許す

### `attempt` の解決

- `philharmonic run` (1 ターン実行) では **常に `1`**
- `philharmonic serve` daemon は `RetryScheduler` の state を読んで以下のように決める:
  - 過去に Failed 履歴あり (state にエントリあり) → `attempts + 1` (今回試行が何回目かを示す)
  - 履歴なし → `1`
- 値の解決は `dispatchSelected` の呼び出し元 (CLI レイヤ) が行う

### hot-reload の挙動

| 動作                                      | 結果                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| dispatch ごとにファイル読み直し           | 新規 dispatch から新内容が反映される                                      |
| `philharmonic serve` での `fs.watch` 監視 | 変更検出で `workflow reloaded` を INFO で 1 行出す (運用観測性向上)       |
| in-flight run への影響                    | 無し (render 結果は string で immutable、Runner 起動後に変更されない)     |
| `WORKFLOW.md` が削除された後              | 次の dispatch でフォールバック (デフォルト名のみ) または失敗 (明示指定時) |
| `fs.watch` が platform 都合で動かない     | dispatch ごとの読み直しは継続するため AC は満たされる                     |

## 非機能要件

- **性能**: ファイル I/O とテンプレート render のみ (1 dispatch あたり最大 1 回)。Issue body と同程度のサイズで O(n)
- **可用性**: `WORKFLOW.md` 読み込み失敗 / parse 失敗時は dispatch を `Failed` に倒す。daemon ループは継続
- **セキュリティ**:
  - Liquid の安全側仕様により、テンプレート内での任意 JS 実行を行わない
  - `liquidjs` の `Liquid` インスタンスは `globals` をベース context として渡し、render 中の副作用を受け付けないように構成する
  - GitHub token はテンプレート変数として渡さない
- **アクセシビリティ**: 該当しない (内部モジュール)

## データモデル

### `WorkflowVariables` (snake_case でテンプレートに公開)

| キー                        | 型     | 例                                                         |
| --------------------------- | ------ | ---------------------------------------------------------- |
| `repository.owner`          | string | `hexylab`                                                  |
| `repository.name`           | string | `philharmonic`                                             |
| `base_branch`               | string | `main`                                                     |
| `issue.number`              | number | `27`                                                       |
| `issue.title`               | string | `WORKFLOW.md ...`                                          |
| `issue.url`                 | string | `https://github.com/hexylab/philharmonic/issues/27`        |
| `issue.body`                | string | Issue body 全文                                            |
| `issue.goal`                | string | `parseIssueBody` 結果の `## Goal` 本文                     |
| `issue.constraints`         | string | `parseIssueBody` 結果の `## Constraints` 本文              |
| `issue.acceptance_criteria` | string | `parseIssueBody` 結果の `## Acceptance Criteria` 本文      |
| `workspace_path`            | string | `/home/runner/.philharmonic/worktrees/issue-27` (絶対パス) |
| `attempt`                   | number | 1, 2, ... (今回が何回目の試行か)                           |
| `run_id`                    | string | UUIDv7                                                     |

`issue.body` を貼り付ける場合、テンプレート側で `## Goal` 等のヘッダごと貼り付くため、`issue.goal` のような事前抽出済みフィールドを使うほうが prompt が清潔になる。

### サンプル `WORKFLOW.md`

```liquid
# {{ repository.owner }}/{{ repository.name }} — Task #{{ issue.number }}

- Issue: [#{{ issue.number }} {{ issue.title }}]({{ issue.url }})
- Workspace: {{ workspace_path }}
- Attempt: {{ attempt }}
- Run ID: `{{ run_id }}`

## Goal

{{ issue.goal }}

## Constraints (from Issue)

{{ issue.constraints }}

## Acceptance Criteria

{{ issue.acceptance_criteria }}

{% if attempt > 1 %}
## Retry Notice

This is attempt #{{ attempt }}. Investigate why the previous attempts failed before re-doing the work.
{% endif %}
```

このテンプレートの末尾に Orchestrator が `Orchestrator からの追加制約` セクションを連結して、Runner に渡す。

## API / インターフェース

`src/workflow/index.ts` から以下を export する。

```ts
export type { WorkflowSource, WorkflowVariables, CreateWorkflowSourceOptions } from './source.js';
export { createWorkflowSource } from './source.js';
export { WorkflowFileNotFoundError, WorkflowReadError, WorkflowRenderError } from './errors.js';
```

`createWorkflowSource` は内部で:

1. `workflowPath` が存在するか確認 (存在しない & デフォルト名 → fallback モード)
2. 存在する場合は `liquidjs` の `Liquid` インスタンスでパース。parse error は `WorkflowRenderError` で返す
3. `watch=true` のときのみ `fs.watch(workflowPath)` を仕掛け、変更検出時に内部キャッシュを invalidate
4. 各 `render(vars)` 呼び出し時に **必ずファイル mtime をチェック** し、変更があれば再読み込み (キャッシュは「同一 mtime ならパース結果を再利用する」程度の最低限)
5. fallback モードの `render(vars)` は内部で `buildPrompt(input)` を呼ぶ。`vars` から `BuildPromptInput` への変換は `variables.ts` の helper が担う

## エラーハンドリング

| エラー                      | 発生条件                                           | 扱い方針                                                                    |
| --------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `WorkflowFileNotFoundError` | `workflow_file` を明示指定しているのにファイル不在 | `dispatchSelected` で catch → `runner_error` 系の Failed (Issue にコメント) |
| `WorkflowReadError`         | I/O エラー (権限・破損)                            | 同上                                                                        |
| `WorkflowRenderError`       | Liquid parse / render エラー                       | 同上                                                                        |
| `MissingPromptSectionError` | `parseIssueBody` が必須セクションを抽出できない    | 既存挙動 (Failed)                                                           |

## 外部依存

- `liquidjs` (新規追加。MIT)
- `node:fs` / `node:fs/promises` / `node:path` (Node.js 標準)

## オープンクエスチョン

- テンプレート partial / `include` のサポート: `liquidjs` には `Liquid({ root: ... })` で fs root を渡す機能があるが、本 Issue 範囲では partial 機能は無効化する (リポジトリ全体を読み出される副作用を避けるため)。サポートが必要になったら別 Issue で再検討
- テンプレートからの worktree ファイル参照: 同上、不可
- `WORKFLOW.md` の lint / dry-run コマンド: 後続 Issue で検討
- attempt 番号の意味付けの拡張 (例: `previous_failure_reason` を埋め込む): 別 Issue で検討

## MVP でやらないこと

- partial / include / カスタムフィルタ
- テンプレート以外のファイル読み込み (raw includes 等)
- `philharmonic dry-run` 系の prompt プレビュー CLI
- attempt 以外の retry コンテキスト埋め込み
- `WORKFLOW.md` の i18n
