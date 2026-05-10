# Prompt Construction

## 概要

Claude Code Runner に渡す prompt 文字列を構築する **pure 関数モジュール** の仕様。Issue body を構造化抽出せず本文をそのまま貼り付け、Context (リポジトリ / 作業 worktree 情報) と Orchestrator フッタ (agent への委譲指示) を前後に連結する。orchestration-mvp.md「4. Prompt Construction」「Claude Code Runner Prompt Construction」セクションを補完する。

`WORKFLOW.md` (上位レイヤ) と本モジュール (下位レイヤ) の関係は [workflow.md](./workflow.md) を参照。`WORKFLOW.md` が存在しない場合のフォールバック実装が本モジュールであり、テンプレート不在時の prompt 構造は本仕様に従う。

## 関連 Issue

- #17 — Issue body から prompt を組み立てる Prompt Construction を実装する
- #27 — WORKFLOW.md (Liquid テンプレート) を上位レイヤに導入する (本モジュールはフォールバック)
- #62 — 構造化セクション抽出を撤廃し、Issue 本文をそのまま渡す
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md), [ADR-0003 prompt templating](../adr/0003-prompt-templating.md), [ADR-0005 薄い orchestrator + agent 委譲型 hybrid](../adr/0005-thin-orchestrator-agent-delegation.md)
- 上位フロー: [orchestration-mvp.md](./orchestration-mvp.md) の「4. Prompt Construction」「Claude Code Runner Prompt Construction」
- 上位レイヤ: [workflow.md](./workflow.md)
- Runner 仕様: [claude-runner.md](./claude-runner.md) (生成された prompt の受け手)

## 用語と登場アクター

| 用語             | 意味                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| **Orchestrator** | `philharmonic` CLI 本体。Issue body 取得・prompt 構築・Runner 起動までを 1 ターンで実行する Node.js プロセス |
| **Runner**       | Claude Code CLI を headless mode で起動した子プロセス                                                        |
| **Agent**        | Runner 内で動く Claude Code。prompt 指示に従い Status 遷移 / commit / push / PR 作成 / コメント投稿を行う    |
| **prompt**       | 本仕様で定義する関数の出力。Runner の `-p` 引数として渡される 1 つの文字列                                   |

## 要件

- `buildPrompt(input): string` という stateless / 副作用なしの API を提供する
- Issue body は **構造化セクションを抽出せずそのまま貼り付ける** (ADR-0005)
- Orchestrator が agent に委譲する指示 (Definition of Done) を prompt 末尾に必ず追記する。内容は「Status 遷移 / commit / push / PR 作成 / 失敗時コメント / Conventional Commits」
- prompt 本体は run-id ディレクトリ配下に `prompt.md` として保存する仕様にする (永続化処理は orchestrator wiring 側で行う)
- Issue body が空文字でも prompt 構築は失敗しない (orchestrator は構築失敗時に Failure 扱いするが、構造化制約による失敗は撤廃)

## 責務分割

| 責務                                              | 担当                              |
| ------------------------------------------------- | --------------------------------- |
| Issue body の取得 (REST API 呼び出し)             | Orchestrator (本モジュール対象外) |
| Context / Orchestrator フッタの組み立て           | 本モジュール                      |
| 生成された prompt の永続化 (`<run-id>/prompt.md`) | Orchestrator                      |
| 生成された prompt の Runner への引き渡し          | Orchestrator                      |

本モジュールは Issue body 文字列とメタ情報のみを入力に取り、I/O を一切行わない pure 関数として実装する。

## 非機能要件

- **性能**: 文字列処理のみ。Issue body は GitHub API の制約上 64KiB を超えない想定で、O(n) で処理する
- **可用性**: 該当しない (内部モジュール)
- **セキュリティ**:
  - prompt 本文に GitHub token を含めない (本モジュールは token を受け取らないことで担保)
  - Issue body をそのまま貼り付けるため、Issue body に意図的な prompt injection が含まれる可能性はあるが、本モジュールはそのまま渡すのみとし、上位での審査 (将来の Issue で検討) に委ねる
- **アクセシビリティ**: 該当しない (内部モジュール)

## データモデル

### `BuildPromptInput`

| キー                | 型                                                         | 必須 | 説明                                                                                                      |
| ------------------- | ---------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `repository`        | `{ owner: string; name: string }`                          | yes  | リポジトリの owner / 名前。Context セクションに表示される                                                 |
| `baseBranch`        | `string`                                                   | yes  | base ブランチ名。設定既定の `main` を呼び出し側で解決した値を渡す                                         |
| `issueNumber`       | `number`                                                   | yes  | 対象 Issue の番号                                                                                         |
| `issueTitle`        | `string`                                                   | yes  | Issue タイトル                                                                                            |
| `issueUrl`          | `string`                                                   | yes  | Issue の HTML URL (Context セクションに表示される)                                                        |
| `issueBody`         | `string`                                                   | yes  | Issue body (Markdown)。空文字も許容                                                                       |
| `workspacePath`     | `string`                                                   | yes  | Runner の `cwd` となる worktree の絶対パス                                                                |
| `project`           | `{ owner: string; number: number; statusField: string }`   | yes  | `philharmonic.yaml` の `owner` / `project_number` / `status_field`。Context に Project 情報として埋め込む |
| `statusTransitions` | `{ inProgress: string; inReview: string; failed: string }` | yes  | `philharmonic.yaml` の `status_transitions`。フッタの遷移先 Status 名をユーザ設定でカスタマイズ可能にする |

`workspacePath` の存在確認や絶対パス validation は本モジュールでは行わない (Workspace Manager の責務)。

### CRLF / 空文字の扱い

- Issue body の CRLF は `\n` に正規化してから処理する
- Issue body が空文字 / 空白のみの場合はそのまま空のセクションとして埋め込む (構造化制約による throw は行わない)

## API / インターフェース

```ts
export type BuildPromptInput = {
  repository: { owner: string; name: string };
  baseBranch: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  workspacePath: string;
  project: { owner: string; number: number; statusField: string };
  statusTransitions: { inProgress: string; inReview: string; failed: string };
};

export function buildPrompt(input: BuildPromptInput): string;
```

`parseIssueBody` / `MissingPromptSectionError` は撤廃 (ADR-0005)。

## prompt の構造 (output)

`buildPrompt` は次の順序でセクションを連結した 1 つの文字列を返す。各セクションの間は空行 1 行で区切る。

```
# Context

- Repository: <owner>/<name>
- Base branch: <baseBranch>
- Issue: #<number> <title>
- Issue URL: <url>
- Project: <project.owner>/projects/<project.number> (Status field: `<project.statusField>`)
- Workspace (worktree, absolute path): <workspacePath>
- 必ずリポジトリの `AGENTS.md` および `CLAUDE.md` を参照してから着手すること

# Issue 本文

<Issue body をそのまま貼り付け (空でも可)>

# Orchestrator からの追加指示

- 着手直後に Project Status を `<statusTransitions.inProgress>` に遷移する (`gh project item-edit` 等を使用)
- 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit する
- 作業完了後は `git push -u origin <branch>` で push する
- `gh pr create` で対応 Issue に紐づく Pull Request を作成し、本文に `Closes #<番号>` を含める
- PR 作成成功後は Project Status を `<statusTransitions.inReview>` に遷移する
- 失敗時は Project Status を `<statusTransitions.failed>` に遷移し、Issue に失敗の理由をコメントする (token / 機微情報を貼らない)
- GitHub の認証は環境変数 `GITHUB_TOKEN` / `GH_TOKEN` (Orchestrator が allowlist で透過) または host の `gh auth` を使う
```

`<statusTransitions.*>` には `philharmonic.yaml` の `status_transitions` の値がそのまま埋め込まれる (default は `In Progress` / `In Review` / `Failed`)。Orchestrator は値を解釈せず、Project の Status options に存在するかどうかは利用者の責務 (詳細: [config-schema.md](./config-schema.md))。

### Orchestrator フッタの内容

ADR-0005 で agent 委譲型に切り替わったため、フッタの内容は旧仕様 (push しない / PR 作らない / token 期待しない) から **agent が GitHub に書き込む** 前提に変わる。具体的な指示は上記サンプル参照。

### Definition of Done のソース

`AGENTS.md` セクション 6 (Definition of Done) のうち、Runner / agent が単体で満たせる範囲を抜粋した。除外項目とその理由:

| 除外項目                                          | 理由                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 「CI が green である」(リモート CI)               | Runner 実行時には未だ push されていない or push 直後で CI 待ち。Runner は push までを担当             |
| 「PR テンプレートのすべての項目が記入されている」 | テンプレート文言は agent が `gh pr create --body` で埋める範囲。orchestrator フッタは最小指示のみ提供 |
| 「レビュー承認を得ている」                        | 人間レビュアーの責務                                                                                  |

## エラーハンドリング

`MissingPromptSectionError` / `parseIssueBody` を撤廃したため、`buildPrompt` は **throw しない** (Issue body が空でも組み立てられる)。

I/O や API 呼び出しを伴う処理 (Issue body の取得、prompt の永続化、Runner への引き渡し) は orchestrator 側の責務で、それぞれが独立に Failure 処理に倒される。

## 外部依存

なし。Node.js 標準のみで動作する。

## オープンクエスチョン

- 将来 Issue body に追加で含めたい情報 (例: 関連 PR のリンク、過去 run のサマリ) のサポート方針
- prompt injection 対策 (Issue body に「ignore previous instructions」等が含まれる場合の handling) — 後続 Issue で検討

## MVP でやらないこと

- Issue body の取得 (REST 呼び出し)
- prompt の永続化 (`<run-id>/prompt.md` への書き出し)
- prompt injection sanitization
- AGENTS.md からの DoD 自動抽出 (hardcode する)
- 国際化 (本文は日本語固定)
