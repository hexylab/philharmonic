#!/usr/bin/env node
import { Command } from 'commander';

import { createLogger } from './logger/index.js';
import { createProgram } from './program.js';

const program: Command = createProgram();

program.parseAsync(process.argv).catch((error: unknown) => {
  const logger = createLogger();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('uncaught error', { message, stack });
  process.exit(1);
});
