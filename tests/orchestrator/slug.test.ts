import { describe, expect, it } from 'vitest';

import { buildIssueSlug, FALLBACK_SLUG } from '../../src/orchestrator/slug.js';

describe('buildIssueSlug', () => {
  it('英数字の title を kebab-case にする', () => {
    expect(buildIssueSlug('Add user login API')).toBe('add-user-login-api');
  });

  it('日本語のみの title は FALLBACK_SLUG に落とす', () => {
    expect(buildIssueSlug('日本語のみ')).toBe(FALLBACK_SLUG);
  });

  it('英数字混在 title は ASCII 部分のみ kebab-case にする', () => {
    expect(buildIssueSlug('Hello 世界 World 42')).toBe('hello-world-42');
  });

  it('先頭 30 文字でカットされ末尾の - は trim される', () => {
    const long = 'abcdefghijabcdefghijabcdefghij-tail';
    const slug = buildIssueSlug(long);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('空文字は FALLBACK_SLUG', () => {
    expect(buildIssueSlug('')).toBe(FALLBACK_SLUG);
  });

  it('記号のみは FALLBACK_SLUG', () => {
    expect(buildIssueSlug('???!!!')).toBe(FALLBACK_SLUG);
  });
});
