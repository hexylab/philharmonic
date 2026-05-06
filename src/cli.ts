#!/usr/bin/env node
import { Command } from 'commander';

import { createProgram } from './program.js';

const program: Command = createProgram();

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
