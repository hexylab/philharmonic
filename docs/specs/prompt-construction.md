# Prompt Construction

## 概要

GitHub Issue 本文の `## Goal` / `## Constraints` / `## Acceptance Criteria` セクションを抽出し、Orchestrator が追加する制約と Runner 向け Definition of Done チェックリストを末尾に連結して、Claude Code Runner に渡す prompt 文字列を 1 つ生成する **pure 関数モジュール** の仕様。orchestration-mvp.md「5. Prompt Construction」「Claude Code Runner Prompt Construction」セクションを補完する。

## 関連 Issue

- #17 — Issue body から prompt を組み立てる Prompt Construction を実装する
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)
- 上位フロー: [orchestration-mvp.md](./orchestration-mvp.md) の「5. Prompt Construction」「Claude Code Runner Prompt Construction」
- Runner 仕様: [claude-runner.md](./claude-runner.md) (生成された prompt の受け手)

## 用語と登場アクター

| 用語             | 意味                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** | `philharmonic` CLI 本体。Issue body 取得・prompt 構築・Runner 起動・PR 作成までを 1 ターンで実行する Node.js プロセス                  |
| **Runner**       | Claude Code CLI を headless mode で起動した子プロセス                                                                                  |
| **prompt**       | 本仕様で定義する関数の出力。Runner の `-p` 引数として渡される 1 つの文字列                                                             |
| **Section**      | Issue body Markdown 中の `## <ヘッダ>` で区切られたブロック。本仕様は Goal / Constraints / Acceptance Criteria の 3 つを必須として扱う |

## 要件

Issue #17 の Acceptance Criteria を満たすために、以下を実現する。

- `buildPrompt(input): string` という stateless / 副作用なしの API を提供する
- Issue body から `## Goal` / `## Constraints` / `## Acceptance Criteria` の 3 セクションを抽出し、それぞれの本文を prompt にそのまま貼り付ける
- Orchestrator 側が追加する制約を Constraints セクション末尾に必ず追記する (push しない / PR 作らない / GitHub token を期待しない / Conventional Commits)
- Runner が満たすべき範囲の Definition of Done チェックリストを prompt 末尾に追加する
- 必須セクション欠損時 (ヘッダがない / セクション本文が空白のみ) は構造化エラーで失敗する。呼び出し側で Failure に倒せるようにエラーオブジェクトには `code` と `missingSections` を含める
- prompt 本体は run-id ディレクトリ配下に `prompt.md` として保存する仕様にする (永続化処理は本 Issue の対象外。orchestrator wiring を扱う後続 Issue で実装)

## 責務分割

| 責務                                              | 担当                              |
| ------------------------------------------------- | --------------------------------- |
| Issue body の取得 (REST API 呼び出し)             | Orchestrator (本モジュール対象外) |
| Issue body から Section を抽出                    | 本モジュール                      |
| Orchestrator 追加制約 / Runner 向け DoD の連結    | 本モジュール                      |
| 生成された prompt の永続化 (`<run-id>/prompt.md`) | Orchestrator (後続 Issue)         |
| 生成された prompt の Runner への引き渡し          | Orchestrator (後続 Issue)         |

本モジュールは Issue body 文字列とメタ情報のみを入力に取り、I/O を一切行わない pure 関数として実装する。これにより単体テストで完結する。

## 非機能要件

- **性能**: 文字列処理のみ。Issue body は GitHub API の制約上 64KiB を超えない想定で、O(n) で処理する
- **可用性**: 該当しない (内部モジュール)
- **セキュリティ**:
  - prompt 本文に GitHub token を含めない (本モジュールは token を受け取らないことで担保)
  - Issue body をそのまま貼り付けるため、Issue body に意図的な prompt injection が含まれる可能性はあるが、本モジュールはそのまま渡すのみとし、上位での審査 (将来の Issue で検討) に委ねる
- **アクセシビリティ**: 該当しない (内部モジュール)

## データモデル

### `BuildPromptInput`

| キー            | 型                                | 必須 | 説明                                                              |
| --------------- | --------------------------------- | ---- | ----------------------------------------------------------------- |
| `repository`    | `{ owner: string; name: string }` | yes  | リポジトリの owner / 名前。Context セクションに表示される         |
| `baseBranch`    | `string`                          | yes  | base ブランチ名。設定既定の `main` を呼び出し側で解決した値を渡す |
| `issueNumber`   | `number`                          | yes  | 対象 Issue の番号                                                 |
| `issueTitle`    | `string`                          | yes  | Issue タイトル                                                    |
| `issueUrl`      | `string`                          | yes  | Issue の HTML URL (Context セクションに表示される)                |
| `issueBody`     | `string`                          | yes  | Issue body (Markdown)。CRLF が混じることを許容する                |
| `workspacePath` | `string`                          | yes  | Runner の `cwd` となる worktree の絶対パス                        |

`workspacePath` の存在確認や絶対パス validation は本モジュールでは行わない (Workspace Manager の責務)。Runner との整合上「絶対パスを期待する」と spec に明記する。

### Section 抽出仕様

- ヘッダの認識: 行頭が `## ` (ハッシュ 2 個 + 半角スペース) で始まる行をセクション境界とする
- 大文字小文字を区別する。`## goal` は `## Goal` とは別物として扱う (GitHub Issue テンプレートに準拠)
- ヘッダ行のラベル部はトリム (前後の空白 / タブを除去) する。`## Goal ` `## Goal\t` を許容
- セクション本文は次の `## ` ヘッダ直前または body 末尾までの全行 (ヘッダ行自体は含まない)
- 本文の前後 (空白 / 改行) はトリムする
- **コードフェンス** (` ``` `) 内に現れる `## Goal` 等は header として扱わない (` ``` ` の出現で in-fence フラグをトグルする)
- **CRLF** は `\n` に正規化してから処理する

### 必須セクション

| セクションキー        | 期待ヘッダ               |
| --------------------- | ------------------------ |
| `goal`                | `## Goal`                |
| `constraints`         | `## Constraints`         |
| `acceptance_criteria` | `## Acceptance Criteria` |

いずれか 1 つでも欠けている、または本文がトリム後に空文字となる場合、`MissingPromptSectionError` を throw する。

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
};

export function buildPrompt(input: BuildPromptInput): string;

export type IssueBodySectionKey = 'goal' | 'constraints' | 'acceptance_criteria';

export type ParsedIssueBody = {
  goal: string;
  constraints: string;
  acceptanceCriteria: string;
};

export function parseIssueBody(body: string): ParsedIssueBody;

export class MissingPromptSectionError extends Error {
  readonly code: 'missing_prompt_section';
  readonly missingSections: readonly IssueBodySectionKey[];
}
```

`parseIssueBody` も export し、欠損時は `MissingPromptSectionError` を throw する。`buildPrompt` 内部から使う。

## prompt の構造 (output)

`buildPrompt` は次の順序でセクションを連結した 1 つの文字列を返す。各セクションの間は空行 1 行で区切る。

```
# Context

- Repository: <owner>/<name>
- Base branch: <baseBranch>
- Issue: #<number> <title>
- Issue URL: <url>
- Workspace (worktree, absolute path): <workspacePath>
- 必ずリポジトリの `AGENTS.md` および `CLAUDE.md` を参照してから着手すること

# Goal

<Issue body の ## Goal セクション本文をそのまま貼り付け>

# Constraints

<Issue body の ## Constraints セクション本文をそのまま貼り付け>

## Orchestrator からの追加制約

- `git push` を実行しないこと (push は Orchestrator が行う)
- Pull Request を作成しないこと (PR 作成は Orchestrator が行う)
- GitHub token を期待しないこと (token は Runner プロセスに渡されない)
- 現在の worktree のブランチ上で [Conventional Commits](https://www.conventionalcommits.org/) 形式で commit すること

# Acceptance Criteria

<Issue body の ## Acceptance Criteria セクション本文をそのまま貼り付け>

# Definition of Done (Runner 向け)

- [ ] Issue の Acceptance Criteria をすべて満たしている
- [ ] ローカルで CI 相当のチェック (`format` / `lint` / `unit-test`) が green である
- [ ] 必要なドキュメント (`docs/adr/` の ADR、`docs/specs/` の仕様書) を作成・更新している
- [ ] コミットメッセージが Conventional Commits に準拠している
```

### Constraints の順序が固定である理由

Issue body 由来の Constraints を **先** に置き、Orchestrator 追加分を **後** に置く。順序を逆にすると、後発の Issue Constraints が Orchestrator 制約を上書きする (= push する / PR を作る) ように読める恐れがあるため。順序が固定であることはユニットテストで明示的に検証する。

### Definition of Done のソース

`AGENTS.md` セクション 6 (Definition of Done) のうち、Runner が単体で満たせる範囲のみを抜粋した。除外項目とその理由:

| 除外項目                                          | 理由                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 「CI が green である」(リモート CI)               | Runner は push を行わないため、リモート CI を起動できない。代わりにローカルでの相当チェックを要求する |
| 「PR テンプレートのすべての項目が記入されている」 | PR 作成は Orchestrator の責務 (orchestration-mvp.md「PR 作成方針」)                                   |
| 「レビュー承認を得ている」                        | 人間レビュアーの責務                                                                                  |

`AGENTS.md` の Definition of Done が改定された場合、本モジュール側の DoD チェックリストも追従させる責務がある。DRY を取らずに hardcode するのは「Runner 向けに項目を取捨選択する」という変換が必要なため。

### prompt の永続化 (本 Issue の対象外)

orchestration-mvp.md の通り `<run-id>/prompt.md` に保存される。本 Issue では永続化処理は実装しない。pure 関数の戻り値を上位 (Orchestrator wiring を担う後続 Issue) で `prompt.md` に書く。

## エラーハンドリング

| エラー                      | 発生条件                                        | 扱い方針                                                                                             |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `MissingPromptSectionError` | 必須セクションのいずれかが欠損 / 本文が空白のみ | throw。`missingSections` に欠損キーを配列で含める。Orchestrator は `In Progress → Failed` 遷移に倒す |

呼び出し側は `error instanceof MissingPromptSectionError` で判定し、Issue へのコメント本文には `missingSections` をそのまま含めてよい (PII / token を含まない)。

## 外部依存

なし。Node.js 標準のみで動作する。

## オープンクエスチョン

- 将来 Issue body に追加で含めたい情報 (例: 関連 PR のリンク、過去 run のサマリ) のサポート方針
- prompt injection 対策 (Issue body に「ignore previous instructions」等が含まれる場合の handling) — 本 Issue 範囲外、後続 Issue で検討
- ヘッダラベルの揺れ (`## Goals` / `## Constraint` 等の typo) を許容するか — 現時点では厳格一致のみ。Issue テンプレートで揺れを抑制する方針

## MVP でやらないこと

- Issue body の取得 (REST 呼び出し)
- prompt の永続化 (`<run-id>/prompt.md` への書き出し)
- prompt injection sanitization
- AGENTS.md からの DoD 自動抽出 (hardcode する)
- 国際化 (本文は日本語固定)
