# ADR-0003: WORKFLOW.md の prompt テンプレートエンジンに LiquidJS を採用する

- **ステータス**: Accepted (一部 Superseded by [ADR-0005](./0005-thin-orchestrator-agent-delegation.md))
- **決定日**: 2026-05-09

> **NOTE (2026-05-10)**: 以下は ADR-0005 で Superseded され、現在は適用されない。
>
> - Issue body 必須セクション (`## Goal` / `## Constraints` / `## Acceptance Criteria` / `MissingPromptSectionError`) の前提
> - テンプレート変数 `issue.goal` / `issue.constraints` / `issue.acceptance_criteria`
> - テンプレート変数 `attempt` (retry が消えるため)
>
> LiquidJS の採用 / Orchestrator フッタを末尾に無条件で連結する設計は維持。フッタの中身は agent 委譲指示 (Status 遷移 / PR 作成 / 必要に応じ Issue コメント / Conventional Commits) に変わる。詳細は [ADR-0005](./0005-thin-orchestrator-agent-delegation.md) を参照。

---

## コンテキスト

Issue #27 では Symphony の `WORKFLOW.md` に倣い、リポジトリ内の Markdown ファイルを prompt source として扱えるようにすることが要求されている。具体的には:

- ファイル名と配置場所は config で指定可能 (デフォルト `WORKFLOW.md` をリポジトリ直下)
- Issue 情報や attempt 番号を埋め込めるテンプレート (Liquid 互換 or Handlebars)
- ファイル変更検出による hot-reload (新規 dispatch から反映される)

これによりユーザはコードを書き換えずに prompt の指示文をリポジトリに固有な内容にカスタマイズできる。Issue #17 で実装済みの `buildPrompt` (Goal/Constraints/Acceptance Criteria を抽出して連結する pure 関数) はこのテンプレートよりも下位レイヤに位置し、テンプレート不在時のフォールバックおよびテンプレート内の安全制約フッタの基となる。

本 ADR では、テンプレートエンジンの選定 (Liquid 系か Handlebars 系か、どの実装を使うか)、テンプレートが落とせない安全制約 (push しない / PR 作らない / token 期待しない / Conventional Commits) の取り扱い、エラー時の挙動を確定する。

## 決定

### テンプレートエンジン: [LiquidJS](https://github.com/harttle/liquidjs) を採用する

- npm パッケージ: `liquidjs` (MIT License)
- ESM 対応, TypeScript 型同梱, 依存ゼロ
- 機能: 変数展開 / `if` / `for` / `case` / フィルタ / `include` / カスタムタグ
- パフォーマンス: parse 結果のキャッシュ可能。プロジェクト規模では問題にならない

#### Liquid を選ぶ理由 (Handlebars と比較して)

1. **logic-light で安全側**: Liquid はテンプレート内での任意ロジック実行が制限されており、リポジトリの他コラボレータが `WORKFLOW.md` を編集しても予期せぬコード実行を起こしにくい。Handlebars はヘルパ関数を介して任意 JS を持ち込みやすく、登録手順の自由度が高い分だけ運用上の規律が必要になる
2. **Symphony との親和性**: Symphony を含む先行事例の多くが Liquid を採用しており、ユーザがテンプレートを移植・参照する際の学習コストが低い
3. **依存最小**: `liquidjs` は dependencies が空。`handlebars` は `wordwrap` などの依存を抱える
4. **ESM ネイティブ**: 本プロジェクトは `"type": "module"` で動作。両者とも ESM 対応だが Liquid のほうが ESM 公開がきめ細かい

### 安全制約フッタは Orchestrator が無条件で連結する

テンプレート出力の **末尾** に、`buildPrompt` で従来 Constraints セクション末尾に追加していた以下 4 項目を、別セクション (`## Orchestrator からの追加制約`) として **必ず連結する**。

- `git push` を実行しないこと
- Pull Request を作成しないこと
- GitHub token を期待しないこと
- Conventional Commits 形式で commit すること

これは設計上の要請である。`WORKFLOW.md` を最小限に書き換えただけでこれらが落ちると Runner が PR を作ろうとして失敗する (token を持っていないため二重ガードはあるが、Runner が無駄な試行で時間を消費する)。テンプレート内に `{% include "orchestrator_constraints" %}` を必須にする選択肢もあるが、ユーザが意図せず削除しても安全なほうがよいため、Orchestrator 側のコードでフッタを強制する。

`buildPrompt` (テンプレート不在時のフォールバック) は従来どおり Constraints セクション末尾にこの文言を埋め込む形を残し、テンプレート経由のときは独立したセクションとして末尾に追加する。

### テンプレート変数 (一段目)

`liquidjs` の context として渡すオブジェクトは以下の形にする (snake_case で公開し、Liquid の慣例に合わせる)。

```liquid
{{ repository.owner }} / {{ repository.name }}
{{ base_branch }}
{{ issue.number }} {{ issue.title }} {{ issue.url }}
{{ issue.body }}
{{ issue.goal }}
{{ issue.constraints }}
{{ issue.acceptance_criteria }}
{{ workspace_path }}
{{ attempt }}
{{ run_id }}
```

`issue.goal` / `issue.constraints` / `issue.acceptance_criteria` は `parseIssueBody` (#17) の結果をそのまま流す。Issue body 必須セクションが欠損していた場合は従来どおり `MissingPromptSectionError` を throw する (テンプレート評価前)。

### `attempt` の値

- `philharmonic run` (1 ターン実行) では常に `1` を渡す
- `philharmonic serve` daemon は `RetryScheduler` の state を参照し、過去に Failed しているなら `attempts + 1` を渡す。retry-state にエントリがなければ `1`

これにより AC 「Issue 情報や attempt 番号を埋め込めるテンプレート」を満たしつつ、retry-state からの伝播経路を追加で実装する範囲は最小に抑える。

### hot-reload は「dispatch ごとに読み直し」+「serve のみ fs.watch ログ」

- 各 dispatch は `WORKFLOW.md` を都度読み直す (mtime キャッシュは小規模なので入れない)
- これだけで AC 「変更前後で異なる prompt を生成」を満たし、in-flight run が render 後の string を握っているため非影響も自動的に保証される
- `philharmonic serve` daemon でのみ任意に `fs.watch` を仕掛け、変更検出時に `workflow reloaded` を 1 行 INFO ログに出して運用上の可視性を上げる (watch が失敗しても dispatch には影響しない)

### エラー時の挙動

| ケース                              | 扱い                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `WORKFLOW.md` 不在                  | 既存 `buildPrompt` にフォールバック (後方互換)           |
| `WORKFLOW.md` 読み込み失敗 (権限等) | 構造化エラーで dispatch 失敗 → Issue にコメント / Failed |
| Liquid parse / render エラー        | 構造化エラーで dispatch 失敗 → Issue にコメント / Failed |
| Issue body 必須セクション欠損       | `MissingPromptSectionError` (既存挙動と同一)             |

## 結果

### 良い結果

- ユーザはコードを書き換えずに prompt をカスタマイズできる
- 安全制約は Orchestrator 側で強制されるため、テンプレートを最小化しても regression しない
- `philharmonic run` の 1 ターン実行は読み直しコストのみで済み、実装が単純
- `philharmonic serve` の daemon でも reload ログがあるため運用上の挙動が観測可能

### トレードオフ・悪い結果

- 依存パッケージが 1 つ増える (`liquidjs`)
- テンプレート構文を学ぶコストがユーザに発生する (ただし Liquid は仕様が小さい)
- テンプレートエンジンを差し替える際は再 ADR と修正が必要

## 検討した他の選択肢

### 選択肢 A: Handlebars

- 概要: `handlebars` パッケージ。`{{ }}` での変数展開、ヘルパ登録によるロジック拡張が可能
- 採用しなかった理由:
  - ヘルパでの任意 JS 登録が前提となっており、テンプレートに副作用を持ち込みやすい
  - 依存が増える (`wordwrap` 等)。`liquidjs` のほうが依存ゼロでシンプル

### 選択肢 B: Mustache

- 概要: logic-less な `{{ }}` ベースの最小テンプレートエンジン
- 採用しなかった理由:
  - `if` / `for` などの制御構造が無く、attempt によって prompt を出し分けるユースケースを書きにくい
  - フィルタが無いため文字列加工が不便

### 選択肢 C: EJS

- 概要: テンプレート内に任意 JavaScript を埋め込めるエンジン
- 採用しなかった理由:
  - リポジトリ内のファイルから JS が動くため、共同編集者の意図しない副作用が入りやすい (セキュリティ・運用両面で不利)

### 選択肢 D: 自作の `${var}` 置換のみ

- 概要: 外部依存ゼロで `${repository.owner}` 等を文字列置換するだけ
- 採用しなかった理由:
  - `if` / `for` / フィルタが無いため AC「attempt 番号を埋め込めるテンプレート」のユースケースを満たすのに即興拡張が必要
  - エスケープルールを自前で設計する必要があり、長期的にメンテコストが上回る

### 選択肢 E: テンプレート不採用 (既存 `buildPrompt` のみ)

- 概要: `WORKFLOW.md` を採用せず、`buildPrompt` のロジックで完結させる
- 採用しなかった理由:
  - Issue #27 の Goal そのものを満たさない
  - Symphony との親和性 (ユーザが Symphony 経験を移植できる) を諦めることになる
