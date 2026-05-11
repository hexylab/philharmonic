import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  classifyActivityFromEvent,
  StreamEventParser,
  type ResultEvent,
  type StreamEvent,
} from '../../src/runner/index.js';

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

describe('classifyActivityFromEvent (#98)', () => {
  function assistantEvent(content: unknown[]): StreamEvent {
    return {
      type: 'assistant',
      raw: { type: 'assistant', message: { content } },
    };
  }

  it('system / user / parse_error / unknown は null', () => {
    expect(
      classifyActivityFromEvent({
        type: 'system',
        subtype: 'init',
        sessionId: 'abc',
        raw: null,
      }),
    ).toBeNull();
    expect(classifyActivityFromEvent({ type: 'user', raw: null })).toBeNull();
    expect(
      classifyActivityFromEvent({
        type: 'parse_error',
        line: 'x',
        reason: 'oops',
      }),
    ).toBeNull();
    expect(classifyActivityFromEvent({ type: 'unknown', raw: 1 })).toBeNull();
  });

  it('text のみの assistant event は kind=assistant / toolName=null', () => {
    const event = assistantEvent([{ type: 'text', text: 'hello' }]);
    expect(classifyActivityFromEvent(event)).toEqual({ kind: 'assistant', toolName: null });
  });

  it('tool_use を含む assistant event は kind=tool_use / toolName を取り出す', () => {
    const event = assistantEvent([
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(classifyActivityFromEvent(event)).toEqual({ kind: 'tool_use', toolName: 'Bash' });
  });

  it('tool_use が複数あるときは最後の name を採用する', () => {
    const event = assistantEvent([
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'text', text: 'and...' },
      { type: 'tool_use', name: 'Edit' },
    ]);
    expect(classifyActivityFromEvent(event)).toEqual({ kind: 'tool_use', toolName: 'Edit' });
  });

  it('raw.message.content が壊れていても落ちず kind=assistant に fall back', () => {
    expect(classifyActivityFromEvent({ type: 'assistant', raw: null })).toEqual({
      kind: 'assistant',
      toolName: null,
    });
    expect(classifyActivityFromEvent({ type: 'assistant', raw: {} })).toEqual({
      kind: 'assistant',
      toolName: null,
    });
    expect(
      classifyActivityFromEvent({
        type: 'assistant',
        raw: { message: { content: 'not-an-array' } },
      }),
    ).toEqual({
      kind: 'assistant',
      toolName: null,
    });
  });

  it('result event は kind=result', () => {
    expect(
      classifyActivityFromEvent({
        type: 'result',
        subtype: 'success',
        raw: null,
      }),
    ).toEqual({ kind: 'result', toolName: null });
  });
});
