import { describe, expect, it } from 'vitest';

import { generateRunId, isValidRunId, isValidUuid } from '../../src/runlog/index.js';

describe('generateRunId', () => {
  it('UUIDv7 形式の文字列を返す (version=7, variant=10)', () => {
    const id = generateRunId();
    expect(isValidRunId(id)).toBe(true);
    expect(isValidUuid(id)).toBe(true);
  });

  it('--session-id 用の汎用 UUID 形式バリデーションも通る', () => {
    const id = generateRunId();
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).toBe(true);
  });

  it('連続生成しても重複しない', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 256; i++) ids.add(generateRunId());
    expect(ids.size).toBe(256);
  });

  it('先頭 48bit が指定 timestamp ms (big-endian) と一致する', () => {
    const fixedNow = 0x0192a0c8d4e5; // 任意の 48bit 値
    const id = generateRunId({
      now: () => fixedNow,
      randomBytes: (size) => new Uint8Array(size).fill(0x00),
    });
    const hexPrefix = id.replace(/-/g, '').slice(0, 12);
    expect(hexPrefix).toBe(fixedNow.toString(16).padStart(12, '0'));
  });

  it('生成順に文字列ソートで時刻順となる (UUIDv7 の時刻ソート性)', () => {
    let t = 1_700_000_000_000;
    const ids = Array.from({ length: 5 }, () => {
      t += 1;
      return generateRunId({ now: () => t });
    });
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe('isValidRunId / isValidUuid', () => {
  it('UUIDv4 文字列は run-id としては不正 (UUIDv7 ではない)', () => {
    const v4 = '11111111-1111-4111-8111-111111111111';
    expect(isValidRunId(v4)).toBe(false);
    expect(isValidUuid(v4)).toBe(true);
  });

  it('明らかに UUID ではない文字列は両方とも false', () => {
    expect(isValidRunId('not-a-uuid')).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
  });
});
