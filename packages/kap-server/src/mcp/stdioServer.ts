import { Console } from 'node:console';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  createKikiMcpServer,
  type KikiMcpConfig,
  type KikiMcpServerOptions,
} from './server';

export async function runKikiMcpStdio(
  config: KikiMcpConfig,
  options: KikiMcpServerOptions = {},
): Promise<void> {
  Object.defineProperty(globalThis, 'console', {
    configurable: true,
    value: new Console({ stdout: process.stderr, stderr: process.stderr }),
  });
  await createKikiMcpServer(config, options).connect(new StdioServerTransport());
}
