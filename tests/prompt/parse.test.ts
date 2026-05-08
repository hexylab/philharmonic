import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MissingPromptSectionError } from '../../src/prompt/errors.js';
import { parseIssueBody } from '../../src/prompt/parse.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/prompt/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('parseIssueBody', () => {
  it('Goal / Constraints / Acceptance Criteria を抽出して trim する', () => {
    const body = fixture('issue-body-valid.md');

    const parsed = parseIssueBody(body);

    expect(parsed.goal.startsWith('orchestration-mvp.md')).toBe(true);
    expect(parsed.constraints).toContain('Issue body の Markdown ヘッダ');
    expect(parsed.acceptanceCriteria).toContain('`buildPrompt(input): string`');

    expect(parsed.goal.endsWith('\n')).toBe(false);
    expect(parsed.goal.startsWith('\n')).toBe(false);
  });

  it('CRLF を含む body でも正しく抽出する', () => {
    const body = fixture('issue-body-valid.md').replace(/\n/g, '\r\n');

    const parsed = parseIssueBody(body);

    expect(parsed.goal).not.toContain('\r');
    expect(parsed.constraints).not.toContain('\r');
  });

  it('コードフェンス内の `## Goal` を header と誤認しない', () => {
    const body = fixture('issue-body-with-codefence.md');

    const parsed = parseIssueBody(body);

    expect(parsed.goal).toContain('```');
    expect(parsed.goal).toContain('これは中身であってヘッダではない');
    expect(parsed.constraints).toContain('フェンス内の');
  });

  it('Constraints が欠損していると MissingPromptSectionError を throw する', () => {
    const body = fixture('issue-body-missing-constraints.md');

    expect.assertions(3);
    try {
      parseIssueBody(body);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingPromptSectionError);
      const err = error as MissingPromptSectionError;
      expect(err.missingSections).toEqual(['constraints']);
      expect(err.code).toBe('missing_prompt_section');
    }
  });

  it('Goal の本文が空白のみのとき goal を欠損として扱う', () => {
    const body = fixture('issue-body-empty-goal.md');

    expect.assertions(2);
    try {
      parseIssueBody(body);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingPromptSectionError);
      expect((error as MissingPromptSectionError).missingSections).toEqual(['goal']);
    }
  });

  it('全セクションが空 body のとき 3 セクションすべてを missing として返す', () => {
    expect.assertions(2);
    try {
      parseIssueBody('');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingPromptSectionError);
      expect((error as MissingPromptSectionError).missingSections).toEqual([
        'goal',
        'constraints',
        'acceptance_criteria',
      ]);
    }
  });

  it('## goal (小文字) は ## Goal とは別の header として扱う = 欠損になる', () => {
    const body = [
      '## goal',
      'lower case',
      '',
      '## Constraints',
      '- c',
      '',
      '## Acceptance Criteria',
      '- a',
    ].join('\n');

    expect.assertions(2);
    try {
      parseIssueBody(body);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingPromptSectionError);
      expect((error as MissingPromptSectionError).missingSections).toEqual(['goal']);
    }
  });

  it('header 行の前後空白は許容する (## Goal\\t などをトリムする)', () => {
    const body = [
      '##  Goal\t',
      'goal body',
      '',
      '## Constraints',
      '- c',
      '',
      '## Acceptance Criteria',
      '- a',
    ].join('\n');

    const parsed = parseIssueBody(body);

    expect(parsed.goal).toBe('goal body');
  });
});
