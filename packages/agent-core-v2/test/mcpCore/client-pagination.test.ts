import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpMcpClient } from '#/mcpCore/client-http';
import { SseMcpClient } from '#/mcpCore/client-sse';
import { StdioMcpClient } from '#/mcpCore/client-stdio';
import type { MCPClient } from '#/mcpCore/types';

const tools = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
  name: `tool_${start + index}`, description: `Tool ${start + index}`,
  inputSchema: { type: 'object' as const, properties: {} },
}));
const clients: readonly [string, () => MCPClient][] = [
  ['stdio', () => new StdioMcpClient({ transport: 'stdio', command: 'fixture-only' }, {
    startupTimeoutMs: 1234, runtimeResolver: undefined as never, workspaceId: 'fixture', runtimeId: 'local',
  })],
  ['http', () => new HttpMcpClient({ transport: 'http', url: 'http://fixture.test/mcp' }, { startupTimeoutMs: 1234 })],
  ['sse', () => new SseMcpClient({ transport: 'sse', url: 'http://fixture.test/sse' }, { startupTimeoutMs: 1234 })],
];

afterEach(() => vi.restoreAllMocks());

type TestClient = MCPClient & {
  connect(): Promise<void>;
  close(): Promise<void>;
  getServerCapabilities(): unknown;
};

describe('tools/list_changed notification bridge', () => {
  it('consumes transport notifications without advertised listChanged capability and drops them after close', async () => {
    const transports: Transport[] = [];
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client, transport) {
      transports.push(transport);
      transport.onmessage = (message: JSONRPCMessage) => {
        (this as unknown as { _onnotification(message: JSONRPCMessage): void })._onnotification(message);
      };
    });
    const instances = clients.map(([, createClient]) => createClient() as TestClient);
    const counts = [0, 0, 0];
    const notification = { jsonrpc: '2.0' as const, method: 'notifications/tools/list_changed' };
    try {
      await Promise.all(instances.map((client) => client.connect()));
      expect(transports).toHaveLength(3);
      expect(instances.map((client) => client.getServerCapabilities())).toEqual([
        undefined,
        undefined,
        undefined,
      ]);

      for (const transport of transports) transport.onmessage?.(notification);
      await Promise.resolve();
      const unsubscribe = instances.map((client, index) => client.onToolsListChanged!(() => {
        counts[index] = counts[index]! + 1;
      }));
      expect(counts).toEqual([1, 1, 1]);

      for (const transport of transports) transport.onmessage?.(notification);
      await Promise.resolve();
      expect(counts).toEqual([2, 2, 2]);

      unsubscribe[1]!();
      transports[1]!.onmessage?.(notification);
      await Promise.resolve();
      expect(counts).toEqual([2, 2, 2]);

      await instances[0]!.close();
      transports[0]!.onmessage?.(notification);
      await Promise.resolve();
      expect(counts).toEqual([2, 2, 2]);
    } finally {
      await Promise.all(instances.map((client) => client.close()));
      connect.mockRestore();
    }
  });
});

describe.each(clients)('%s tools/list pagination', (_name, createClient) => {
  it('keeps the no-cursor result and original initial SDK request', async () => {
    const spy = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: tools(0, 2) });
    expect(await createClient().listTools()).toEqual(tools(0, 2));
    expect(spy.mock.calls).toEqual([[undefined, { timeout: 1234, signal: undefined }]]);
  });

  it('returns both pages while passing the opaque cursor unchanged', async () => {
    const spy = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: tools(0, 2), nextCursor: 'opaque/next?=1' })
      .mockResolvedValueOnce({ tools: tools(2, 1) });
    expect(await createClient().listTools()).toEqual(tools(0, 3));
    expect(spy.mock.calls.map(([params]) => params)).toEqual([undefined, { cursor: 'opaque/next?=1' }]);
  });

  it('returns all 151 tools from three pages rather than only the first 64', async () => {
    const spy = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: tools(0, 64), nextCursor: 'page2' })
      .mockResolvedValueOnce({ tools: tools(64, 64), nextCursor: 'page3' })
      .mockResolvedValueOnce({ tools: tools(128, 23) });
    expect(await createClient().listTools()).toEqual(tools(0, 151));
    expect(spy.mock.calls.map(([params]) => params)).toEqual([undefined, { cursor: 'page2' }, { cursor: 'page3' }]);
    expect(spy.mock.calls.every(([, options]) => options?.timeout === 1234)).toBe(true);
  });

  it('follows an empty opaque cursor instead of treating it as end of pagination', async () => {
    const spy = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: [], nextCursor: '' })
      .mockResolvedValueOnce({ tools: tools(0, 1) });
    expect(await createClient().listTools()).toEqual(tools(0, 1));
    expect(spy.mock.calls[1]?.[0]).toEqual({ cursor: '' });
  });

  it('rejects a repeated cursor cycle rather than looping or returning a partial catalog', async () => {
    const spy = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: tools(0, 1), nextCursor: 'a' })
      .mockResolvedValueOnce({ tools: tools(1, 1), nextCursor: 'b' })
      .mockResolvedValueOnce({ tools: tools(2, 1), nextCursor: 'a' });
    await expect(createClient().listTools()).rejects.toMatchObject({ code: ErrorCode.InvalidRequest, message: expect.stringContaining('repeated pagination cursor') });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('propagates a later-page SDK error without exposing an incomplete tool catalog', async () => {
    const error = new McpError(ErrorCode.InternalError, 'fixture page failure');
    const spy = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: tools(0, 1), nextCursor: 'next' })
      .mockRejectedValueOnce(error);
    await expect(createClient().listTools()).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
