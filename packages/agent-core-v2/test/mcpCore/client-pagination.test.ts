import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
