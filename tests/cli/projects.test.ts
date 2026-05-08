import { describe, expect, it, vi } from 'vitest';

import { createProjectsCommand } from '../../src/cli/projects.js';
import type { Candidate, ProjectsClient } from '../../src/projects/index.js';

type Streams = {
  stdout: { write: ReturnType<typeof vi.fn> };
  stderr: { write: ReturnType<typeof vi.fn> };
};

function createStreams(): Streams {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

function makeClient(candidates: Candidate[]): ProjectsClient {
  return {
    fetchProjectCandidates: vi.fn(async () => candidates),
  };
}

const SAMPLE_CANDIDATES: Candidate[] = [
  {
    itemId: 'PVTI_a',
    issueNumber: 4,
    issueTitle: 'GitHub Projects v2 client の調査用 spike を実装する',
    issueUrl: 'https://example.com/issues/4',
    issueState: 'OPEN',
    repositoryNameWithOwner: 'hexylab/philharmonic',
    status: 'Todo',
  },
];

async function runCommand(
  args: string[],
  streams: Streams,
  deps: Parameters<typeof createProjectsCommand>[0],
) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const projects = createProjectsCommand({ ...deps, ...streams, exit: exit as never });
  // commander の parseAsync を試す。"projects" 自体は subgroup なのでコマンド名つきで実行
  try {
    await projects.parseAsync(['list', ...args], { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') {
      throw error;
    }
  }
  return { exit };
}

describe('projects list コマンド', () => {
  it('GITHUB_TOKEN 未設定時はエラーメッセージを stderr に出して exit 1 する', async () => {
    const streams = createStreams();
    const { exit } = await runCommand(['--owner', 'hexylab', '--project', '1'], streams, {
      getToken: () => undefined,
      createClient: () => makeClient(SAMPLE_CANDIDATES),
    });

    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('候補があれば table 形式で stdout に出力する', async () => {
    const streams = createStreams();
    await runCommand(['--owner', 'hexylab', '--project', '1'], streams, {
      getToken: () => 'ghp_test',
      createClient: () => makeClient(SAMPLE_CANDIDATES),
    });

    const written = streams.stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ITEM_ID');
    expect(written).toContain('PVTI_a');
    expect(written).toContain('#4');
    expect(written).toContain('Todo');
    expect(written).toContain('hexylab/philharmonic');
  });

  it('--json フラグ指定時は JSON で出力する', async () => {
    const streams = createStreams();
    await runCommand(['--owner', 'hexylab', '--project', '1', '--json'], streams, {
      getToken: () => 'ghp_test',
      createClient: () => makeClient(SAMPLE_CANDIDATES),
    });

    const written = streams.stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(() => JSON.parse(written)).not.toThrow();
    const parsed = JSON.parse(written) as Candidate[];
    expect(parsed[0]?.itemId).toBe('PVTI_a');
  });

  it('候補が 0 件のときは "no candidates" を出して exit しない', async () => {
    const streams = createStreams();
    await runCommand(['--owner', 'hexylab', '--project', '1'], streams, {
      getToken: () => 'ghp_test',
      createClient: () => makeClient([]),
    });

    const written = streams.stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('no candidates');
  });

  it('client が throw した場合は stderr に出して exit 1 する', async () => {
    const streams = createStreams();
    const { exit } = await runCommand(['--owner', 'unknown', '--project', '1'], streams, {
      getToken: () => 'ghp_test',
      createClient: () => ({
        fetchProjectCandidates: vi.fn(async () => {
          throw new Error("owner 'unknown' が見つかりません");
        }),
      }),
    });

    expect(streams.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("owner 'unknown' が見つかりません"),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
