/**
 * dashboard 表示用の時刻フォーマット helper。
 *
 * Snapshot API は ISO 8601 UTC 文字列のまま返すため、表示層でのみ
 * 日本時刻 (Asia/Tokyo / JST) に変換する。TUI と `--once` で同じ
 * 表記を使えるよう、ここに集約する。
 *
 * spec: docs/specs/dashboard.md
 */

const JST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const INVALID_LABEL = '(invalid)';

/**
 * ISO 8601 文字列 / `Date` を `YYYY-MM-DD HH:mm:ss JST` 形式で返す。
 *
 * - `null` / `undefined` → `fallback` (既定 `(never)`)。Snapshot API の
 *   `polling.last_tick_at` などが null になり得るため
 * - parse 失敗 → `(invalid)`。古い serve や手動データ破損に備える
 */
export function formatTimestampJst(
  input: string | Date | null | undefined,
  fallback = '(never)',
): string {
  if (input === null || input === undefined) return fallback;
  const date = input instanceof Date ? input : new Date(input);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return INVALID_LABEL;
  const parts = JST_FORMATTER.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  // en-CA + hour12:false で hour は `00`..`23` の zero-pad で得られる
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} JST`;
}
