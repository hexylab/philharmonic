/**
 * Issue body から `Depends-On:` 行を抽出する pure parser (ADR-0007 §1, §5 split 1)。
 *
 * - 行頭 (前後の空白を許す) で `Depends-On:` で始まる行を依存宣言とみなす
 * - 値は `#<number>` のカンマ区切り。`#` の前後の空白も許容
 * - ヘッダ部 (`Depends-On:`) は case-insensitive
 * - code fence (``` / ~~~) と blockquote (`>` 始まり) 内の行は無視する
 * - cross-repository (`owner/repo#123`) や数値以外の token は `valid: false` で返す
 * - dispatch / state 判定 (ready / blocked / cycle) は本モジュールの責務外
 */

export type DependencyEntry = {
  /** entry トークンの原文 (前後 trim 済み)。invalid な場合の表示にも利用できる */
  readonly raw: string;
  /** parse 成功時の Issue 番号。`valid: false` のときは null */
  readonly issueNumber: number | null;
  /** `#<digits>` として解釈できたとき true */
  readonly valid: boolean;
};

const HEADER_PATTERN = /^\s*depends-on\s*:\s*(.*)$/i;
const VALID_ENTRY_PATTERN = /^#\s*(\d+)$/;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;
const BLOCKQUOTE_PATTERN = /^\s{0,3}>/;

export function parseDependsOn(body: string): DependencyEntry[] {
  if (!body) {
    return [];
  }

  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const collected: DependencyEntry[] = [];
  let fenceChar: '`' | '~' | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const char = fenceMatch[1]?.[0] === '~' ? '~' : '`';
      if (fenceChar === null) {
        fenceChar = char;
      } else if (fenceChar === char) {
        fenceChar = null;
      }
      continue;
    }
    if (fenceChar !== null) {
      continue;
    }
    if (BLOCKQUOTE_PATTERN.test(line)) {
      continue;
    }

    const headerMatch = line.match(HEADER_PATTERN);
    if (!headerMatch) {
      continue;
    }

    const tokens = (headerMatch[1] ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    for (const token of tokens) {
      const validMatch = token.match(VALID_ENTRY_PATTERN);
      if (validMatch && validMatch[1]) {
        collected.push({
          raw: token,
          issueNumber: Number(validMatch[1]),
          valid: true,
        });
      } else {
        collected.push({
          raw: token,
          issueNumber: null,
          valid: false,
        });
      }
    }
  }

  return dedupe(collected);
}

/**
 * `entry` が `currentIssueNumber` への自己依存かを判定する。
 *
 * cycle / SCC の判定本体は本モジュールの責務外 (ADR-0007 §5 split 2)。
 * 単独 issue 単位での self dependency 判定のみを提供する薄いヘルパ。
 */
export function isSelfDependency(entry: DependencyEntry, currentIssueNumber: number): boolean {
  return entry.valid && entry.issueNumber === currentIssueNumber;
}

function dedupe(entries: readonly DependencyEntry[]): DependencyEntry[] {
  const seen = new Set<string>();
  const result: DependencyEntry[] = [];
  for (const entry of entries) {
    const key = entry.valid ? `valid:${entry.issueNumber}` : `invalid:${entry.raw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}
