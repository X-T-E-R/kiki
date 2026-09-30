import { describe, expect, it } from 'vitest';

import { acpMcpServers } from '#/app/agentExecutor/acpMcpServers';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpConnectionView, McpServerStatus } from '#/mcpCore/connection-manager';

function view(servers: Record<string, { config: McpServerConfig; status?: McpServerStatus }>): McpConnectionView {
  return {
    list: () => Object.entries(servers).map(([name, value]) => ({
      name,
      status: value.status ?? 'connected',
      transport: value.config.transport,
      toolCount: 0,
    })),
    configOf: (name: string) => servers[name]?.config,
  } as unknown as McpConnectionView;
}

describe('ACP session MCP forwarding', () => {
  it('serializes enabled session servers with ACP transport shapes and bearer headers', () => {
    const servers = acpMcpServers(view({
      local: { config: { transport: 'stdio', command: 'node', args: ['mcp.js'], env: { TOKEN: 'secret' } } },
      remote: { config: { transport: 'http', url: 'https://mcp.example/rpc', bearerTokenEnvVar: 'MCP_KEY' } },
      sse: { config: { transport: 'sse', url: 'https://mcp.example/events', headers: { 'X-Id': '123' } } },
    }), '/work', (name) => name === 'MCP_KEY' ? 'abc' : undefined);
    expect(servers).toEqual([
      { name: 'local', command: 'node', args: ['mcp.js'], env: [{ name: 'TOKEN', value: 'secret' }] },
      { type: 'http', name: 'remote', url: 'https://mcp.example/rpc', headers: [{ name: 'Authorization', value: 'Bearer abc' }] },
      { type: 'sse', name: 'sse', url: 'https://mcp.example/events', headers: [{ name: 'X-Id', value: '123' }] },
    ]);
  });

  it('restricts DeepSeek to stdio and HTTP without forwarding SSE', () => {
    const servers = acpMcpServers(view({
      local: { config: { transport: 'stdio', command: 'mcp' } },
      http: { config: { transport: 'http', url: 'https://mcp.example/rpc' } },
      sse: { config: { transport: 'sse', url: 'https://mcp.example/events' } },
    }), '/work', () => undefined, ['stdio', 'http']);
    expect(servers.map((server) => server.name)).toEqual(['local', 'http']);
  });

  it('omits disabled, filtered, unsupported-runtime and host-auth servers', () => {
    const servers = acpMcpServers(view({
      disabled: { config: { transport: 'stdio', command: 'x', enabled: false } },
      removed: { config: { transport: 'stdio', command: 'x' }, status: 'removed' },
      filtered: { config: { transport: 'stdio', command: 'x', enabledTools: [] } },
      remoteRuntime: { config: { transport: 'stdio', command: 'x', runtime_id: 'remote' } },
      otherCwd: { config: { transport: 'stdio', command: 'x', cwd: '/other' } },
      oauth: { config: { transport: 'http', url: 'https://mcp.example', auth: 'oauth' } },
      missingKey: { config: { transport: 'http', url: 'https://mcp.example', bearerTokenEnvVar: 'MCP_KEY' } },
      allowed: { config: { transport: 'stdio', command: 'x', cwd: '/work' } },
    }), '/work', () => undefined);
    expect(servers).toEqual([{ name: 'allowed', command: 'x', args: [], env: [] }]);
  });
});
