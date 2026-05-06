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
});
