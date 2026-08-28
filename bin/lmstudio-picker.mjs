#!/usr/bin/env node

import { runCli } from "../src/cli.mjs";

runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pickermux: ${message}\n`);
  process.exitCode = 1;
});
