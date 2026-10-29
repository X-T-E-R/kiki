import { describe, expect, it } from 'vitest';

import { acpMcpServers } from '#/app/agentExecutor/acpMcpServers';
import { BUILTIN_AGENT_EXECUTORS } from '#/app/agentExecutor/builtinDescriptorData';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { IHarnessMcpService, type HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
import { acquireHarnessMcp } from '#/agent/execution/harnessMcpLease';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
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
  it('forwards the active home default to stdio only and keeps explicit overrides', () => {
    const servers = acpMcpServers(view({
      inherited: { config: { transport: 'stdio', command: 'mcp' } },
      explicit: { config: { transport: 'stdio', command: 'mcp', env: { KIKI_HOME: 'chosen', KIMI_CODE_HOME: 'vendor' } } },
      remote: { config: { transport: 'http', url: 'https://mcp.example/rpc' } },
    }), '/work', () => undefined, undefined, { KIKI_HOME: 'active' });
    expect(servers).toEqual([
      { name: 'inherited', command: 'mcp', args: [], env: [{ name: 'KIKI_HOME', value: 'active' }] },
      { name: 'explicit', command: 'mcp', args: [], env: [{ name: 'KIKI_HOME', value: 'chosen' }, { name: 'KIMI_CODE_HOME', value: 'vendor' }] },
      { type: 'http', name: 'remote', url: 'https://mcp.example/rpc', headers: [] },
    ]);
  });
  it.each(Object.entries(BUILTIN_AGENT_EXECUTORS))('binds %s to the existing native tool bridge only when its transport supports it', async (id, descriptor) => {
    const acquired: unknown[] = [];
    const lease: HarnessMcpLease = { server: { name: 'kiki', command: 'fixture-mcp', args: [], env: [] }, dispose: () => {} };
    const services = new Map<unknown, unknown>([
      [IAgentScopeContext, { parentAgentId: 'main' }],
      [ISessionContext, { sessionId: 'session-example' }],
      [IHarnessMcpService, { acquire: async (request: unknown) => { acquired.push(request); return lease; } }],
    ]);
    const context: AgentExecutorContext = {
      descriptor: { ...descriptor, id, revision: 'fixture-revision' },
      binding: { executorId: id, systemPrompt: '', thinkingLevel: 'off' },
      agent: { id: 'child-example', accessor: { get: <T>(token: unknown) => services.get(token) as T } },
    };
    const supported = id !== 'openclaw-acp' && id !== 'pi-acp';
    expect(await acquireHarnessMcp(context, '/example')).toBe(supported ? lease : undefined);
    expect(acquired).toHaveLength(supported ? 1 : 0);
    const optedOut = { ...context, binding: { ...context.binding, injectKikiMcp: false } };
    expect(await acquireHarnessMcp(optedOut, '/example')).toBeUndefined();
    services.set(IAgentScopeContext, { parentAgentId: undefined });
    expect(await acquireHarnessMcp(context, '/example')).toBeUndefined();
    if (supported) {
      expect(await acquireHarnessMcp({ ...context, binding: { ...context.binding, injectKikiMcp: true } }, '/example')).toBe(lease);
    } else {
      await expect(acquireHarnessMcp({ ...context, binding: { ...context.binding, injectKikiMcp: true } }, '/example'))
        .rejects.toMatchObject({ code: 'config.invalid' });
    }
  });
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
