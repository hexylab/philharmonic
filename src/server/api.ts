import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from '../logger/index.js';

/**
 * Snapshot HTTP API (Issue #30) のサーバ実装。
 *
 * spec: docs/specs/snapshot-api.md
 * ADR: docs/adr/0004-snapshot-http-api.md
 */

export const API_BIND_HOST = '127.0.0.1';
const API_PATH_PREFIX = '/api/v1';
const ISSUE_PATH_RE = /^\/api\/v1\/(\d+)$/;

export type SnapshotApiHandlers = {
  getState(): Promise<unknown>;
  getIssue(issueNumber: number): Promise<unknown>;
  refresh(): Promise<{ woken: boolean }>;
};

export type SnapshotApiServerOptions = {
  port: number;
  logger: Logger;
  handlers: SnapshotApiHandlers;
  clock?: () => number;
};

export type SnapshotApiServer = {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
};

export async function startSnapshotApiServer(
  options: SnapshotApiServerOptions,
): Promise<SnapshotApiServer> {
  const { logger, handlers } = options;
  const clock = options.clock ?? (() => Date.now());

  const server = createServer((req, res) => {
    void handleRequest({ req, res, handlers, logger, clock });
  });

  await listen(server, options.port);
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    server.close();
    throw new Error('snapshot api server: server.address() が null を返しました');
  }
  const actualPort = (address as AddressInfo).port;
  const url = `http://${API_BIND_HOST}:${actualPort}`;

  return {
    port: actualPort,
    host: API_BIND_HOST,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 標準 http.Server.close() は keep-alive 中の接続が閉じるまで待つので、
        // (Node 22 + undici fetch との組み合わせでテストが flaky になりやすい)
        // 先に idle 接続を切ってから close を呼ぶ。
        server.closeIdleConnections?.();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.removeListener('listening', onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: API_BIND_HOST });
  });
}

type HandleInput = {
  req: IncomingMessage;
  res: ServerResponse;
  handlers: SnapshotApiHandlers;
  logger: Logger;
  clock: () => number;
};

async function handleRequest(input: HandleInput): Promise<void> {
  const { req, res, handlers, logger, clock } = input;
  const startMs = clock();
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const path = stripQuery(rawUrl);
  const remote = req.socket.remoteAddress ?? null;

  let status = 500;
  try {
    const issueMatch = ISSUE_PATH_RE.exec(path);
    if (path === `${API_PATH_PREFIX}/state`) {
      if (method === 'GET') {
        const body = await handlers.getState();
        status = 200;
        writeJson(res, status, body);
      } else {
        status = 405;
        res.setHeader('Allow', 'GET');
        writeJson(res, status, { error: 'method_not_allowed' });
      }
    } else if (path === `${API_PATH_PREFIX}/refresh`) {
      if (method === 'POST') {
        const result = await handlers.refresh();
        status = 202;
        writeJson(res, status, result);
      } else {
        status = 405;
        res.setHeader('Allow', 'POST');
        writeJson(res, status, { error: 'method_not_allowed' });
      }
    } else if (issueMatch !== null) {
      if (method === 'GET') {
        const issueNumber = Number(issueMatch[1]);
        if (!Number.isInteger(issueNumber) || issueNumber < 1) {
          status = 400;
          writeJson(res, status, { error: 'invalid_issue_number' });
        } else {
          const body = await handlers.getIssue(issueNumber);
          if (body === null) {
            status = 404;
            writeJson(res, status, { error: 'not_found', issue_number: issueNumber });
          } else {
            status = 200;
            writeJson(res, status, body);
          }
        }
      } else {
        status = 405;
        res.setHeader('Allow', 'GET');
        writeJson(res, status, { error: 'method_not_allowed' });
      }
    } else {
      status = 404;
      writeJson(res, status, { error: 'not_found' });
    }
  } catch (error) {
    status = 500;
    writeJson(res, status, { error: 'internal_error' });
    logger.warn('api request error', {
      method,
      path,
      remote,
      error: describeError(error),
    });
  } finally {
    logger.info('api request', {
      method,
      path,
      status,
      durationMs: Math.max(0, clock() - startMs),
      remote,
    });
  }
}

function stripQuery(url: string): string {
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
