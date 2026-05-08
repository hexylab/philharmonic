export type ParseErrorEvent = {
  type: 'parse_error';
  line: string;
  reason: string;
};

export type SystemEvent = {
  type: 'system';
  subtype?: string;
  sessionId?: string;
  raw: unknown;
};

export type AssistantEvent = {
  type: 'assistant';
  raw: unknown;
};

export type UserEvent = {
  type: 'user';
  raw: unknown;
};

export type ResultEvent = {
  type: 'result';
  subtype?: string;
  isError?: boolean;
  sessionId?: string;
  stopReason?: string;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  finalText?: string;
  usage?: { inputTokens: number; outputTokens: number };
  raw: unknown;
};

export type UnknownEvent = {
  type: 'unknown';
  raw: unknown;
};

export type StreamEvent =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | UnknownEvent
  | ParseErrorEvent;

export class StreamEventParser {
  private buffer = '';

  push(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    this.buffer += chunk;

    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const line = rawLine.replace(/\r$/, '');
      if (line.length > 0) {
        events.push(parseLine(line));
      }
      newlineIdx = this.buffer.indexOf('\n');
    }
    return events;
  }

  flush(): StreamEvent[] {
    if (this.buffer.length === 0) return [];
    const remaining = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    if (remaining.length === 0) return [];
    return [parseLine(remaining)];
  }
}

function parseLine(line: string): StreamEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      type: 'parse_error',
      line,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { type: 'unknown', raw: parsed };
  }

  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : null;

  switch (type) {
    case 'system':
      return {
        type: 'system',
        subtype: stringOrUndefined(obj.subtype),
        sessionId: stringOrUndefined(obj.session_id),
        raw: parsed,
      };
    case 'assistant':
      return { type: 'assistant', raw: parsed };
    case 'user':
      return { type: 'user', raw: parsed };
    case 'result':
      return parseResult(obj, parsed);
    default:
      return { type: 'unknown', raw: parsed };
  }
}

function parseResult(obj: Record<string, unknown>, raw: unknown): ResultEvent {
  const usage = parseUsage(obj.usage);
  const result: ResultEvent = {
    type: 'result',
    subtype: stringOrUndefined(obj.subtype),
    sessionId: stringOrUndefined(obj.session_id),
    stopReason: stringOrUndefined(obj.stop_reason),
    raw,
  };
  if (typeof obj.is_error === 'boolean') result.isError = obj.is_error;
  if (typeof obj.total_cost_usd === 'number') result.totalCostUsd = obj.total_cost_usd;
  if (typeof obj.duration_ms === 'number') result.durationMs = obj.duration_ms;
  if (typeof obj.duration_api_ms === 'number') result.durationApiMs = obj.duration_api_ms;
  if (typeof obj.num_turns === 'number') result.numTurns = obj.num_turns;
  if (typeof obj.result === 'string') result.finalText = obj.result;
  if (usage !== undefined) result.usage = usage;
  return result;
}

function parseUsage(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const u = value as Record<string, unknown>;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') {
    return undefined;
  }
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
