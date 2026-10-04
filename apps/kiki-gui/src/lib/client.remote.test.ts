import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteSpaceClient, KikiClient } from './client';

const connectionId = '11111111-1111-4111-8111-111111111111';
const reply = (data: unknown) => Response.json({ code: 0, msg: 'success', data });
const meta = { server_home_id: '22222222-2222-4222-8222-222222222222', server_id: 'example-instance', server_version: '0.1.0',
  dangerous_bypass_auth: false, started_at: '2026-01-01T00:00:00Z', open_in_apps: [],
  capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true } };

describe('remote space transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses injected fetch for meta, the dedicated snapshot klient and memory requests', async () => {
    const nativeFetch = vi.fn(() => { throw new Error('raw fetch must not run'); });
    vi.stubGlobal('fetch', nativeFetch);
    const injectedFetch = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/meta')) return reply(meta);
      if (path.endsWith('/snapshot')) return Response.json({ code: 40001, msg: 'example snapshot error', data: null });
      return reply({ enabled: true });
    });
    const client = new KikiClient({ baseUrl: 'http://source.example.test', token: 'source-token',
      transport: { fetch: injectedFetch, eventsUrl: 'ws://source.example.test/broker/events' } });
    try {
      await expect(client.meta()).resolves.toMatchObject(meta);
      await expect(client.sessionView('same-session').snapshot()).rejects.toMatchObject({ code: 40001 });
      await expect(client.getMemorySettings()).resolves.toEqual({ enabled: true });
      expect(injectedFetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        '/api/meta', '/api/klient/session-view/same-session/snapshot', '/api/memory/settings',
      ]);
      expect(injectedFetch.mock.calls[2]?.[1]?.headers).toMatchObject({ authorization: 'Bearer source-token' });
      expect(injectedFetch.mock.calls[2]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(nativeFetch).not.toHaveBeenCalled();
    } finally { await client.klient.close(); }
  });

  it('sends remote reads only to the source broker, including the snapshot path', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init?.body as string) });
      expect(String(input)).toBe(`http://source.example.test/api/remote-connections/${connectionId}/call`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer source-token');
      const operation = (calls.at(-1)!.body as { operation: string }).operation;
      return operation === 'meta' ? reply(meta) : Response.json({ code: 40001, msg: 'example read error', data: null });
    }));
    const client = createRemoteSpaceClient({ endpoint: 'http://source.example.test', token: 'source-token', connectionId });
    try {
      await client.meta();
      await expect(client.sessionView('same-session').snapshot()).rejects.toMatchObject({ code: 40001 });
      await expect(client.getMemorySettings()).rejects.toMatchObject({ code: 40001 });
      expect(calls).toHaveLength(3);
      expect(calls[1]?.body).toMatchObject({ operation: 'snapshot', params: { sessionId: 'same-session' } });
      await expect(client.klient.rest!.connections.list()).rejects.toThrow('Operation is not available to a remote space');
      expect(calls).toHaveLength(3);
    } finally { await client.klient.close(); }
  });

  it('rejects malformed connection ids before any fetch', () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => createRemoteSpaceClient({ endpoint: 'http://source.example.test', token: 'source-token', connectionId: 'bad-id' })).toThrow('Invalid connectionId');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
