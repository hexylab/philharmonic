import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { StateSnapshot } from '../server/index.js';

import { describeFetchError, type DashboardClient } from './client.js';
import { formatRunningRow, formatTotalCost, formatUptimeMs } from './format.js';

/**
 * `philharmonic dashboard` の TUI runtime (Ink/React)。
 *
 * spec: docs/specs/dashboard.md
 * ADR: docs/adr/0006-tui-dashboard.md
 */

export type DashboardAppProps = {
  client: DashboardClient;
  intervalMs: number;
  now?: () => Date;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; snapshot: StateSnapshot; fetchedAt: Date }
  | {
      kind: 'error';
      message: string;
      lastSnapshot: StateSnapshot | null;
      lastSnapshotFetchedAt: Date | null;
      fetchedAt: Date;
    };

const defaultClock = (): Date => new Date();

export function DashboardApp({ client, intervalMs, now }: DashboardAppProps): ReactElement {
  const { exit } = useApp();
  const clock = now ?? defaultClock;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const snapshot = await client.fetchState();
      setState({ kind: 'ok', snapshot, fetchedAt: clock() });
    } catch (error) {
      setState((prev) => ({
        kind: 'error',
        message: describeFetchError(error),
        lastSnapshot:
          prev.kind === 'ok' ? prev.snapshot : prev.kind === 'error' ? prev.lastSnapshot : null,
        lastSnapshotFetchedAt:
          prev.kind === 'ok'
            ? prev.fetchedAt
            : prev.kind === 'error'
              ? prev.lastSnapshotFetchedAt
              : null,
        fetchedAt: clock(),
      }));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [client, clock]);

  const wakeAndRefresh = useCallback(async (): Promise<void> => {
    setRefreshNotice(null);
    try {
      const result = await client.postRefresh();
      setRefreshNotice(
        result.woken ? 'woke daemon (refreshing)' : 'daemon already busy (refreshing)',
      );
    } catch (error) {
      setRefreshNotice(`wake failed: ${describeFetchError(error)}`);
    }
    await refresh();
  }, [client, refresh]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, refresh]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input === 'r') {
      void refresh();
      return;
    }
    if (input === 'R') {
      void wakeAndRefresh();
    }
  });

  const snapshot = pickSnapshot(state);
  const errorMessage = state.kind === 'error' ? state.message : null;

  return (
    <Box flexDirection="column">
      <Header client={client} intervalMs={intervalMs} refreshing={refreshing} />
      {snapshot === null ? (
        <Box paddingX={1}>
          <Text color="gray">loading...</Text>
        </Box>
      ) : (
        <>
          <DaemonSection snapshot={snapshot} />
          <RunningSection snapshot={snapshot} />
          <TotalsSection snapshot={snapshot} />
        </>
      )}
      <Footer state={state} errorMessage={errorMessage} refreshNotice={refreshNotice} />
    </Box>
  );
}

function pickSnapshot(state: LoadState): StateSnapshot | null {
  if (state.kind === 'ok') return state.snapshot;
  if (state.kind === 'error') return state.lastSnapshot;
  return null;
}

function Header({
  client,
  intervalMs,
  refreshing,
}: {
  client: DashboardClient;
  intervalMs: number;
  refreshing: boolean;
}): ReactElement {
  return (
    <Box paddingX={1} borderStyle="round" borderColor="cyan" flexDirection="column">
      <Box>
        <Text bold>Philharmonic Dashboard</Text>
        {refreshing ? <Text color="gray"> (refreshing...)</Text> : null}
      </Box>
      <Text color="gray">
        {client.baseUrl} refresh={intervalMs}ms
      </Text>
    </Box>
  );
}

function DaemonSection({ snapshot }: { snapshot: StateSnapshot }): ReactElement {
  return (
    <Box paddingX={1} borderStyle="round" borderColor="gray" flexDirection="column">
      <Text>
        started <Text color="cyan">{snapshot.started_at}</Text>
        {'   '}uptime <Text color="cyan">{formatUptimeMs(snapshot.uptime_ms)}</Text>
      </Text>
      <Text>
        polling <Text color="cyan">{snapshot.polling.interval_ms}ms</Text>
        {'   '}last tick <Text color="cyan">{snapshot.polling.last_tick_at ?? '(never)'}</Text>
      </Text>
    </Box>
  );
}

function RunningSection({ snapshot }: { snapshot: StateSnapshot }): ReactElement {
  const count = snapshot.running.length;
  return (
    <Box paddingX={1} borderStyle="round" borderColor="gray" flexDirection="column">
      <Text>
        Running <Text color={count > 0 ? 'green' : 'gray'}>({count})</Text>
      </Text>
      {count === 0 ? (
        <Text color="gray"> (none)</Text>
      ) : (
        snapshot.running.map((entry) => {
          const row = formatRunningRow(entry);
          return (
            <Text key={entry.run_id}>
              {'  '}
              <Text color="green">{row.issue}</Text>
              {'  '}
              <Text>{row.branch}</Text>
              {'  '}
              <Text color="gray">slot={row.slot}</Text>
              {'  '}
              <Text color="gray">started {row.startedAt}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

function TotalsSection({ snapshot }: { snapshot: StateSnapshot }): ReactElement {
  const t = snapshot.totals;
  return (
    <Box paddingX={1} borderStyle="round" borderColor="gray" flexDirection="column">
      <Text>Totals</Text>
      <Text>
        {'  '}completed=<Text color="cyan">{t.runs_completed}</Text>
        {'  '}
        succeeded=<Text color="green">{t.runs_succeeded}</Text>
        {'  '}
        failed=<Text color={t.runs_failed > 0 ? 'red' : 'gray'}>{t.runs_failed}</Text>
        {'  '}
        cost=<Text color="cyan">{formatTotalCost(t.total_cost_usd)}</Text>
      </Text>
    </Box>
  );
}

function Footer({
  state,
  errorMessage,
  refreshNotice,
}: {
  state: LoadState;
  errorMessage: string | null;
  refreshNotice: string | null;
}): ReactElement {
  return (
    <Box paddingX={1} flexDirection="column">
      <Text color="gray">q quit r refresh R wake-and-refresh</Text>
      {errorMessage !== null ? (
        <Text color="red">error: {errorMessage}</Text>
      ) : state.kind === 'ok' ? (
        <Text color="gray">last fetch ok @ {state.fetchedAt.toISOString()}</Text>
      ) : null}
      {refreshNotice !== null ? <Text color="yellow">{refreshNotice}</Text> : null}
    </Box>
  );
}
