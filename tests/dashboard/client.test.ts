import { describe, expect, it, vi } from 'vitest';

import {
  DASHBOARD_HOST,
  DashboardConnectionError,
  DashboardHttpError,
  DashboardMalformedResponseError,
  createDashboardClient,
  describeFetchError,
} from '../../src/dashboard/client.js';

function makeFetchResponse(
  body: string,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createDashboardClient', () => {
  it('host / port / baseUrl が固定 host を返す', () => {
    const client = createDashboardClient({ port: 4000, fetchImpl: vi.fn() });
    expect(client.host).toBe(DASHBOARD_HOST);
    expect(client.port).toBe(4000);
    expect(client.baseUrl).toBe(`http://${DASHBOARD_HOST}:4000`);
  });

  it('fetchState は GET /api/v1/state を loopback host に投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(
        JSON.stringify({
          started_at: '2026-05-09T00:00:00.000Z',
          uptime_ms: 1000,
          polling: { interval_ms: 30_000, last_tick_at: null },
          running: [],
          totals: { runs_completed: 0, runs_succeeded: 0, runs_failed: 0, total_cost_usd: 0 },
        }),
      ),
    );
    const client = createDashboardClient({ port: 4000, fetchImpl });

    const snapshot = await client.fetchState();

    expect(fetchImpl).toHaveBeenCalledWith(
      `http://${DASHBOARD_HOST}:4000/api/v1/state`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(snapshot.started_at).toBe('2026-05-09T00:00:00.000Z');
  });

  it('postRefresh は POST /api/v1/refresh を投げる', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(JSON.stringify({ woken: true })));
    const client = createDashboardClient({ port: 4000, fetchImpl });

    const result = await client.postRefresh();

    expect(fetchImpl).toHaveBeenCalledWith(
      `http://${DASHBOARD_HOST}:4000/api/v1/refresh`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({ woken: true });
  });

  it('接続失敗 (ECONNREFUSED 相当) を DashboardConnectionError に変換する', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), {
      code: 'ECONNREFUSED',
    });
    const wrapper = Object.assign(new Error('fetch failed'), { cause });
    const fetchImpl = vi.fn(async () => {
      throw wrapper;
    });
    const client = createDashboardClient({ port: 4000, fetchImpl });

    await expect(client.fetchState()).rejects.toBeInstanceOf(DashboardConnectionError);
    try {
      await client.fetchState();
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardConnectionError);
      expect((error as DashboardConnectionError).message).toContain('connection refused');
    }
  });

  it('HTTP 5xx を DashboardHttpError に変換する', async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    const client = createDashboardClient({ port: 4000, fetchImpl });

    try {
      await client.fetchState();
      throw new Error('expected DashboardHttpError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardHttpError);
      expect((error as DashboardHttpError).status).toBe(500);
      expect((error as DashboardHttpError).path).toBe('/api/v1/state');
    }
  });

  it('JSON parse 失敗を DashboardMalformedResponseError に変換する', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse('not-json'));
    const client = createDashboardClient({ port: 4000, fetchImpl });

    try {
      await client.fetchState();
      throw new Error('expected DashboardMalformedResponseError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardMalformedResponseError);
      expect((error as DashboardMalformedResponseError).path).toBe('/api/v1/state');
    }
  });
});

describe('describeFetchError', () => {
  it('DashboardConnectionError は message をそのまま返す', () => {
    const err = new DashboardConnectionError('connection refused', new Error('boom'));
    expect(describeFetchError(err)).toBe('connection refused');
  });

  it('DashboardHttpError は status / status text / path を含む', () => {
    const err = new DashboardHttpError(404, 'Not Found', '/api/v1/state');
    expect(describeFetchError(err)).toContain('404');
    expect(describeFetchError(err)).toContain('Not Found');
    expect(describeFetchError(err)).toContain('/api/v1/state');
  });

  it('DashboardMalformedResponseError は cause がある場合は cause message を含める', () => {
    const err = new DashboardMalformedResponseError('/api/v1/state', new Error('Unexpected token'));
    expect(describeFetchError(err)).toContain('malformed JSON');
    expect(describeFetchError(err)).toContain('Unexpected token');
  });

  it('未知のエラーは Error.message / String() に fallback する', () => {
    expect(describeFetchError(new Error('weird'))).toBe('weird');
    expect(describeFetchError('plain string')).toBe('plain string');
  });
});
