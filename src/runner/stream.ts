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

/**
 * Running agent の活動状態 (#98)。runner stdout の stream event をもとに分類する。
 *
 * - `starting`: runner 起動直後 / まだ assistant / result どちらも受け取っていない
 * - `assistant`: assistant event を受信 (text content のみ)
 * - `tool_use`: assistant event 内に `tool_use` content を検出
 * - `result`: result event を受信 (finishing 中)
 *
 * `waiting` (= no recent activity) は dashboard 側で `updatedAt` と現時刻の差分から
 * 派生表示する。tracker / snapshot にはこの 4 種類しか乗せない。
 *
 * raw payload / 長文出力 / prompt は本 type には載せない (#98 要件)。tool name のみを短く保持する。
 */
export type ActivityKind = 'starting' | 'assistant' | 'tool_use' | 'result';

export type ActivityEvent = {
  kind: ActivityKind;
  /** `kind === 'tool_use'` のときの tool 名。それ以外は null */
  toolName: string | null;
};

/**
 * `StreamEvent` から activity 分類を抽出する。activity に影響しない event (system /
 * user / parse_error / unknown) は null を返す。
 *
 * assistant event の `message.content[]` に `type: 'tool_use'` がある場合は `tool_use`
 * とし、最後の `tool_use` item の name を採用する (= 1 メッセージ内で複数 tool が呼ばれた
 * ときは最後に announce された tool を表示する)。tool_use と text が混在する場合も
 * tool_use を優先する (= "考えて → ツール呼び出し" のフローを表示するため)。
 */
export function classifyActivityFromEvent(event: StreamEvent): ActivityEvent | null {
  if (event.type === 'assistant') {
    const toolName = extractLastToolName(event.raw);
    if (toolName !== null) return { kind: 'tool_use', toolName };
    return { kind: 'assistant', toolName: null };
  }
  if (event.type === 'result') return { kind: 'result', toolName: null };
  return null;
}

function extractLastToolName(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = (raw as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  let lastName: string | null = null;
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (obj.type !== 'tool_use') continue;
    if (typeof obj.name === 'string' && obj.name.length > 0) {
      lastName = obj.name;
    }
  }
  return lastName;
}

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
