import type { StateSnapshot } from '../server/index.js';

/**
 * `philharmonic dashboard` 用の Snapshot HTTP API client。
 *
 * spec: docs/specs/dashboard.md
 * ADR: docs/adr/0006-tui-dashboard.md
 */

export const DASHBOARD_HOST = '127.0.0.1';

export type DashboardClient = {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  fetchState(): Promise<StateSnapshot>;
  postRefresh(): Promise<{ woken: boolean }>;
};

export type CreateDashboardClientOptions = {
  port: number;
  fetchImpl?: typeof fetch;
};

export class DashboardConnectionError extends Error {
  override readonly name = 'DashboardConnectionError';
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}

export class DashboardHttpError extends Error {
  override readonly name = 'DashboardHttpError';
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${path}`);
  }
}

export class DashboardMalformedResponseError extends Error {
  override readonly name = 'DashboardMalformedResponseError';
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`malformed JSON from ${path}`);
  }
}

export function createDashboardClient(options: CreateDashboardClientOptions): DashboardClient {
  const port = options.port;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = `http://${DASHBOARD_HOST}:${port}`;

  return {
    host: DASHBOARD_HOST,
    port,
    baseUrl,
    fetchState: () => requestJson<StateSnapshot>(fetchImpl, baseUrl, '/api/v1/state', 'GET'),
    postRefresh: () =>
      requestJson<{ woken: boolean }>(fetchImpl, baseUrl, '/api/v1/refresh', 'POST'),
  };
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
): Promise<T> {
  const url = `${baseUrl}${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method });
  } catch (error) {
    throw new DashboardConnectionError(describeConnectionError(error), error);
  }

  if (!response.ok) {
    throw new DashboardHttpError(response.status, response.statusText, path);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new DashboardMalformedResponseError(path, error);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new DashboardMalformedResponseError(path, error);
  }
}

function describeConnectionError(error: unknown): string {
  if (!(error instanceof Error)) return `connection failed: ${String(error)}`;
  const code = extractErrorCode(error);
  if (code === 'ECONNREFUSED')
    return 'connection refused (daemon が起動していない可能性があります)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `host lookup failed (${code})`;
  if (code === 'ETIMEDOUT') return 'connection timed out';
  if (code !== null) return `${code}: ${error.message}`;
  return error.message;
}

function extractErrorCode(error: Error): string | null {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return null;
}

export function describeFetchError(error: unknown): string {
  if (error instanceof DashboardConnectionError) return error.message;
  if (error instanceof DashboardHttpError) return error.message;
  if (error instanceof DashboardMalformedResponseError) {
    return error.cause instanceof Error
      ? `${error.message}: ${error.cause.message}`
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
