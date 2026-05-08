export const SENSITIVE_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'] as const;

export const SENSITIVE_ENV_PREFIXES = ['OCTOKIT_'] as const;

export function buildRunnerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSensitive(key)) continue;
    out[key] = value;
  }
  return out;
}

function isSensitive(key: string): boolean {
  if ((SENSITIVE_ENV_KEYS as readonly string[]).includes(key)) return true;
  for (const prefix of SENSITIVE_ENV_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
