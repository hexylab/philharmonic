import { describe, expect, it } from 'vitest';

import { formatTimestampJst } from '../../src/dashboard/time.js';

describe('formatTimestampJst', () => {
  it('UTC ISO 文字列を JST (+9h) で zero-pad された日時に変換する', () => {
    expect(formatTimestampJst('2026-05-09T00:00:00.000Z')).toBe('2026-05-09 09:00:00 JST');
  });

  it('JST 日付境界 (UTC 14:59:59 → 翌日 23:59:59) を超えても正しく変換する', () => {
    expect(formatTimestampJst('2026-05-08T14:59:59.000Z')).toBe('2026-05-08 23:59:59 JST');
    expect(formatTimestampJst('2026-05-08T15:00:00.000Z')).toBe('2026-05-09 00:00:00 JST');
  });

  it('Date オブジェクトも受け付ける (fetchedAt 用)', () => {
    expect(formatTimestampJst(new Date('2026-05-09T12:34:56.000Z'))).toBe(
      '2026-05-09 21:34:56 JST',
    );
  });

  it('null / undefined は fallback を返す', () => {
    expect(formatTimestampJst(null)).toBe('(never)');
    expect(formatTimestampJst(undefined)).toBe('(never)');
    expect(formatTimestampJst(null, '-')).toBe('-');
  });

  it('parse できない文字列 / Invalid Date は (invalid)', () => {
    expect(formatTimestampJst('not-a-date')).toBe('(invalid)');
    expect(formatTimestampJst(new Date(Number.NaN))).toBe('(invalid)');
  });
});
