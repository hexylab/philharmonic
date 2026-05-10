import { describe, expect, it } from 'vitest';

import { isSelfDependency, parseDependsOn } from '../../src/dependency/parse.js';

describe('parseDependsOn', () => {
  it('`Depends-On: #1, #2` から `[1, 2]` を抽出する', () => {
    const result = parseDependsOn('Depends-On: #1, #2');

    expect(result).toEqual([
      { raw: '#1', issueNumber: 1, valid: true },
      { raw: '#2', issueNumber: 2, valid: true },
    ]);
  });

  it('dependency 行が無いときは空配列を返す', () => {
    const body = ['# Goal', '', 'Issue body without dependency line.'].join('\n');

    expect(parseDependsOn(body)).toEqual([]);
  });

  it('空文字列は空配列を返す', () => {
    expect(parseDependsOn('')).toEqual([]);
  });

  it('行頭のスペース / タブを許容する', () => {
    const body = ['   Depends-On: #10', '\tDepends-On: #20'].join('\n');

    expect(parseDependsOn(body)).toEqual([
      { raw: '#10', issueNumber: 10, valid: true },
      { raw: '#20', issueNumber: 20, valid: true },
    ]);
  });

  it('`Depends-On:#101` (`:` 直後にスペースなし) と `Depends-On: # 101` (`#` の後にスペース) を受理する', () => {
    const body = ['Depends-On:#101', 'Depends-On: # 202'].join('\n');

    expect(parseDependsOn(body)).toEqual([
      { raw: '#101', issueNumber: 101, valid: true },
      { raw: '# 202', issueNumber: 202, valid: true },
    ]);
  });

  it('ヘッダ部の case を区別しない (`depends-on:` / `DEPENDS-ON:`)', () => {
    const body = ['depends-on: #1', 'DEPENDS-ON: #2', 'Depends-On: #3'].join('\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1, 2, 3]);
  });

  it('複数の `Depends-On:` 行は union として集約する', () => {
    const body = ['Depends-On: #1, #2', '', 'Depends-On: #3'].join('\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1, 2, 3]);
  });

  it('重複した issue number は dedupe する (最初の出現を残す)', () => {
    const body = ['Depends-On: #1, #1, #2', 'Depends-On: #2, #3'].join('\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1, 2, 3]);
  });

  it('code fence (```) の中にある `Depends-On:` は無視する', () => {
    const body = [
      'Depends-On: #1',
      '',
      '```md',
      'Depends-On: #999',
      '```',
      '',
      'Depends-On: #2',
    ].join('\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1, 2]);
  });

  it('tilde fence (~~~) も code fence として扱う', () => {
    const body = ['~~~', 'Depends-On: #999', '~~~', 'Depends-On: #1'].join('\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1]);
  });

  it('blockquote (`>` 始まり) の `Depends-On:` は無視する', () => {
    const body = ['> Depends-On: #999', 'Depends-On: #1'].join('\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1]);
  });

  it('cross-repository 表記 (`owner/repo#123`) は invalid として返す', () => {
    const result = parseDependsOn('Depends-On: hexylab/philharmonic#42');

    expect(result).toEqual([{ raw: 'hexylab/philharmonic#42', issueNumber: null, valid: false }]);
  });

  it('数値以外の token (`#abc`) や `#` 抜きの値は invalid として返す', () => {
    const result = parseDependsOn('Depends-On: #abc, foo, #1');

    expect(result).toEqual([
      { raw: '#abc', issueNumber: null, valid: false },
      { raw: 'foo', issueNumber: null, valid: false },
      { raw: '#1', issueNumber: 1, valid: true },
    ]);
  });

  it('valid と invalid が同じ entry 内に混在しても両方返す', () => {
    const result = parseDependsOn('Depends-On: #1, owner/repo#2, #3');

    expect(result.map((e) => ({ valid: e.valid, n: e.issueNumber }))).toEqual([
      { valid: true, n: 1 },
      { valid: false, n: null },
      { valid: true, n: 3 },
    ]);
  });

  it('CRLF 改行でも正しく parse できる', () => {
    const body = ['Depends-On: #1', 'Depends-On: #2'].join('\r\n');

    expect(parseDependsOn(body).map((e) => e.issueNumber)).toEqual([1, 2]);
  });

  it('値が空の `Depends-On:` 行は entry を生成しない', () => {
    expect(parseDependsOn('Depends-On:')).toEqual([]);
    expect(parseDependsOn('Depends-On:    ')).toEqual([]);
    expect(parseDependsOn('Depends-On: , ,')).toEqual([]);
  });

  it('self-dependency (current issue 自身への参照) も entry に含めて返す', () => {
    const result = parseDependsOn('Depends-On: #77');

    expect(result).toEqual([{ raw: '#77', issueNumber: 77, valid: true }]);
  });
});

describe('isSelfDependency', () => {
  it('valid な entry の issueNumber が currentIssueNumber と一致するとき true', () => {
    expect(isSelfDependency({ raw: '#77', issueNumber: 77, valid: true }, 77)).toBe(true);
  });

  it('別の issue 番号なら false', () => {
    expect(isSelfDependency({ raw: '#42', issueNumber: 42, valid: true }, 77)).toBe(false);
  });

  it('invalid entry は常に false', () => {
    expect(isSelfDependency({ raw: 'owner/repo#77', issueNumber: null, valid: false }, 77)).toBe(
      false,
    );
  });
});
