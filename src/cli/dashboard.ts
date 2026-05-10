import { Command, InvalidArgumentError } from 'commander';
import React from 'react';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  SERVER_PORT_MAX,
  SERVER_PORT_MIN,
  type Config,
  type LoadConfigOptions,
} from '../config/index.js';
import {
  createDashboardClient,
  describeFetchError,
  type DashboardClient,
  type CreateDashboardClientOptions,
} from '../dashboard/client.js';
import { formatSnapshotForOnce } from '../dashboard/format.js';

/**
 * `philharmonic dashboard` サブコマンド。
 *
 * spec: docs/specs/dashboard.md
 * ADR: docs/adr/0006-tui-dashboard.md
 */

export const MIN_DASHBOARD_INTERVAL_MS = 500;

export type RenderInkApp = (
  element: React.ReactElement,
) => Promise<{ waitUntilExit(): Promise<void> }>;

export type DashboardCommandDeps = {
  cwd?: () => string;
  loadConfig?: (configPath?: string, options?: LoadConfigOptions) => Promise<Config>;
  createClient?: (options: CreateDashboardClientOptions) => DashboardClient;
  renderInkApp?: RenderInkApp;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<DashboardCommandDeps> = {
  cwd: () => process.cwd(),
  loadConfig: (configPath, options) => loadConfig(configPath, options),
  createClient: (options) => createDashboardClient(options),
  renderInkApp: async (element) => {
    const { render } = await import('ink');
    return render(element);
  },
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code) as never,
};

type DashboardOptions = {
  config?: string;
  port?: number;
  interval?: number;
  once: boolean;
};

export function createDashboardCommand(deps: DashboardCommandDeps = {}): Command {
  const resolved: Required<DashboardCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('dashboard');
  cmd
    .description(
      '`philharmonic serve` の Snapshot HTTP API を購読する read-only TUI dashboard を起動する',
    )
    .option(
      '-c, --config <path>',
      '設定ファイルのパス (省略時は cwd の .philharmonic/philharmonic.yaml、不在なら legacy philharmonic.yaml に fallback)',
    )
    .option(
      '--port <port>',
      `接続先 port (${SERVER_PORT_MIN}-${SERVER_PORT_MAX})。省略時は config の server.port`,
      parsePort,
    )
    .option(
      '--interval <ms>',
      `自動 refresh 間隔 (>=${MIN_DASHBOARD_INTERVAL_MS}ms)。省略時は config の polling.interval_ms`,
      parseInterval,
    )
    .option('--once', '1 回だけ snapshot を取得して text を stdout に出して exit する', false)
    .action(async (options: DashboardOptions) => {
      await runDashboard(options, resolved);
    });
  return cmd;
}

async function runDashboard(
  options: DashboardOptions,
  deps: Required<DashboardCommandDeps>,
): Promise<void> {
  const cwd = deps.cwd();

  let config: Config;
  try {
    config = await deps.loadConfig(options.config, { cwd });
  } catch (error) {
    if (
      error instanceof ConfigFileNotFoundError ||
      error instanceof ConfigParseError ||
      error instanceof ConfigValidationError
    ) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  const port = options.port ?? config.server?.port ?? null;
  if (port === null) {
    deps.stderr.write(
      'dashboard 接続先 port が決まりません。philharmonic.yaml に server.port を追加するか、--port を指定してください\n',
    );
    deps.exit(1);
    return;
  }

  const intervalMs = options.interval ?? config.polling.intervalMs;
  if (intervalMs < MIN_DASHBOARD_INTERVAL_MS) {
    deps.stderr.write(
      `--interval は ${MIN_DASHBOARD_INTERVAL_MS} 以上で指定してください (config の polling.interval_ms を使う場合も同様)\n`,
    );
    deps.exit(1);
    return;
  }

  const client = deps.createClient({ port });

  if (options.once) {
    try {
      const snapshot = await client.fetchState();
      deps.stdout.write(formatSnapshotForOnce({ host: client.host, port: client.port, snapshot }));
    } catch (error) {
      deps.stderr.write(`dashboard: ${describeFetchError(error)}\n`);
      deps.exit(1);
    }
    return;
  }

  // TUI モード。Ink を遅延 import することで、`--once` のみのテスト経路から
  // ink/react が import されないようにしている。
  const { DashboardApp } = await import('../dashboard/runtime.js');
  const instance = await deps.renderInkApp(
    React.createElement(DashboardApp, { client, intervalMs }),
  );
  await instance.waitUntilExit();
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < SERVER_PORT_MIN || n > SERVER_PORT_MAX) {
    throw new InvalidArgumentError(
      `--port は ${SERVER_PORT_MIN}〜${SERVER_PORT_MAX} の整数で指定してください`,
    );
  }
  return n;
}

function parseInterval(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DASHBOARD_INTERVAL_MS) {
    throw new InvalidArgumentError(
      `--interval は ${MIN_DASHBOARD_INTERVAL_MS} 以上の整数 (ms) で指定してください`,
    );
  }
  return n;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
