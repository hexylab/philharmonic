# ADR-0007: Issue 依存関係を `Depends-On:` 行で表現する DAG-aware scheduler を導入する

- **ステータス**: Accepted
- **決定日**: 2026-05-10

---

## コンテキスト

Philharmonic の現行 scheduler (`philharmonic serve` の poll tick + `agent.max_concurrent_agents`) は、1 tick で Project board 上から最大 N 件の candidate を batch dispatch するだけで、Issue 同士の依存関係を解釈しない。結果として、後続の Issue が先行 Issue の完了を待たずに同時 dispatch される可能性がある。Issue 単位での順序制約を運用上どうしても表現したいケース (例: 「#100 の DB schema 変更が merge されてから #101 の API 変更を始めたい」) は、人間が `Todo` への昇格タイミングを手動で制御するしかない。

ADR-0005 で「薄い orchestrator + agent 委譲型」に切り替えた結果、orchestrator は Status 書き込みを行わず、構造化 Issue body の前提も撤廃された。そのうえで scheduler に依存関係解釈を導入するには、

- どこに依存関係を書くか (Issue body / Project field / 別ファイル)
- いつ解決とみなすか (`closed` / Project Status / merge 状態)
- orchestrator がどこまで踏み込むか (Status を書く / read-only / Snapshot に出すだけ)
- 既存の poll tick + 並列 dispatch にどう接続するか

を ADR として確定させる必要がある。

依存関係表現の選択肢として「Issue body に machine-readable な行を置く (Symphony / GitLab / GitHub の慣習) 」「Project field に追加する」「別の YAML/JSON ファイルで管理する」の 3 案があるが、Issue 起票フロー (`.github/ISSUE_TEMPLATE/task.md`) で人間が直接書ける一貫性、agent からも `gh` で書き換えやすいこと、Project の制約を増やさず Project field を使うユーザにも非侵襲なことから、本 ADR では Issue body 行表現を選ぶ。

本 ADR は、最初の MVP として「Issue body の `Depends-On:` 行で依存先を宣言し、orchestrator は依存解決状態だけを判定する」という最小スコープに留め、worker pool の永続化や cross-repository 依存などの拡張は将来の別 ADR に委ねる。

## 決定

### 1. dependency syntax は `Depends-On:` 一行に固定する

- Issue body 内の **行頭 (前後の空白を許す) で `Depends-On:` で始まる行** を依存宣言として認識する
- 値は **`#<number>` 形式の Issue 参照のカンマ区切り** とする (例: `Depends-On: #101, #102`)
- 同一 Issue 内に **複数の `Depends-On:` 行** を書いてもよい (parser はすべての行を union で集約する)
- `#` の前後の空白は許容する (`Depends-On:#101` / `Depends-On: # 101` どちらも受理)
- 大文字小文字は **ヘッダ部のみ case-insensitive** (`depends-on:` / `DEPENDS-ON:` も受理)
- code fence (`` ``` `` で囲まれたブロック) と blockquote (`> ` で始まる行) の中に書かれた `Depends-On:` は **無視する** (引用や例示で誤認識しないため)
- `Depends-On:` 以外の構文 (`## Dependencies` セクション / `## Blocked-by` 等) は MVP では採用しない (parser を 1 行 1 構文に絞る方針。詳細は「検討した他の選択肢」§A 参照)
- cross-repository 表記 (`owner/repo#123`) は MVP では受理せず、parser は **`#<number>` 以外を含む entry を invalid として扱う** (詳細: 本決定 §2 invalid 定義)

これは ADR-0005 で撤廃した「Issue body 必須セクション」の復活では **ない**。`Depends-On:` 行は **任意の machine-readable metadata** であり、未記載なら依存なし (= 即 ready) とみなす。`parseIssueBody` の `MissingPromptSectionError` のような throw は発生しない。

### 2. dependency state を `ready` / `blocked` / `invalid` / `cycle` の 4 値で定義する

> **用語の対応**: Issue #76 の Acceptance Criteria では「resolved / blocked / invalid / cycle」と表記されているが、本 ADR では同じ概念を **個別依存先 = `resolved`** (closed である) / **candidate Issue 全体 = `ready`** (すべての依存先が `resolved` で dispatch 可能) と区別する。`resolved` は per-dependency 単位の状態、`ready` は candidate Issue 単位の状態であり、両者は同義の上位下位関係にある (依存先が無い候補も `ready` に含む)。

各 candidate Issue について、依存解決ステップは以下の 4 値のいずれかに分類される。dispatch 可能なのは **`ready` のみ**。

| state     | 定義                                                                                                                                                              | dispatch | ログ / Snapshot                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `ready`   | (a) `Depends-On:` 行が無い、または (b) 列挙された依存先がすべて **closed** (state=`closed`、`closed-as-not-planned` を含む)                                        | する     | 通常通り `dispatch success` / `failed` 等      |
| `blocked` | 列挙された依存先に 1 件でも **open** な Issue がある (state=`open`)                                                                                                | しない   | info: `dependency blocked` (依存先 issue list) |
| `invalid` | 依存先が存在しない (404) / 権限不足で取得失敗 (403) / parse 不能な entry (`owner/repo#123` / 数値以外) を含む                                                     | しない   | warn: `dependency invalid` (理由 / 該当 entry) |
| `cycle`   | 依存グラフ全体に循環がある (自己依存 `#N` が `Depends-On: #N` も含む)、または依存先 issue が `Depends-On:` で本 issue を直接 / 間接に参照している (graph 内 SCC) | しない   | warn: `dependency cycle` (関与 issue list)     |

補足:

- **「closed-but-not-merged」は resolved 扱い** とする。GitHub の Issue close は PR merge 以外にも `closed-as-not-planned` (Issue 不採用) や手動クローズで起こりうるが、orchestrator はこれらを区別せず `state === 'closed'` ですべて resolved 扱いとする。理由:
  - 「PR が merge された Issue だけを resolved にする」と判定するには各依存 Issue の linked PR 状態を追加で fetch する必要があり rate limit が増える
  - 「不採用扱いで close された依存先 Issue が永遠に blocker になる」運用は人間直感に反する。close 判定の妥当性は人間 / agent の責任とする
- **self-dependency** (`#N` が `Depends-On: #N`) は **`cycle` のサブケース** として扱う (`invalid` ではない)。長さ 1 の循環として graph 内 SCC 検出に乗せる
- **Project board 上に存在しない Issue を依存先に書いた場合**: 取得自体は成功するため、その Issue の `state` (open / closed) で resolved 判定を行う (依存先が Project に積まれていなくても closed なら resolved 扱い)
- **`agent:skip` ラベルや assignee 不一致で dispatch 対象外の Issue を依存先に書いた場合**: orchestrator は依存先の `state` だけを見るため、Project 側の制約は依存解決には影響しない。close されない限り `blocked` のまま
- 既存の二重 dispatch ガード (worktree 既存 / in-flight tracker、ADR-0005 §5) は **dependency filter の上流** でそのまま動作する。worktree や in-flight 対象は dependency 評価より前に skip され、dependency 評価に進むのは「dispatch 可能な candidate」のみ

### 3. orchestrator は dependency state を理由に Project Status を書かない (read-only 維持)

ADR-0005 で「orchestrator は Status field を読むだけ、書かない」と確定している。本 ADR でも `blocked` / `invalid` / `cycle` を理由に Status を書き換えることは行わない。理由:

- ADR-0005 の方針 (state ownership を agent 側に集中) を壊さないため
- `Blocked` Status option を Project 側に追加するかどうかはユーザに依存する
- 「依存先が closed されたら自動的に `Todo` に戻す」のような書き戻しを始めると、agent 側で `Failed → Todo` を制御する設計と二重駆動になる

代わりに、dependency state は以下の経路で利用者に **observable** にする。

- **structured log**: candidate selection 時に `dependency blocked` / `dependency invalid` / `dependency cycle` を 1 行 (info / warn) ずつ出す
- **Snapshot HTTP API** (`/api/v1/state`): 依存解決状態の最新 snapshot を返す。ただし具体的なフィールド設計は本 ADR の範囲外とし、別 spec / 別 Issue で確定する (詳細は「§5 実装分割方針」)

`Failed → Todo` のような戻しは引き続き agent または人間の判断に委ねる。

### 4. scheduler 構造は「既存の tick-batched + DAG filter」を採用し、continuous worker pool 化は MVP out-of-scope とする

`philharmonic serve` の loop は ADR-0005 / serve-daemon.md 「並列 dispatch (#24)」で確定した tick-batched 構造を **そのまま維持** する。

```
each tick:
  1. Project items を fetch (1 GraphQL page = 100 件)
  2. 既存の candidate filter (status / assignee / label / worktree / in-flight) を適用
  3. ★ 本 ADR で追加: dependency filter を適用
       - parse Depends-On: lines
       - resolve 依存先 issue state (Project items 内なら追加 fetch なし、Project 外は本 ADR で追加 fetch を行う; §6)
       - cycle 検出 (graph 全体に対する SCC / DFS)
       - state == ready の candidate のみ残す
  4. 残った candidate を board 順 (上から) で先頭 N 件 (N = max_concurrent_agents) を dispatch pool に投入
  5. Promise.allSettled で N 件完走を待ち、sleep して次 tick へ
```

Issue 本文の「worker は空き次第、次の ready issue を再評価して dispatch する」記述は **continuous replenishment 型** (1 件完了するたびに即次 candidate を pick する worker pool) と読めるが、本 ADR では **採用しない**。理由:

- 既存の `dispatchPool` は **tick 単位での `Promise.allSettled` 待ち合わせ** を前提に設計されており、continuous replenishment 化は別 Issue で扱うべき大きさ (queue 永続化 / fairness / GitHub fetch のキャッシュ戦略)
- MVP の運用要件としては「N 件揃って完走 → 次 tick で再評価」で十分。`polling.interval_ms` (default 30s) のレイテンシ分だけ次の ready issue が遅れて流れるが、依存解決の観点では問題にならない
- `agent.max_concurrent_agents == 1` の互換挙動を壊さない (制約)
- 既存の二重 dispatch ガード (worktree / in-flight tracker) と整合する

continuous replenishment 化は Symphony 互換性 / 高並列ワークロードで意義が出る場合に、別 ADR (queue 永続化 / fairness 含む) で扱う。

`philharmonic run` (1 ターン実行) も同じ DAG filter を経由する。`run` は board 順で **先頭の ready candidate 1 件のみ** dispatch する (既存挙動の上位互換)。dependency が blocked / invalid / cycle で先頭が落ちた場合、その次の `ready` を選ぶ。

### 5. 実装分割方針

本 ADR の実装は以下の独立した PR / Issue に分割する。各 PR は単独で merge 可能で、後段が無くても regression を起こさない。

| 分割 | スコープ                                                                                                                                                  | 主な追加 / 変更                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **dependency parser**: Issue body から `Depends-On:` 行を抽出して `{ issueNumber, raw, valid }` の配列を返す純粋関数                                      | `src/dependency/parse.ts` 新設、unit test 充実 (code fence / blockquote / 複数行 / 大文字小文字 / cross-repo 形式 / 数値以外)                                                                                                                   |
| 2    | **dependency resolver**: parse 結果と Project items / 追加 fetch 結果から `ready` / `blocked` / `invalid` / `cycle` を判定する純粋関数 (副作用は fetch のみ) | `src/dependency/resolve.ts` 新設。GraphQL Project items 経由で取れる依存先はキャッシュ、外側のみ REST `getIssue` で fetch。SCC 検出 (Tarjan / Kosaraju) を独立関数として実装                                                                     |
| 3    | **candidate selection への統合**: 既存 `selectFirstByStatus` / `fetchAcceptableCandidates` の終端 filter として dependency resolver を挿す                | `src/orchestrator/select.ts` の DI 引数を 1 つ増やす。`philharmonic run` / `philharmonic serve` の両方が同じ resolver を経由する                                                                                                                |
| 4    | **structured log の追加**: `dependency blocked` / `dependency invalid` / `dependency cycle` を candidate selection 時に 1 行ずつ出す                      | observability.md に追記                                                                                                                                                                                                                         |
| 5    | **Snapshot API への dependency 状態追加**: `/api/v1/state` (および必要なら新 endpoint) に依存解決サマリを出す。**フィールド名 / 形状は別 spec で確定**    | snapshot-api.md に追記、tracker (RunTracker / 新設の DependencyTracker) を 1 つ増やす                                                                                                                                                           |
| 6    | **ガイド / spec 更新**: `docs/specs/orchestration-mvp.md` の Candidate Selection Rule に dependency filter を追記、`docs/guide/operations.md` に運用例を追記、`.github/ISSUE_TEMPLATE/task.md` に `Depends-On:` の書き方を追記 (テンプレートは optional 例示。必須項目にはしない、ADR-0005 と整合) | docs 群の更新のみ                                                                                                                                                                                                                               |

分割 1〜3 までで「依存先が open なら blocked される」基本機能が完成する。4〜5 は observability、6 は documentation。各 PR は独立に merge できる。

### 6. GitHub API rate limit 戦略

依存先 Issue の state 取得は以下の優先順位で行う。

1. **Project items に含まれる依存先**: `philharmonic serve` の poll tick で既に fetch している ProjectV2 items (1 page = 100 件) の中から `content.number` でルックアップ。**追加 API call なし**
2. **Project items に含まれない依存先**: REST `issues.get(owner, repo, number)` を 1 件ずつ呼ぶ。1 tick 内で同じ依存先を複数 candidate が参照する場合は **tick scoped cache** で 1 回に集約する
3. **同一 Project に多数の Issue が積まれている場合のページネーション**: GraphQL の単一ページ (100 件) を超えるケースは MVP の Candidate Selection Rule (orchestration-mvp.md) と同様に out-of-scope。未取得 page にある依存先は §1 にヒットしないため §2 経由で個別 fetch される

cross-repository (`owner/repo#123` 形式) は本 ADR では parser が `invalid` として弾くため、追加 fetch は発生しない。

### 7. Snapshot HTTP API への載せ方は方針のみ決定し、形状は別 spec で確定

ADR-0004 / snapshot-api.md は `/api/v1/state` のレスポンス形状を固定で定義しており、`running` / `totals` のみを返す。本 ADR では以下の方針だけを決定する:

- 依存解決状態 (ready / blocked / invalid / cycle) は **Snapshot HTTP API 経由で外部から observable** にする
- 既存 `/api/v1/state` への field 追加 / 新 endpoint (`/api/v1/dependencies` 等) のどちらを採るかは **本 ADR では決定しない**。snapshot-api.md の改訂と TUI dashboard (ADR-0006) との整合を取って、別 spec / 別 Issue で確定する
- いずれの形を採っても、dashboard は ADR-0006 の方針 (Snapshot API 消費) に従って必要に応じて表示を追加する。本 ADR は dashboard 側の UI には踏み込まない

これは ADR の粒度を「scheduler の方針」に絞り、API スキーマ改訂を別 PR で安全に進めるためのスコープ分割。

## 結果

### 良い結果

- 「先行 Issue の完了を待ってから後続を dispatch する」運用が `Depends-On:` 行 1 行で表現できる。Issue 起票時に依存関係を書き残せるため、人手で `Todo` 昇格を制御する運用負荷が減る
- ADR-0005 の「薄い orchestrator + agent 委譲」方針を破壊しない。orchestrator が触るのは「依存解決判定 → candidate filter」のみで、Status 書き込みには踏み込まない
- `parseIssueBody` のような必須セクション制約を復活させない (`Depends-On:` 行は任意 metadata)
- `agent.max_concurrent_agents: 1` の挙動は完全に維持される (filter が pass through するだけ)
- Issue の依存グラフが Snapshot HTTP API に出るため、TUI dashboard / 外部監視で「なぜこの Issue が dispatch されないか」を機械可読に追跡できる
- `philharmonic run` も同じ DAG filter を通るため、CLI 単発実行でも依存関係が無視されない

### トレードオフ・悪い結果

- orchestrator が再び Issue body を読むことになる (ADR-0005 で本文 parse を撤廃した方向と部分的に逆行する)。ただし `Depends-On:` 行は parse 失敗時に throw せず `invalid` として記録するだけなので、ADR-0005 の「本文をそのまま agent に渡す」設計とは共存する
- closed-but-not-merged (人間が `closed-as-not-planned` で閉じた依存先) も resolved 扱いになるため、運用上「close 判定の妥当性」を agent / 人間が担保する責任が増える
- cross-repository 依存が当面サポートされないため、複数リポジトリにまたがる large project では本機能だけでは依存表現が不足する (将来の別 ADR で扱う)
- continuous replenishment を採らないため、`max_concurrent_agents > 1` のときに「N-1 件が完走しているのに残り 1 件の長期 run を待たされる」レイテンシが残る (`polling.interval_ms` 1 周期分。default 30s)
- Snapshot API のフィールド形状を別 spec に分離したため、本 ADR merge 後 / 形状確定までの期間は dashboard 側の表示が暫定状態になる

### 影響を受けるコンポーネントや今後の作業

- code (新規):
  - `src/dependency/parse.ts` — `Depends-On:` 行 parser
  - `src/dependency/resolve.ts` — ready / blocked / invalid / cycle resolver
  - `src/dependency/cycle.ts` — graph SCC 検出
- code (改修):
  - `src/orchestrator/select.ts` — candidate selection に DAG filter を挿入
  - `src/orchestrator/run.ts` / `serve.ts` — dependency filter を DI で渡す
  - `src/server/snapshot.ts` (別 spec 確定後) — Snapshot に dependency state 追加
- spec:
  - `docs/specs/orchestration-mvp.md` — Candidate Selection Rule に dependency filter を追記
  - `docs/specs/serve-daemon.md` — structured log に `dependency blocked` / `invalid` / `cycle` を追加
  - `docs/specs/snapshot-api.md` — Snapshot 拡張は別 Issue / 別 spec で確定
  - `docs/specs/dependency-resolver.md` (新規) — 本 ADR の実装詳細を別 spec に切り出す候補
- ガイド:
  - `docs/guide/operations.md` — 依存関係を使った運用例
  - `.github/ISSUE_TEMPLATE/task.md` — `Depends-On:` 行の例示 (任意項目として)
- 後続 Issue:
  - 分割 1: dependency parser
  - 分割 2: dependency resolver
  - 分割 3: candidate selection 統合
  - 分割 4: structured log
  - 分割 5: Snapshot API 拡張 (フィールド設計の別 spec を含む)
  - 分割 6: ガイド / spec 更新
  - 将来拡張: cross-repository dependency / continuous worker pool / `Done` Status を解決条件に使うオプション

## 検討した他の選択肢

### 選択肢 A: `Depends-On:` 行に加えて `## Dependencies` セクションも許す

- 概要: GitHub Issue の慣習的セクション (`## Dependencies` 配下に箇条書きで `- #101` を並べる) も parser が拾うようにする
- 採用しなかった理由:
  - parser を 1 構文に絞ると実装と test が単純化する。section ベースは見出しレベルや前後空行等のエッジケースが多い
  - `Depends-On:` 行は GitHub の `Closes:` / `Fixes:` / `Refs:` 慣習と一貫性があり、人間にも agent にも書きやすい
  - 将来 `## Dependencies` 構文を追加することは parser 拡張で容易。逆方向 (両方サポートしてから片方を消す) は破壊的変更になる
  - ADR-0005 で構造化セクション必須制約を撤廃した方針と整合する (構造化セクションの再導入を避ける)

### 選択肢 B: 依存解決条件に Project Status `Done` も許す

- 概要: `state === 'closed'` だけでなく Project Status が `Done` の Issue も resolved とみなす
- 採用しなかった理由:
  - Project Status `Done` への遷移は人手駆動 (orchestration-mvp.md の Status Transition 図)。「PR merge → Issue close」と「Project Status Done」の関係は運用上ばらつくため、`closed` の方が一意
  - cross-repository 依存に拡張する際、`Done` 判定は Project Status (project-scoped) を取得する必要があり、依存先 Project 数だけ GraphQL 呼び出しが増える
  - `closed-as-not-planned` を resolved 扱いにする本 ADR の方針 (§2) と整合する単純な判定軸は `state === 'closed'`
  - 将来この選択肢を採りたい場合は `dependency.resolution: closed | done | both` のような config 追加で拡張できるため、MVP では採らないことに後悔は少ない

### 選択肢 C: continuous worker pool 化 (1 件完走するたびに即次 candidate を pick)

- 概要: 既存 `dispatchPool` の `Promise.allSettled` 待ち合わせを撤去し、worker pool が空き slot を持つ限り次の ready candidate を fetch して投入し続ける
- 採用しなかった理由:
  - GitHub API rate limit の上限管理 / fetch キャッシュ無効化 / fairness (ready 件数 >> N のとき同じ Issue が常に先頭に居続ける問題) など、設計判断が一気に増える
  - `agent.max_concurrent_agents == 1` 互換挙動を壊さないことを担保するために、N=1 では tick-batched と区別がつかなくなる必要があり、両モード共存の実装複雑度が高い
  - MVP では `polling.interval_ms` 1 周期分のレイテンシが致命的でない (依存解決の観点で「次 tick で流れる」で十分)
  - continuous replenishment が必要になる規模 (`max_concurrent_agents >= 5` 程度) で初めて意義が出るため、本 ADR より前に Symphony 互換性 / 高並列ワークロードの ADR を別途切る方が筋が良い

### 選択肢 D: orchestrator が dependency state を理由に Status を `Blocked` に flip する

- 概要: Project に `Blocked` Status option を追加してもらい、orchestrator が `Todo` の依存 blocked Issue を `Blocked` に flip する。依存先 close 後に `Blocked → Todo` に戻すのも orchestrator が行う
- 採用しなかった理由:
  - ADR-0005 の核 (state ownership を agent 側に集中、orchestrator は Status field を読むだけ) を壊す
  - `Blocked` option の有無 / 命名は Project ごとに違うため、`status_transitions` のような config 追加 + 全 Project への要求が必要 (運用ハードルが上がる)
  - agent 側で `gh project item-edit` を使って `Blocked` flip する設計に倒すこともできるが、agent は dispatch 時にしか動かないため「依存先が後から close されたら自動的に `Blocked → Todo` に戻す」のような連続駆動を実装できない (= 結局 orchestrator が書くことになり矛盾する)
  - dependency state を Snapshot API + structured log で observable にすれば、運用上の「なぜ流れていないか」の説明可能性は十分に確保できる

### 選択肢 E: 別ファイル (例: `.philharmonic/dependencies.yaml`) で依存関係を集中管理する

- 概要: Issue body には書かず、リポジトリ内の YAML/JSON で `{ "76": ["24", "31"] }` のように集中管理する
- 採用しなかった理由:
  - 起票フローで人間が書く場所が Issue body と分離するため、Issue 単独で完結しない (PR / Issue を見るだけでは依存関係が分からない)
  - agent が依存関係を更新したい場合に repo の YAML 編集 → commit / push が必要となり、PR レビューサイクルとの相性が悪い
  - 集中管理ファイルの conflict 解決 (複数 PR が同時に依存関係を書き換える) が複雑化する
  - GitHub の慣習 (`Closes:` / `Fixes:`) と完全に分離されるため、外部ツール (GitHub Web UI / 他の orchestrator) との互換性が低い

### 選択肢 F: cross-repository 依存 (`owner/repo#123`) を MVP でサポートする

- 概要: parser が `owner/repo#123` も受理し、resolver が REST `issues.get` を異なる repo に対して呼ぶ
- 採用しなかった理由:
  - 認証 scope の検証が複雑 (現行の PAT が依存先 repo に read 権限を持つとは限らない)
  - rate limit 戦略が複数 repo にまたがるため tick scoped cache を重ねた設計が必要
  - 単一 repo を前提にしている `philharmonic.yaml` の `owner` / `project_number` 構造の延長で素直に表現できない
  - MVP ユースケース (個人開発者 / 小規模チームでの単一 repo orchestration、AGENTS.md §1 参照) では同一 repo 依存で十分
  - 将来別 ADR で「multi-repo orchestration」を扱う際にまとめて設計する方が筋が良い
