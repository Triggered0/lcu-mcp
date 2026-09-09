#!/usr/bin/env node
import { main } from '../src/index.js';

main().catch((err) => {
  process.stderr.write(`lcu-mcp failed to start: ${err.message}\n`);
  process.exitCode = 1;
});

