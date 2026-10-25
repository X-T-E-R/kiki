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
  try {
    await runKikiMcpStdio(config);
  } catch (error) {
    const code = process.exitCode;
    if (typeof code !== 'number' || code <= 0) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    process.exit(code);
  }
  process.exit(0);
}

void main();
