import { describe, expect, it } from 'vitest';

import { createProgram } from '../src/program.js';

describe('createProgram', () => {
  it('CLI 名と概要を設定している', () => {
    const program = createProgram();

    expect(program.name()).toBe('philharmonic');
    expect(program.description()).toContain('orchestrator');
  });

  it('--help 出力にプログラム名が含まれる', () => {
    const program = createProgram().exitOverride();

    const helpText = program.helpInformation();

    expect(helpText).toContain('philharmonic');
    expect(helpText).toContain('Usage:');
  });

  it('--version 出力で 0.0.0 を返す', () => {
    const program = createProgram();

    expect(program.version()).toBe('0.0.0');
  });

  it('--help 出力に主要サブコマンドが列挙される (dashboard 含む)', () => {
    const program = createProgram();

    const helpText = program.helpInformation();
    for (const name of [
      'init',
      'projects',
      'run',
      'serve',
      'retry',
      'clean',
      'clean-stale',
      'dashboard',
    ]) {
      expect(helpText).toContain(name);
    }
  });
});
