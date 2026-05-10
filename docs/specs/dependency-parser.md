# Dependency Parser

## 概要

Issue body 文字列から DAG-aware scheduler 用の `Depends-On:` 行を抽出する **pure 関数モジュール** の仕様。本モジュールは ADR-0007 §5 split 1 のスコープに対応し、I/O や GitHub fetch を行わず、依存先の state 判定 (ready / blocked / cycle) は行わない。

## 関連 Issue / ADR

- #76 — DAG-aware scheduler 設計の発端 (ADR-0007)
- #77 — Issue body から `Depends-On:` を抽出する parser (本仕様の実装)
- 設計前提: [ADR-0007 Issue 依存関係 DAG-aware scheduler](../adr/0007-dependency-dag-aware-scheduler.md)
- 後続: dependency resolver / cycle detection (ADR-0007 §5 split 2 以降。別 spec で確定する)

## 用語

| 用語           | 意味                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| **Issue body** | GitHub Issue 本文 (Markdown)。CRLF / LF の混在を許容                                 |
| **header**     | 行頭の `Depends-On:` 表記。case-insensitive                                          |
| **entry**      | カンマ区切りの 1 token (例: `#101`)。trim 後の文字列を `raw` として保持              |
| **valid**      | entry が `#<digits>` (`#` の前後の空白許容) として parse できたとき true             |
| **invalid**    | cross-repo 表記 (`owner/repo#N`) や数値以外 (`#abc` / `foo`) など parse 不能な entry |

`ready` / `blocked` / `cycle` 判定は本モジュールの責務外 (ADR-0007 §2 / §5 split 2)。

## Syntax

ADR-0007 §1 の確定 syntax を本モジュールが実装する。

- 行頭 (前後の空白を許す) で `Depends-On:` で始まる行を **依存宣言** とみなす
- 値は `#<number>` 形式の Issue 参照のカンマ区切り (例: `Depends-On: #101, #102`)
- `#` の前後の空白は許容 (`Depends-On:#101` / `Depends-On: # 101` どちらも受理)
- ヘッダ部のみ case-insensitive (`depends-on:` / `DEPENDS-ON:` も受理)
- 同一 body 内に複数の `Depends-On:` 行を書いてもよい (parser は **union で集約**)
- code fence (` ``` ` または `~~~` で囲まれたブロック) と blockquote (`>` 始まりの行) の中の `Depends-On:` は **無視**
- cross-repository 表記 (`owner/repo#123`) は `valid: false` として返す (受理はするが parse しない)
- 値部分が空の `Depends-On:` 行 (例: `Depends-On:` / `Depends-On: ,`) は entry を生成しない (空配列扱い)

## API

```ts
export type DependencyEntry = {
  readonly raw: string; // entry の原文 (前後 trim 済み)
  readonly issueNumber: number | null; // valid のとき Issue 番号、invalid のとき null
  readonly valid: boolean;
};

export function parseDependsOn(body: string): DependencyEntry[];
export function isSelfDependency(entry: DependencyEntry, currentIssueNumber: number): boolean;
```

- `parseDependsOn` は副作用を持たず、入力 `body` のみで結果が決まる
- 戻り値は **insertion order**。重複は最初の出現を残して dedupe
- dedupe key: valid entry は `issueNumber`、invalid entry は `raw` 文字列 (大文字小文字をそのまま比較)
- `isSelfDependency` は cycle 検出本体ではなく、単独 entry に対する self-reference 判定のみを提供する thin helper (cycle / SCC は ADR-0007 §5 split 2 のスコープ)

## エラーハンドリング

| 状況                                         | 扱い                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| body が空文字 / null-ish                     | `[]` を返す (例外を throw しない)                            |
| `Depends-On:` 行なし                         | `[]` を返す                                                  |
| code fence / blockquote 内の `Depends-On:`   | 該当行を無視                                                 |
| cross-repo 表記 / 非数値 token               | `valid: false` の entry として返す (caller が後段で判断する) |
| 値部分が空 (`Depends-On:` / `Depends-On: ,`) | entry を生成しない                                           |
| 自己参照 (`#<currentIssueNumber>`)           | entry に含めて返す (self-dependency 判定は caller 側の責務)  |

`parseIssueBody` (ADR-0005 で撤廃された構造化セクション parser) のような throw は発生しない。`Depends-On:` 行は **任意の machine-readable metadata** として扱う。

## 非機能要件

- **性能**: 文字列処理のみ。Issue body は GitHub API の制約上 64KiB を超えない想定で、1 行 1 回の正規表現マッチで O(n) で処理する
- **可用性**: 該当しない (内部 pure 関数モジュール)
- **セキュリティ**: 外部入力は Issue body のみ。token / 認証情報を扱わない
- **アクセシビリティ**: 該当しない

## 後続スコープ

ADR-0007 §5 のスコープ分割に従い、本仕様の範囲外は別 spec で確定する。

- split 2: dependency resolver (`ready` / `blocked` / `invalid` / `cycle` 判定 + Issue state fetch + SCC 検出)
- split 3: candidate selection への統合
- split 4: structured log
- split 5: Snapshot HTTP API への dependency 状態追加
- split 6: ガイド / spec の更新
