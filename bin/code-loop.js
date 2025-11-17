#!/usr/bin/env node

import { run } from '../src/cli.js';

run().catch(error => {
  console.error('\nCLI failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
