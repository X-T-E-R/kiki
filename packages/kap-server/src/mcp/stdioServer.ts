import { Console } from 'node:console';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContextKlient } from '@kiki/klient/procedures';

import {
  createKikiMcpServer,
  type KikiMcpConfig,
  type KikiMcpServerOptions,
} from './server';
import { retainUntilStdioClientEnds } from './stdioLifetime';

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
  const server = await createKikiMcpServer(config, {
    ...options, contextCatalog, contextCall: context?.call, contextList: context?.catalog,
  });
  await server.connect(new StdioServerTransport());
  await retainUntilStdioClientEnds({ close: () => server.close() });
}
