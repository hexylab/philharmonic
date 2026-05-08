const FALLBACK_SLUG = 'task';
const MAX_SLUG_LENGTH = 30;

export function buildIssueSlug(title: string, options: { maxLength?: number } = {}): string {
  const max = options.maxLength ?? MAX_SLUG_LENGTH;
  const ascii = stripDiacritics(title.normalize('NFKD'));
  const lowered = ascii.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = replaced.replace(/^-+|-+$/g, '');
  if (trimmed.length === 0) return FALLBACK_SLUG;
  const truncated = trimmed.slice(0, max).replace(/-+$/g, '');
  return truncated.length === 0 ? FALLBACK_SLUG : truncated;
}

function stripDiacritics(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x80) {
      out += ch;
    }
  }
  return out;
}

export { FALLBACK_SLUG };
