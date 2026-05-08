import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { StreamEventParser, type ResultEvent } from '../../src/runner/index.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/runner/${name}`, import.meta.url)),
    'utf8',
  );
}

function findResult(events: { type: string }[]): ResultEvent {
  const found = events.find((e) => e.type === 'result');
  if (!found) throw new Error('result event が見つかりませんでした');
  return found as ResultEvent;
}

describe('StreamEventParser', () => {
  it('正常 fixture から result event を抽出する', () => {
    const parser = new StreamEventParser();
    const events = parser.push(fixture('stream-success.jsonl'));
    parser.flush();

    const result = findResult(events);
    expect(result.subtype).toBe('success');
    expect(result.isError).toBe(false);
    expect(result.sessionId).toBe('74fb7504-6563-4222-bafb-cf9a161003bb');
    expect(result.totalCostUsd).toBeCloseTo(0.25337325, 6);
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 6 });
    expect(result.finalText).toBe('hello');
    expect(result.numTurns).toBe(1);
    expect(result.stopReason).toBe('end_turn');
    expect(result.durationApiMs).toBe(4268);
  });

  it('error fixture で is_error=true と subtype を抽出する', () => {
    const parser = new StreamEventParser();
    const events = parser.push(fixture('stream-error.jsonl'));
    parser.flush();

    const result = findResult(events);
    expect(result.isError).toBe(true);
    expect(result.subtype).toBe('error_max_turns');
    expect(result.stopReason).toBe('max_turns');
  });

  it('result event が無い fixture では result event が返らない', () => {
    const parser = new StreamEventParser();
    const events = parser.push(fixture('stream-no-result.jsonl'));
    parser.flush();

    expect(events.find((e) => e.type === 'result')).toBeUndefined();
    expect(events.some((e) => e.type === 'system')).toBe(true);
    expect(events.some((e) => e.type === 'assistant')).toBe(true);
  });

  it('空行と不正な JSON 行を含んでも処理が継続する', () => {
    const parser = new StreamEventParser();
    const input =
      '\n' +
      '{"type":"system","subtype":"init","session_id":"abc"}\n' +
      'not-a-json-line\n' +
      '\n' +
      '{"type":"result","subtype":"success","is_error":false,"session_id":"abc","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}\n';
    const events = parser.push(input);

    expect(events.find((e) => e.type === 'parse_error')).toBeDefined();
    const result = findResult(events);
    expect(result.finalText).toBe('ok');
  });

  it('chunk 境界を跨いだ JSON も正しく parse される', () => {
    const parser = new StreamEventParser();
    const full = fixture('stream-success.jsonl');
    const events: { type: string }[] = [];
    for (const ch of full) {
      events.push(...parser.push(ch));
    }
    events.push(...parser.flush());

    const result = findResult(events);
    expect(result.sessionId).toBe('74fb7504-6563-4222-bafb-cf9a161003bb');
    expect(result.finalText).toBe('hello');
  });

  it('flush は末尾改行なしの行も発火する', () => {
    const parser = new StreamEventParser();
    const events1 = parser.push('{"type":"system","subtype":"init"}');
    expect(events1).toEqual([]);
    const events2 = parser.flush();
    expect(events2).toHaveLength(1);
    expect(events2[0]?.type).toBe('system');
  });
});
