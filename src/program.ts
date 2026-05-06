import { Command } from 'commander';

const PROGRAM_NAME = 'philharmonic';
const PROGRAM_DESCRIPTION =
  'Coding-agent orchestrator built around GitHub Projects v2 and Claude Code (headless mode).';
const PROGRAM_VERSION = '0.0.0';

export function createProgram(): Command {
  const program = new Command();

  program
    .name(PROGRAM_NAME)
    .description(PROGRAM_DESCRIPTION)
    .version(PROGRAM_VERSION, '-v, --version', 'バージョンを表示する');

  return program;
}
