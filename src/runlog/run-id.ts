import { randomBytes } from 'node:crypto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GenerateRunIdOptions = {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
};

export function generateRunId(options: GenerateRunIdOptions = {}): string {
  const now = options.now ?? Date.now;
  const rng = options.randomBytes ?? defaultRandomBytes;

  const timestampMs = BigInt(Math.max(0, Math.floor(now())));
  const random = rng(10);
  if (random.length < 10) {
    throw new Error('randomBytes must return at least 10 bytes');
  }

  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp (milliseconds).
  bytes[0] = Number((timestampMs >> 40n) & 0xffn);
  bytes[1] = Number((timestampMs >> 32n) & 0xffn);
  bytes[2] = Number((timestampMs >> 24n) & 0xffn);
  bytes[3] = Number((timestampMs >> 16n) & 0xffn);
  bytes[4] = Number((timestampMs >> 8n) & 0xffn);
  bytes[5] = Number(timestampMs & 0xffn);
  // Random tail (74 bits effective: 12 + 62).
  for (let i = 0; i < 10; i++) bytes[6 + i] = random[i]!;
  // Set version (bits 48..51) to 0111 (UUIDv7).
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Set variant (bits 64..65) to 10 (RFC 4122).
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuid(bytes);
}

export function isValidRunId(value: string): boolean {
  return UUIDV7_REGEX.test(value);
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function defaultRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}
