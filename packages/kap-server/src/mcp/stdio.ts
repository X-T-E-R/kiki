#!/usr/bin/env node

import { kikiMcpConfigFromEnv, type KikiMcpConfig } from './server';
import { runKikiMcpStdio } from './stdioServer';

async function main(): Promise<void> {
  let config: KikiMcpConfig;
  try {
    config = kikiMcpConfigFromEnv(process.env);
  } catch {
    process.stderr.write('Kiki MCP configuration is invalid.\n');
    process.exitCode = 1;
    return;
  }
  await runKikiMcpStdio(config);
}

await main();
