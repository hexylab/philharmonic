import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logger/index.js';
import {
  startSnapshotApiServer,
  type SnapshotApiHandlers,
  type SnapshotApiServer,
} from '../../src/server/api.js';

function makeLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    level: 'debug',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

async function fetchJson(
  url: string,
  init?: { method?: string },
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? (JSON.parse(text) as unknown) : null,
    headers: res.headers,
  };
}

describe('startSnapshotApiServer', () => {
  let server: SnapshotApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  it('GET /api/v1/state は handlers.getState() を JSON で返す (200)', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(async () => ({ running: [], totals: { runs_completed: 0 } })),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/state`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ running: [], totals: { runs_completed: 0 } });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(handlers.getState).toHaveBeenCalledTimes(1);
  });

  it('GET /api/v1/<issue_number> は handlers.getIssue() を呼ぶ (200)', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(async (issueNumber: number) => ({ issue_number: issueNumber })),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/42`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issue_number: 42 });
    expect(handlers.getIssue).toHaveBeenCalledWith(42);
  });

  it('GET /api/v1/<issue_number> で handlers が null を返したら 404', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(async () => null),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/999`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', issue_number: 999 });
  });

  it('GET /api/v1/<非整数> は routing 不一致で 404 not_found', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/abc`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(handlers.getIssue).not.toHaveBeenCalled();
  });

  it('GET /api/v1/0 は 400 invalid_issue_number (issue number は 1 以上)', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/0`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_issue_number' });
    expect(handlers.getIssue).not.toHaveBeenCalled();
  });

  it('POST /api/v1/refresh は handlers.refresh() を呼んで 202 を返す', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(),
      refresh: vi.fn(async () => ({ woken: true })),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/refresh`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ woken: true });
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
  });

  it('GET /api/v1/refresh は 405 (Allow: POST)', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/refresh`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('POST /api/v1/state は 405 (Allow: GET)', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v1/state`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('未定義のパスは 404 not_found', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    const res = await fetchJson(`${server.url}/api/v2/state`);
    expect(res.status).toBe(404);
  });

  it('handler が throw した場合は 500 + warn ログ + api request ログを残す', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(async () => {
        throw new Error('boom');
      }),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    const warn = vi.fn();
    const info = vi.fn();
    const logger: Logger = {
      level: 'debug',
      debug: vi.fn(),
      info,
      warn,
      error: vi.fn(),
      child: () => logger,
    };
    server = await startSnapshotApiServer({ port: 0, logger, handlers });
    const res = await fetchJson(`${server.url}/api/v1/state`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(warn).toHaveBeenCalledWith(
      'api request error',
      expect.objectContaining({ method: 'GET', path: '/api/v1/state', error: 'boom' }),
    );
    expect(info).toHaveBeenCalledWith(
      'api request',
      expect.objectContaining({ method: 'GET', path: '/api/v1/state', status: 500 }),
    );
  });

  it('正常系も api request ログを 1 行残す (status / duration_ms 付き)', async () => {
    const info = vi.fn();
    const logger: Logger = {
      level: 'debug',
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(async () => ({ ok: true })),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger, handlers });
    await fetchJson(`${server.url}/api/v1/state`);
    expect(info).toHaveBeenCalledWith(
      'api request',
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/state',
        status: 200,
        durationMs: expect.any(Number) as unknown,
      }),
    );
  });

  it('bind は 127.0.0.1 固定', async () => {
    const handlers: SnapshotApiHandlers = {
      getState: vi.fn(async () => ({})),
      getIssue: vi.fn(),
      refresh: vi.fn(),
    };
    server = await startSnapshotApiServer({ port: 0, logger: makeLogger(), handlers });
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
