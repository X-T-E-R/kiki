import type { AcpOpenSessionOptions } from '@kiki/acp-client';

import type { McpConnectionView } from '#/mcpCore/connection-manager';
import { buildMcpRemoteHeaders } from '#/mcpCore/client-remote';

type AcpMcpServer = NonNullable<AcpOpenSessionOptions['mcpServers']>[number];

export function acpMcpServers(
  view: McpConnectionView,
  cwd: string,
  envLookup: (name: string) => string | undefined,
  allowedTransports?: readonly ('stdio' | 'http' | 'sse')[],
): AcpMcpServer[] {
  const servers: AcpMcpServer[] = [];
  for (const entry of view.list()) {
    if (entry.status === 'disabled' || entry.status === 'removed') continue;
    const config = view.configOf(entry.name);
    if (config === undefined || config.enabled === false) continue;
    if (allowedTransports !== undefined && !allowedTransports.includes(config.transport)) continue;
    if (config.enabledTools !== undefined || config.disabledTools !== undefined) continue;
    if (config.transport === 'stdio') {
      if (config.executor === 'kaos' || config.runtime_id !== undefined) continue;
      if (config.cwd !== undefined && config.cwd !== cwd) continue;
      servers.push({
        name: entry.name,
        command: config.command,
        args: [...config.args ?? []],
        env: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value })),
      });
      continue;
    }
    if (config.auth === 'oauth') continue;
    let headers: Record<string, string> | undefined;
    try {
      headers = buildMcpRemoteHeaders(config, envLookup);
    } catch {
      continue;
    }
    servers.push({
      type: config.transport,
      name: entry.name,
      url: config.url,
      headers: Object.entries(headers ?? {}).map(([name, value]) => ({ name, value })),
    });
  }
  return servers;
}
