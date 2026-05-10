# Dependency Resolver

## 概要

Project candidate を `Depends-On:` 行ベースの依存グラフに沿って評価し、`ready` / `blocked` / `invalid_dependency` / `cycle` のいずれかに分類する evaluator の仕様。本モジュールは ADR-0007 §5 split 2 に対応し、副作用は依存先 Issue state の fetch のみで、Project Status / worktree 等は触らない。

## 関連 Issue / ADR

- #78 — Project candidates を DAG として評価し ready / blocked issue に分類する (本仕様の実装)
- #76 — DAG-aware scheduler 設計の発端 (ADR-0007)
- #77 — Issue body から `Depends-On:` を抽出する parser ([dependency-parser.md](./dependency-parser.md))
- 設計前提: [ADR-0007 Issue 依存関係 DAG-aware scheduler](../adr/0007-dependency-dag-aware-scheduler.md)
- 後続: candidate selection への統合 (split 3) / structured log (split 4) / Snapshot HTTP API への dependency 状態追加 (split 5)

## 用語

| 用語           | 意味                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| **Candidate**  | dispatch 対象として残った Project item (status / assignee / `agent:skip` / worktree / in-flight 通過済み) |
| **Dependency** | candidate Issue body に書かれた `Depends-On:` の一 entry                                                  |
| **Resolved**   | 依存先 Issue が `state === 'closed'` (`closed-as-not-planned` を含む。ADR-0007 §2 補足参照)               |
| **Cycle**      | 依存グラフに循環があり、当該 candidate がその SCC に属する状態                                            |
| **Self-loop**  | Issue が自分自身を `Depends-On:` で指定する状態 (`cycle` のサブケース、ADR-0007 §2)                       |

## 入力契約

- `candidates` は **既に candidate selection (status / assignee / `agent:skip` / worktree / in-flight) を通過済み** の前提で渡される。本モジュールは DAG 層のみを担当する
- `candidates` の順序は board 順 (= 入力順) を維持し、戻り値の順序もそのまま保つ。`ready` 候補の優先順位は入力順に従う
- 各 candidate には対応する Issue body (`null` 可) が添えられる。candidate selection 段で既に `getIssue` で取得済みの body を再利用するため、本モジュールは candidate 自身の body / state については追加 fetch を行わない

## 分類定義

ADR-0007 §2 の 4 値を本モジュールが実装する。優先順位は **`cycle` > `invalid_dependency` > `blocked` > `ready`** で、複数該当する候補は上位 1 つだけが報告される (例: cycle 中の候補が invalid な entry も持つ場合、`cycle` のみ報告)。

| state                | 条件                                                                                                                    | 出力フィールド                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ready`              | `Depends-On:` 行が無い、または列挙された依存先がすべて closed                                                           | -                                                           |
| `blocked`            | 列挙された valid 依存先のうち 1 件以上が open                                                                           | `blockingIssueNumbers: number[]` (open な依存先 Issue 番号) |
| `invalid_dependency` | parse-invalid な entry を含む、または依存先 Issue が `not_found` (404) / `forbidden` (403) / `fetch_error` (network 等) | `invalidEntries: InvalidDependencyDetail[]`                 |
| `cycle`              | 依存グラフ全体に循環があり、candidate 自身がその SCC に属する (size > 1) または self-loop edge を持つ                   | `cycleIssueNumbers: number[]` (関与 Issue 番号、昇順)       |

> **ADR との用語差**: ADR-0007 §2 では state 名を `invalid` と表記しているが、本仕様の実装型 `DagCandidateState` は Issue #78 の type alias 定義 (`'invalid_dependency'`) を採用する。後続 split 4 で出す structured log は ADR §3 に従い `dependency invalid` を log key に使う想定なので、state 名と log key は別 namespace として扱う。

## API

```ts
export type DagCandidateState = 'ready' | 'blocked' | 'invalid_dependency' | 'cycle';

export type InvalidDependencyReason = 'parse_invalid' | 'not_found' | 'forbidden' | 'fetch_error';

export type InvalidDependencyDetail = {
  readonly raw: string;
  readonly issueNumber: number | null;
  readonly reason: InvalidDependencyReason;
  readonly message?: string; // fetch_error 時のみ
};

export type EvaluatedCandidate =
  | { state: 'ready'; candidate: Candidate }
  | { state: 'blocked'; candidate: Candidate; blockingIssueNumbers: readonly number[] }
  | {
      state: 'invalid_dependency';
      candidate: Candidate;
      invalidEntries: readonly InvalidDependencyDetail[];
    }
  | { state: 'cycle'; candidate: Candidate; cycleIssueNumbers: readonly number[] };

export type DependencyIssueLookupResult =
  | { kind: 'found'; state: 'open' | 'closed'; body: string | null }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

export type FetchDependencyIssue = (issueNumber: number) => Promise<DependencyIssueLookupResult>;

export type CandidateWithBody = {
  readonly candidate: Candidate;
  readonly body: string | null;
};

export type EvaluateDependencyDagInput = {
  readonly candidates: readonly CandidateWithBody[];
  readonly fetchIssue: FetchDependencyIssue;
};

export function evaluateDependencyDag(
  input: EvaluateDependencyDagInput,
): Promise<EvaluatedCandidate[]>;

export function pickReadyCandidates(evaluations: readonly EvaluatedCandidate[]): Candidate[];
```

`pickReadyCandidates` は `evaluateDependencyDag` の結果から `ready` 状態のものだけを入力順で抽出する thin helper。candidate selection への統合 (split 3) で使う。

## アルゴリズム

1. **初期化**: 各 candidate を resolution map に登録する (state は `Candidate.issueState` から、body は入力で与えられる)
2. **BFS 走査**: 各 candidate body を `parseDependsOn` し、valid な依存先 Issue 番号を queue に積む。queue から取り出すたびに `fetchIssue` を呼び (resolution map に既に存在すればスキップ)、得られた body をさらに `parseDependsOn` して transitively 走査する。これにより candidate から到達可能な依存グラフ全体を 1 evaluation で構築する
3. **edge 構築**: resolution map のすべてのノードについて、body を再 parse して valid な依存先 Issue 番号 → outgoing edges を作る (caching のため body が `null` のノードは出辺なし)。edge target が未登録なら追加して body 不明 (孤立) ノードとして扱う
4. **Tarjan SCC**: 全ノード集合と edges から強連結成分を計算する
5. **分類**: 入力 candidate の順序を維持しつつ、cycle → invalid_dependency → blocked → ready の優先順位で 1 つの state を選ぶ

`isInCycle` は SCC size > 1 OR `n -> n` の self-loop edge で判定する (Tarjan は単一ノード self-loop を size 1 SCC として返すため、self-loop は別途検出する)。

## エラーハンドリング

| 状況                                               | 扱い方針                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Depends-On:` 行が無い                             | `ready`                                                                          |
| 値部分が空 (`Depends-On: ,` 等)                    | `parseDependsOn` が entry を返さないため `ready` (parser 仕様に従う)             |
| parse-invalid な entry (`owner/repo#X` / 数値以外) | `invalid_dependency` (`reason: 'parse_invalid'`)                                 |
| 依存先 Issue が 404                                | `invalid_dependency` (`reason: 'not_found'`)                                     |
| 依存先 Issue が 403                                | `invalid_dependency` (`reason: 'forbidden'`)                                     |
| 依存先 Issue fetch が network 等で失敗             | `invalid_dependency` (`reason: 'fetch_error'`, `message` に caller の理由を含む) |
| 依存先 Issue が closed                             | resolved 扱い (`closed-as-not-planned` を区別しない、ADR-0007 §2)                |
| 依存先 Issue が open                               | `blocked` (`blockingIssueNumbers` に追加)                                        |
| self-dependency (`#self`)                          | `cycle` (cycleIssueNumbers = `[self]`、ADR-0007 §2)                              |
| 直接 / 間接 cycle                                  | `cycle` (cycleIssueNumbers = SCC メンバを昇順)                                   |

## 非機能要件

- **性能**: 1 evaluation 内で同じ依存先 Issue は最大 1 回しか fetch しない (resolution map による caching)。`Depends-On:` 行が無い候補ばかりなら fetch 回数 0
- **API rate limit**: ADR-0007 §6 の方針に従い、Project items に含まれる依存先は caller の `fetchIssue` 実装で REST 呼び出しを抑止する想定 (本モジュールは `fetchIssue` を 1 entry-point として持つだけで、Project items vs 外側の判別は caller に委ねる)
- **可用性**: 該当しない (内部 pure 関数 + 注入された fetch のみ)
- **セキュリティ**: 外部入力は Issue body と `fetchIssue` の戻り値のみ。token / 認証情報を扱わない
- **アクセシビリティ**: 該当しない

## 既知の制限

- transitive dependency 走査に深さ制限を設けない。Issue body が hostile に深い chain を持つと `fetchIssue` が長く動き続けるリスクがある (MVP では発生確率が低いため許容、将来 limit を追加してよい)
- cycle が複数 candidate を巻き込む場合、各 candidate は同じ SCC を `cycleIssueNumbers` として返す。caller 側で重複を集約する責務は持たない (structured log では各 candidate ごとに 1 行ずつ出る想定)
- cross-repository の依存先 (`owner/repo#123`) は parser が `valid: false` で返すため、本モジュールでは fetch せず `invalid_dependency` (`parse_invalid`) として扱う

## 後続スコープ

ADR-0007 §5 のスコープ分割に従い、本仕様の範囲外は別 spec / 別 Issue で確定する。

- split 3: candidate selection への統合 (`src/orchestrator/select.ts` の終端 filter として接続)
- split 4: structured log (`dependency blocked` / `dependency invalid` / `dependency cycle` の 1 行ログ)
- split 5: Snapshot HTTP API への dependency 状態追加 (`/api/v1/state` の field 追加 or 新 endpoint)
- split 6: ガイド / 仕様書の更新
