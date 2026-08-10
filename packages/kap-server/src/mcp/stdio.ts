#!/usr/bin/env node
/**
 * Kiki MCP stdio entrypoint — connects the narrow external-delegation server.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Console } from 'node:console';

import { createKikiMcpServer, kikiMcpConfigFromEnv } from './server';

Object.defineProperty(globalThis, 'console', {
  configurable: true,
  value: new Console({ stdout: process.stderr, stderr: process.stderr }),
});

async function main(): Promise<void> {
  let server;
  try {
    server = createKikiMcpServer(kikiMcpConfigFromEnv(process.env));
  } catch {
    process.stderr.write('Kiki MCP configuration is invalid.\n');
    process.exitCode = 1;
    return;
  }
  await server.connect(new StdioServerTransport());
}

await main();
