import { Command } from 'commander';

import { createCleanCommand } from './cli/clean.js';
import { createProjectsCommand } from './cli/projects.js';
import { createRunCommand } from './cli/run.js';
import { createServeCommand } from './cli/serve.js';

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

  program.addCommand(createProjectsCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createServeCommand());
  program.addCommand(createCleanCommand());

  return program;
}
