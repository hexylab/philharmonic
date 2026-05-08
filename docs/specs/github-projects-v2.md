# GitHub Projects v2 Client

## 概要

Philharmonic Orchestrator が候補 Project Item を発見するための、GitHub Projects v2 への読み取り専用 client を定義する。本 spec は Issue #4 (spike 実装) のスコープに対応し、以下を扱う:

- Project v2 から Item 一覧を取得する GraphQL クエリの形
- Draft Issue / Pull Request を除外し、GitHub Issue に紐づいた Item のみを抽出する規則
- 設定可能な Status field 名と、その値の取り出し方
- API token 取得方法と未設定時のエラー扱い

Status の更新 mutation・Claude Code の起動・PR 作成は本 spec の対象外であり、`docs/specs/orchestration-mvp.md` に従って後続 Issue で扱う。

## 関連 Issue

- #4 — GitHub Projects v2 client の調査用 spike を実装する
- 設計前提:
  - [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)
  - [Orchestration MVP](./orchestration-mvp.md)

## 用語

| 用語              | 意味                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Project Item**  | GitHub Projects v2 board 上の 1 行。`content` として Issue / Pull Request / Draft Issue を持ち得る                |
| **Candidate**     | Philharmonic が orchestration の対象として扱える Item。Issue に紐づき、`open` で、Status field 値が取得できるもの |
| **Status field**  | Project の単一選択 (`ProjectV2SingleSelectField`) フィールド。デフォルト名は `Status`。設定で別名を許容する       |
| **owner**         | Project を所有する User または Organization の login (例: `hexylab`)                                              |
| **projectNumber** | Project URL の末尾に出る整数 (例: `https://github.com/users/hexylab/projects/1` の `1`)                           |

## 要件

### 機能要件

- GitHub Personal Access Token を環境変数 `GITHUB_TOKEN` から読む。未設定時は分かりやすいエラーで終了する
- owner と projectNumber は CLI 引数で必須指定できる。設定ファイルからの読み込みは別 Issue (`docs/specs/config-schema.md` 予定) で対応する
- Status field 名は CLI フラグ `--status-field` で指定可能。デフォルト値は `Status`
- Project v2 から Items を取得し、次のいずれかに該当するものは候補から除外する:
  - `content.__typename !== 'Issue'` (Draft Issue / Pull Request など)
  - 紐づく Issue が `null`
- 抽出された候補ごとに以下の情報を表示する:
  - Project Item ID (例: `PVTI_lADOA...`)
  - Issue 番号 (`#42`)
  - Issue タイトル
  - リポジトリ (`owner/repo` 形式)
  - 現在の Status (Status field 名と一致する `ProjectV2ItemFieldSingleSelectValue.name`、無ければ `null`)
- Issue が `closed` であっても本 spec の段階では除外しない (orchestration-mvp.md の Candidate Selection で別途フィルタする)

### 非機能要件

- **性能**: 1 ページ (最大 100 件) のみ取得する。ページネーションは MVP out-of-scope。100 件に収まらない Project への対応は後続 Issue で扱う
- **可用性**: ネットワークエラー / GraphQL エラー / token エラーを区別せず stderr に詳細を出して exit 1 で終了する。Retry は行わない
- **セキュリティ**:
  - PAT はプロセスメモリのみで保持し、ログ・ファイルに書き出さない
  - GraphQL レスポンスをそのままコンソールに出すのは `--json` 指定時のみとし、デフォルトは整形済みテーブル
  - 本 spec の client は読み取りのみ (mutation を発行しない)
- **アクセシビリティ**: 該当しない (CLI のみ)

## データモデル

### GraphQL Query

`@octokit/graphql` から発行する 1 ファイル 1 クエリ。

```graphql
query ProjectItems($owner: String!, $number: Int!, $first: Int!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        title
        items(first: $first) {
          nodes {
            id
            content {
              __typename
              ... on Issue {
                number
                title
                url
                state
                repository {
                  nameWithOwner
                }
              }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    __typename
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

- `repositoryOwner` は User / Organization のいずれかを返し、双方が `ProjectV2Owner` interface を実装する。これにより owner の種別を呼び出し側で気にしなくて良い
- `fieldValues(first: 20)` は status 用の単一選択フィールドが先頭 20 件以内に存在する想定。Project に 20 を超えるフィールドがある場合は後続 Issue で対処
- Pull Request / Draft Issue は `content.__typename` が `Issue` 以外になるため、抽出側で除外する

### Candidate (出力モデル)

```ts
type Candidate = {
  itemId: string; // PVTI_...
  issueNumber: number; // 42
  issueTitle: string;
  issueUrl: string;
  issueState: 'OPEN' | 'CLOSED';
  repositoryNameWithOwner: string; // 'hexylab/philharmonic'
  status: string | null; // 'Todo' / 'In Progress' / null
};
```

`status` は次の手順で決定する:

1. `fieldValues.nodes` を走査し、`__typename === 'ProjectV2ItemFieldSingleSelectValue'` のもののみ採用
2. その中から `field.name === <status field 名>` (デフォルト `Status`) と一致するものを取得
3. 一致したノードの `name` を返す。一致が無ければ `null`

### スキーマ検証 (zod)

GraphQL レスポンスを zod schema で parse してから抽出関数に渡す。受け入れる形のみ定義し、未知の typename は `passthrough` ではなく明示的に許容する。

- `ProjectV2ItemContent` は `__typename` discriminator を取り、`Issue` 以外は `{ __typename: string }` のフォールバック shape として受け入れる
- `ProjectV2ItemFieldValue` も同様に `__typename` discriminator を取り、`ProjectV2ItemFieldSingleSelectValue` 以外はフォールバック shape として受け入れる
- 受け取った値が schema を満たさない場合は zod の `ZodError` を stderr に出して exit 1 する

## CLI

### サブコマンド

```
philharmonic projects list \
  --owner <owner> \
  --project <number> \
  [--status-field <name>] \
  [--first <count>] \
  [--json]
```

| フラグ           | 必須 | 既定値   | 説明                                           |
| ---------------- | ---- | -------- | ---------------------------------------------- |
| `--owner`        | ✓    | -        | Project owner の login                         |
| `--project`      | ✓    | -        | Project number (整数)                          |
| `--status-field` | -    | `Status` | Status を取り出す Project field の名前         |
| `--first`        | -    | `100`    | 取得件数 (1〜100)                              |
| `--json`         | -    | `false`  | 整形 JSON で出力する (人間用 table を出さない) |

### 既定の出力 (table)

固定幅 8 桁程度に揃えた space-separated 行を 1 候補 = 1 行で出力する。

```
ITEM_ID                                    ISSUE  REPOSITORY              STATUS       TITLE
PVTI_lADOA_examplexxxxxxxxxxxxxxxxxxxxxxx  #4     hexylab/philharmonic    Todo         GitHub Projects v2 client の調査用 spike を実装する
PVTI_lADOA_examplexxxxxxxxxxxxxxxxxxxxxxx  #5     hexylab/philharmonic    In Progress  ...
```

候補が 0 件の場合は `no candidates` を stdout に出して exit 0 で終了する。

### `--json` 出力

`Candidate[]` を `JSON.stringify(_, null, 2)` でそのまま出力する。

## エラーハンドリング

| エラー                       | 発生条件                                              | 扱い方針                                                               |
| ---------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `GITHUB_TOKEN` 未設定        | `process.env.GITHUB_TOKEN` が空 / 未定義              | stderr に「環境変数 GITHUB_TOKEN を設定してください」と出して exit 1   |
| `--owner` / `--project` 欠落 | commander が必須フラグ違反として検知                  | commander のデフォルト動作 (usage 表示 → exit 1)                       |
| `--first` 範囲外             | 1 未満 または 100 超                                  | stderr に「--first は 1〜100 の範囲で指定してください」と出して exit 1 |
| owner が見つからない         | `repositoryOwner` が `null`                           | stderr に「owner '<owner>' が見つかりません」と出して exit 1           |
| Project が見つからない       | `projectV2` が `null`                                 | stderr に「Project number '<number>' が見つかりません」と出して exit 1 |
| GraphQL エラー               | `@octokit/graphql` が `GraphqlResponseError` を throw | エラーメッセージを stderr にそのまま出して exit 1                      |
| schema 不一致                | レスポンスが zod schema を満たさない                  | `ZodError` の summary を stderr に出して exit 1                        |
| ネットワークエラー           | `fetch` 例外                                          | エラーメッセージを stderr に出して exit 1                              |

token を含み得るオブジェクト (`headers` 等) はエラー出力時に除外する。

## 外部依存

- `@octokit/graphql` (^9) — GraphQL リクエスト発行
- `zod` (^4) — レスポンスのスキーマ検証
- `commander` (既存) — CLI 引数

GitHub PAT は最小限のスコープで運用する想定:

- 対象 Project の `Projects: read`
- 対象リポジトリの `Issues: read`

PAT は環境変数 `GITHUB_TOKEN` から読む。`.env` の自動ロードは MVP out-of-scope。

## オープンクエスチョン

- Items が 100 件を超える Project への対応 (cursor ベースのページネーション)。orchestration-mvp.md と整合させて後続 Issue で扱う
- Draft Issue を将来 first-class に扱う場合の content schema 拡張
- Issue の `state` (open/closed) を Candidate Selection の段階でフィルタするかどうか (本 spec は表示のみ、orchestration-mvp.md は `open` のみを対象とする)
- 設定ファイル (`philharmonic.yaml`) からの owner / projectNumber 読み込み (`docs/specs/config-schema.md` で扱う)
- `fieldValues(first: 20)` の上限を超える Project への対応
