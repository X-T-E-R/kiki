import { Console } from 'node:console';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContextKlient } from '@kiki/klient/procedures';

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
  const context = config.contextEnabled ? createContextKlient({
    endpoint: config.endpoint, token: config.delegationToken, fetch: options.fetch,
  }) : undefined;
  const contextCatalog = await context?.catalog(AbortSignal.timeout(15_000));
  await createKikiMcpServer(config, { ...options, contextCatalog, contextCall: context?.call }).connect(new StdioServerTransport());
}
