import { InvalidBranchNameError } from './errors.js';

export const FALLBACK_BRANCH_SEGMENT = 'task';

const FORBIDDEN_PRINTABLE = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
const TRAILING_LOCK = /\.lock$/;

export function sanitizeBranchName(rawInput: string): string {
  if (typeof rawInput !== 'string') {
    throw new InvalidBranchNameError(String(rawInput), 'string ではない');
  }

  let value = stripDisallowedChars(rawInput);
  value = value.replace(/\.\.+/g, '-');
  value = value.replace(/@\{/g, '-');
  value = value.replace(/\/+/g, '/');
  value = value.replace(/\/\./g, '/-');
  value = value.replace(TRAILING_LOCK, '');
  value = trimLeadingDisallowed(value);
  value = trimTrailingDisallowed(value);

  if (value === '' || value === '@') {
    return FALLBACK_BRANCH_SEGMENT;
  }

  if (!isValidGitRefName(value)) {
    throw new InvalidBranchNameError(rawInput, 'git refname ルールに違反しています');
  }

  return value;
}

function stripDisallowedChars(value: string): string {
  let result = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 || code === 0x7f) continue;
    if (FORBIDDEN_PRINTABLE.has(ch)) continue;
    result += ch;
  }
  return result;
}

function trimLeadingDisallowed(value: string): string {
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '/' || ch === '.' || ch === '-') {
      i += 1;
      continue;
    }
    break;
  }
  return value.slice(i);
}

function trimTrailingDisallowed(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (ch === '/' || ch === '.') {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function isValidGitRefName(value: string): boolean {
  if (value === '' || value === '@') return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.startsWith('.') || value.endsWith('.')) return false;
  if (value.includes('//')) return false;
  if (value.includes('..')) return false;
  if (value.includes('@{')) return false;
  if (TRAILING_LOCK.test(value)) return false;

  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    if (code < 0x20 || code === 0x7f) return false;
    if (FORBIDDEN_PRINTABLE.has(ch)) return false;
  }

  return true;
}
