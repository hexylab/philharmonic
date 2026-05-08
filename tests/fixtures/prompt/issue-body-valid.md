## Goal

orchestration-mvp.md「Claude Code Runner Prompt Construction」セクションに従い、Issue 本文の `## Goal` / `## Constraints` / `## Acceptance Criteria` を抽出して prompt を組み立てる pure 関数を提供する。

## Constraints

- Issue body の Markdown ヘッダ (`## Goal` 等) でセクションを切り出す
- 必要セクション欠損時は分かりやすいエラーで exit 1 (上位で Failure に倒せる構造化エラーにする)

## Acceptance Criteria

- [ ] `src/prompt/` モジュールに `buildPrompt(input): string` を実装する
- [ ] 単体テストで Issue body fixture から prompt が想定どおり組み立てられることを検証する
