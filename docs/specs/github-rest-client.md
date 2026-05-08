# GitHub REST/GraphQL Write Client

## 概要

Orchestration loop が必要とする「Issue 本体取得 / Issue コメント / Pull Request 作成 / Project Item Status 更新」を一手に引き受ける書き込み系 GitHub クライアントを `src/github/` に提供する。Issue / PR / コメントは REST API (`@octokit/rest`)、Project v2 の Status 更新は GraphQL mutation (`@octokit/graphql`) と、API 種別が分かれるため両者を 1 モジュールに集約する。本 spec は実装に先行する設計仕様であり、ADR-0001 と orchestration-mvp.md「PR 作成方針」「エラーハンドリング」を前提とする。

## 関連 Issue

- #16 — GitHub REST API クライアント (Octokit) を導入し Issue / PR / コメント操作を実装する
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)
- 関連 spec: [orchestration-mvp.md](./orchestration-mvp.md), [github-projects-v2.md](./github-projects-v2.md)

## 用語と登場アクター

| 用語              | 意味                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Client** | `src/github/` が提供する 4 つの操作 (`getIssue` / `commentIssue` / `createPullRequest` / `updateProjectV2ItemStatus`) を集約したオブジェクト |
| **REST 系**       | `@octokit/rest` で叩く `issues.get` / `issues.createComment` / `pulls.create`                                                                |
| **GraphQL 系**    | `@octokit/graphql` で叩く `updateProjectV2ItemFieldValue` mutation                                                                           |
| **DI フック**     | テスト時に HTTP を経由させないための注入点。REST 用と GraphQL 用の 2 系統を持つ                                                              |

## 要件

- `src/github/index.ts` から次の 4 関数を export する。すべて `createGitHubClient(options)` から得たオブジェクトのメソッドとして提供する
  - `getIssue({ owner, repo, issueNumber })`
  - `commentIssue({ owner, repo, issueNumber, body })`
  - `createPullRequest({ owner, repo, base, head, title, body, draft? })`
  - `updateProjectV2ItemStatus({ projectId, itemId, fieldId, optionId })`
- token は `GITHUB_TOKEN` 環境変数から取得する。未設定 / 空文字の場合は `GitHubTokenNotSetError` を throw する。`process.exit(1)` はライブラリ層では行わず、CLI 側に委ねる
- token 取得は `getGitHubTokenFromEnv(env?: NodeJS.ProcessEnv): string` という小ヘルパとして export し、CLI / orchestration 層から再利用できるようにする
- API 呼び出しは DI 可能とする
  - REST: `restClient` を注入できる (`Pick<Octokit, 'issues' | 'pulls'>` 互換の最小インターフェース)
  - GraphQL: `graphqlRequest: <T>(query: string, variables: Record<string, unknown>) => Promise<T>` を注入できる
  - いずれも省略時は `token` から `@octokit/rest` / `@octokit/graphql` を組み立てる
- API 失敗時は `GitHubApiError` を throw する。元エラーが Octokit の `RequestError` であれば `status` / レスポンス本文 / メソッド / URL を保持する。それ以外の例外もラップする
- Projects v2 の Status 更新では `updateProjectV2ItemFieldValue` mutation を使い、引数として 4 つの ID (`projectId` / `itemId` / `fieldId` / `optionId`) をそのまま受け取る (ID 解決は orchestration 層の責務)
- DI を活用した単体テストで成功 / 失敗 / token 未設定 の各パスを検証する
- HTTP レイヤを実際に叩くテストは追加しない (e2e は本 Issue の対象外)

## 非機能要件

- **性能**: orchestration 1 ターンあたり高々数回の呼び出しを想定。レート制限対応は MVP out-of-scope
- **可用性**: 単発呼び出しを前提とする。retry / backoff は呼び出し側の責務 (本 Issue では実装しない)
- **セキュリティ**:
  - `GITHUB_TOKEN` を Runner プロセスへ漏らさない (Runner 側 `buildRunnerEnv` が削除済み)
  - エラー本文や `GitHubApiError.responseBody` をログ出力する際は呼び出し側が PII / token をマスクする責務を負う。本モジュールはマスクを行わず生のレスポンス本文を保持する
  - PAT は fine-grained PAT を推奨し、`Issues: RW`, `Pull requests: RW`, `Projects: RW` の最小権限で運用する (orchestration-mvp.md と整合)
- **アクセシビリティ**: 該当しない

## データモデル

### `Issue`

`getIssue` の戻り値。orchestration 層で prompt 構築に使う最小フィールドのみ抽出する。

```ts
type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  htmlUrl: string;
};
```

### `IssueComment`

`commentIssue` の戻り値。失敗ログのトレースに必要な分のみ。

```ts
type IssueComment = {
  id: number;
  htmlUrl: string;
};
```

### `PullRequest`

`createPullRequest` の戻り値。

```ts
type PullRequest = {
  number: number;
  htmlUrl: string;
  draft: boolean;
};
```

### `UpdateProjectV2ItemStatusResult`

`updateProjectV2ItemStatus` の戻り値。

```ts
type UpdateProjectV2ItemStatusResult = {
  itemId: string;
};
```

## API / インターフェース

### Public API (`src/github/index.ts`)

```ts
export const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';
export function getGitHubTokenFromEnv(env?: NodeJS.ProcessEnv): string;

export type CreateGitHubClientOptions = {
  token: string;
  restClient?: RestClient;
  graphqlRequest?: GraphqlRequest;
};

export type GitHubClient = {
  getIssue(input: GetIssueInput): Promise<Issue>;
  commentIssue(input: CommentIssueInput): Promise<IssueComment>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  updateProjectV2ItemStatus(
    input: UpdateProjectV2ItemStatusInput,
  ): Promise<UpdateProjectV2ItemStatusResult>;
};

export function createGitHubClient(options: CreateGitHubClientOptions): GitHubClient;

export class GitHubTokenNotSetError extends Error {}
export class GitHubApiError extends Error {
  readonly status: number | null;
  readonly responseBody: unknown;
  readonly method: string | null;
  readonly url: string | null;
}
```

### `getGitHubTokenFromEnv`

1. `env[GITHUB_TOKEN]` を読む (省略時 `process.env`)
2. `undefined` / 空文字 / トリム後空 のいずれかなら `GitHubTokenNotSetError` を throw
3. それ以外はそのまま返す

### `createGitHubClient`

- `restClient` 未指定時は `new Octokit({ auth: token }).rest` を組み立てて使う
- `graphqlRequest` 未指定時は `graphql.defaults({ headers: { authorization: 'token <token>' } })` を関数として用いる
- 4 メソッドは Octokit 呼び出しを `try/catch` し、例外を `GitHubApiError` に変換して再 throw する

### REST 呼び出しのマッピング

| メソッド            | Octokit endpoint       | 主要パラメータ                                            |
| ------------------- | ---------------------- | --------------------------------------------------------- |
| `getIssue`          | `issues.get`           | `owner`, `repo`, `issue_number`                           |
| `commentIssue`      | `issues.createComment` | `owner`, `repo`, `issue_number`, `body`                   |
| `createPullRequest` | `pulls.create`         | `owner`, `repo`, `head`, `base`, `title`, `body`, `draft` |

### GraphQL mutation (Status 更新)

```graphql
mutation UpdateProjectV2ItemStatus(
  $projectId: ID!
  $itemId: ID!
  $fieldId: ID!
  $optionId: String!
) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) {
    projectV2Item {
      id
    }
  }
}
```

`updateProjectV2ItemStatus` は上記 mutation の結果から `projectV2Item.id` を取り出し `{ itemId }` を返す。

### DI 用の RestClient 最小インターフェース

```ts
export type RestClient = {
  issues: {
    get(params: { owner: string; repo: string; issue_number: number }): Promise<{
      data: {
        number: number;
        title: string;
        body: string | null;
        state: 'open' | 'closed';
        html_url: string;
      };
    }>;
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number; html_url: string } }>;
  };
  pulls: {
    create(params: {
      owner: string;
      repo: string;
      head: string;
      base: string;
      title: string;
      body?: string;
      draft?: boolean;
    }): Promise<{ data: { number: number; html_url: string; draft?: boolean } }>;
  };
};
```

## エラーハンドリング

| エラー                     | 発生条件                                            | 扱い方針                                                                           |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GitHubTokenNotSetError`   | `GITHUB_TOKEN` 未設定 / 空文字                      | throw。CLI が message を stderr に出して exit 1                                    |
| `GitHubApiError` (REST)    | Octokit `RequestError` (HTTP 非 2xx)                | throw。`status` / `responseBody` / `method` / `url` を保持。呼び出し側でログに整形 |
| `GitHubApiError` (GraphQL) | `@octokit/graphql` が throw / `errors[]` を含む応答 | throw。GraphQL の場合 `status` は `null`、`responseBody` に `errors` 全文を保持    |
| その他 (ネットワーク等)    | `fetch` 失敗 / 予期せぬ例外                         | throw。`GitHubApiError` でラップし `cause` に元エラーを保持                        |

`GitHubApiError` の message 規約: `<method> <url> failed with <status>: <reason>` (REST) / `GraphQL mutation '<operation>' failed: <reason>` (GraphQL)。`reason` はレスポンス本文の `message` フィールド (REST) もしくは `errors[0].message` (GraphQL) を採用する。

## 外部依存

- **`@octokit/rest` 22.x** (新規) — Issue / PR / コメント操作。`Octokit` インスタンスを内部で組み立てる
- **`@octokit/graphql` 9.x** (既存) — Project v2 mutation 用
- **`@octokit/request-error`** — `@octokit/rest` の transitive dep。`instanceof RequestError` 判定に利用
- **`process.env.GITHUB_TOKEN`** — 認証 token

## オープンクエスチョン

- レート制限 / 二次レート制限への対応 (リトライ・バックオフ) — 後続 Issue で `@octokit/plugin-retry` 採用を検討
- GitHub Apps installation token への切り替え — ADR-0001 で MVP out-of-scope
- PR 作成時に `Issue` body から Acceptance Criteria を抽出するヘルパの所属 (本モジュール / orchestration 層) — orchestration 層で Issue body をパースする方針

## MVP でやらないこと

- 自動 retry / backoff
- GitHub Apps 認証 (PAT のみ)
- `getIssue` の labels / assignees / projects 等の追加フィールド (必要になった時点で拡張)
- Issue 本文のパース (Goal / Constraints / Acceptance Criteria 抽出)
- レート制限ヘッダの観測 (`X-RateLimit-*`)
