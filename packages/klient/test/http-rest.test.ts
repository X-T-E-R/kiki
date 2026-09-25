import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HTTP_TRANSPORT_TIMEOUT_REASON, HttpChannel } from '../src/transports/http/channel.js';

function envelope(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, msg: code === 0 ? 'success' : 'failed', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HTTP REST domains', () => {
  it('uses the auth-exempt unversioned health endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/healthz');
      expect(init?.method).toBe('GET');
      expect(init?.headers).not.toHaveProperty('authorization');
      return envelope({ ok: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.healthz()).resolves.toBe(true);
    } finally {
      await channel.close();
    }
  });

  it('routes unversioned session and runtime domains through /api', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/sessions') {
        return envelope({ items: [], has_more: false });
      }
      if (url.pathname === '/api/mcp/runtime/servers') {
        return envelope({ servers: [] });
      }
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.sessions.list()).resolves.toEqual({ items: [], has_more: false });
      await expect(channel.rest.runtime.listMcpServers()).resolves.toEqual({ servers: [] });
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        '/api/sessions',
        '/api/mcp/runtime/servers',
      ]);
    } finally {
      await channel.close();
    }
  });

  it('reads built-in skill content by name without passing its URI to the file endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(String(input)).pathname).toBe('/api/skills/kiki%2Fops:content');
      return envelope({ name: 'kiki/ops', content: '# Built-in instructions' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.skills.readBuiltinContent('kiki/ops')).resolves.toEqual({
        name: 'kiki/ops', content: '# Built-in instructions',
      });
    } finally {
      await channel.close();
    }
  });

  it('reads one encoded provider entry from the model directory', async () => {
    const catalog = { id: 'edge/gateway', models: [] };
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(String(input)).pathname).toBe('/api/catalog/providers/edge%2Fgateway');
      return envelope(catalog);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.catalog.provider('edge/gateway')).resolves.toEqual(catalog);
    } finally {
      await channel.close();
    }
  });

  it('posts unsaved provider probes through the authenticated HTTP transport', async () => {
    const draft = { type: 'anthropic' as const, base_url: 'https://api.example.test/v1', api_key: 'draft-key' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/providers:probe');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(draft);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-token');
      return envelope({ ok: true, models: ['claude-example'] });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'server-token', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.providers.probe(draft)).resolves.toEqual({ ok: true, models: ['claude-example'] });
    } finally {
      await channel.close();
    }
  });

  it('routes cron list and task actions through /api/cron with the disambiguating session query', async () => {
    const seen: { pathname: string; method: string; sessionId: string | null }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({
        pathname: url.pathname,
        method: init?.method ?? 'GET',
        sessionId: url.searchParams.get('session_id'),
      });
      if (url.pathname === '/api/cron') return envelope({ items: [] });
      if (url.pathname.endsWith(':pause') || url.pathname.endsWith(':resume')) {
        return envelope({ task: { id: 'task-1' } });
      }
      if (url.pathname.endsWith(':run')) return envelope({ triggered: true });
      return envelope({ deleted: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.cron.list()).resolves.toEqual({ items: [] });
      await expect(channel.rest.cron.list({ session_id: 'session-1' })).resolves.toEqual({ items: [] });
      await channel.rest.cron.pause('task-1', { session_id: 'session-1' });
      await channel.rest.cron.resume('task-1');
      await channel.rest.cron.run('task-1', { session_id: 'session-1' });
      await channel.rest.cron.remove('task-1', { session_id: 'session-1' });
      expect(seen).toEqual([
        { pathname: '/api/cron', method: 'GET', sessionId: null },
        { pathname: '/api/cron', method: 'GET', sessionId: 'session-1' },
        { pathname: '/api/cron/task-1:pause', method: 'POST', sessionId: 'session-1' },
        { pathname: '/api/cron/task-1:resume', method: 'POST', sessionId: null },
        { pathname: '/api/cron/task-1:run', method: 'POST', sessionId: 'session-1' },
        { pathname: '/api/cron/task-1', method: 'DELETE', sessionId: 'session-1' },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('sends the owning agent id when reading task details', async () => {
    const task = { id: 'task-1', output_preview: 'child output' };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/sessions/session-1/tasks/task-1');
      expect(url.searchParams.get('with_output')).toBe('true');
      expect(url.searchParams.get('agent_id')).toBe('agent-a');
      return envelope(task);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(
        channel.rest.sessions.getTask('session-1', 'task-1', {
          with_output: true,
          agent_id: 'agent-a',
        }),
      ).resolves.toEqual(task);
    } finally {
      await channel.close();
    }
  });

  it('sends lease ids in the REST body and returns the server lease', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return envelope({ lease_id: 'lease_test', expires_at: 123 });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.renewLease({})).resolves.toEqual({ lease_id: 'lease_test', expires_at: 123 });
      await expect(channel.rest.renewLease({ lease_id: 'lease_test' })).resolves.toEqual({
        lease_id: 'lease_test',
        expires_at: 123,
      });
      expect(bodies).toEqual([{}, { lease_id: 'lease_test' }]);
    } finally {
      await channel.close();
    }
  });

  it('uses the dedicated runtime MCP restart action without a version alias', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/mcp/runtime/servers/server%2Fone:restart');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({});
      return envelope({ restarting: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.runtime.restartMcpServer('server/one')).resolves.toEqual({ restarting: true });
    } finally {
      await channel.close();
    }
  });

  it('preserves raw attachment bytes, MIME, and server filename', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => new Response(new Uint8Array([0, 255, 7]), {
      status: 200,
      headers: {
        'content-type': 'image/png; charset=binary',
        'content-disposition': "inline; filename*=UTF-8''diagram%20final.png",
      },
    }));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const result = await channel.rest.sessions.media('session one', 'file/diagram');
      expect([...result.bytes]).toEqual([0, 255, 7]);
      expect(result.mime).toBe('image/png');
      expect(result.name).toBe('diagram final.png');
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
        '/api/sessions/session%20one/media/file%2Fdiagram',
      );
    } finally {
      await channel.close();
    }
  });

  it('keeps valid JSON files as raw bytes, even when they resemble an envelope', async () => {
    const envelopeShaped = '{"code":50001,"msg":"file document","data":{"ok":true}}';
    const ordinaryJson = '{"items":[1,2,3]}';
    const fetchMock = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body = path.includes('/media/') ? envelopeShaped : ordinaryJson;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const media = await channel.rest.sessions.media('s1', 'document.json');
      const hostFile = await channel.rest.filesystem.readHostFileBytes('/tmp/document.json');
      expect([...media.bytes]).toEqual([...new TextEncoder().encode(envelopeShaped)]);
      expect(media.mime).toBe('application/json');
      expect([...hostFile.bytes]).toEqual([...new TextEncoder().encode(ordinaryJson)]);
      expect(hostFile.mime).toBe('application/json');
    } finally {
      await channel.close();
    }
  });

  it('keeps archive JSON errors and non-2xx errors on the error path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 50001,
        msg: 'archive.failed',
        data: { archive: 'missing' },
        request_id: 'req-archive',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 40101,
        msg: 'auth.required',
        data: { route: 'export' },
        request_id: 'req-auth',
      }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.sessions.export('s1')).rejects.toMatchObject({
        name: 'RPCError',
        code: 50001,
        requestId: 'req-archive',
        data: { archive: 'missing' },
      });
      await expect(channel.rest.sessions.export('s1')).rejects.toMatchObject({
        name: 'RPCError',
        code: 40101,
        requestId: 'req-auth',
        data: { route: 'export' },
      });
    } finally {
      await channel.close();
    }
  });

  it('propagates envelope errors with request metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 40410,
      msg: 'workspace.not_found',
      data: { workspace_id: 'missing' },
      request_id: 'req-rest',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.workspaces.remove('missing')).rejects.toMatchObject({
        name: 'RPCError',
        code: 40410,
        requestId: 'req-rest',
        data: { workspace_id: 'missing' },
      });
    } finally {
      await channel.close();
    }
  });
});

describe('native HTTP response lifecycle', () => {
  const server = createServer((_request, response) => handler(response));
  let handler: (response: ServerResponse) => void;
  let channel: HttpChannel;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function later(action: () => void, delay: number): void {
    timers.add(setTimeout(action, delay));
  }

  beforeEach(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing TCP address');
    channel = new HttpChannel({ endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 100 });
  });

  afterEach(async () => {
    await channel.close();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  });

  it('rejects oversized UTF-8 requests before opening a connection and preserves the input', async () => {
    let reached = false;
    handler = (response) => {
      reached = true;
      response.end(JSON.stringify({ code: 0, msg: 'success', data: null }));
    };
    const input = { text: '文'.repeat(4 * 1024 * 1024) };
    await expect(channel.call({}, 'example', 'write', [input], { timeoutMs: 0 })).rejects.toMatchObject({ code: 40001, message: expect.stringContaining('size limit') });
    expect(reached).toBe(false);
    expect(input.text.length).toBe(4 * 1024 * 1024);
  });

  it.each(['json', 'binary'] as const)('bounds a stalled %s body after headers on a real socket', async (kind) => {
    handler = (response) => {
      response.writeHead(200, { 'content-type': kind === 'json' ? 'application/json' : 'application/octet-stream' });
      response.write(kind === 'json' ? '{"code":0,' : 'partial file');
    };
    const operation = kind === 'json' ? channel.rest.meta() : channel.rest.sessions.media('s', 'f');
    await expect(operation).rejects.toMatchObject({ code: 50001, reason: HTTP_TRANSPORT_TIMEOUT_REASON });
  });

  it.each(['json', 'binary'] as const)('reports a severed %s body as connection failure, not malformed JSON or timeout', async (kind) => {
    handler = (response) => {
      response.writeHead(200, { 'content-type': kind === 'json' ? 'application/json' : 'application/octet-stream', 'content-length': '1024' });
      response.write(kind === 'json' ? '{"code":0,' : 'partial file');
      later(() => response.destroy(), 15);
    };
    const operation = kind === 'json' ? channel.rest.meta() : channel.rest.sessions.media('s', 'f');
    await expect(operation).rejects.toMatchObject({ name: 'RPCError', code: -1 });
  });

  it('distinguishes a complete malformed document from a server failure envelope', async () => {
    handler = (response) => response.end('{broken');
    await expect(channel.rest.meta()).rejects.toMatchObject({ code: 200, message: 'HTTP 200 — non-JSON response' });
    handler = (response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 50001, msg: 'upstream failed', request_id: 'server-failure' }));
    };
    await expect(channel.rest.meta()).rejects.toMatchObject({ code: 50001, message: 'upstream failed', reason: undefined, requestId: 'server-failure' });
  });

  it('does not accept an HTTP failure merely because its JSON claims success', async () => {
    handler = (response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, msg: 'success', data: { ok: true } }));
    };
    await expect(channel.rest.meta()).rejects.toMatchObject({ code: 503 });
  });

  it('keeps long export body consumption alive without the default deadline', async () => {
    handler = (response) => {
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.write('archive-');
      later(() => response.end('complete'), 180);
    };
    const archive = await channel.rest.sessions.export('s');
    expect(await archive.blob.text()).toBe('archive-complete');
  });

  it('cancels the ignored body of an optional missing route instead of leaving its socket active', async () => {
    let disconnected = false;
    handler = (response) => {
      response.once('close', () => { disconnected = true; });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.write('{"code":40401,');
    };
    await channel.rest.renewLease({});
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 300 });
  });

  it.each(['caller', 'close'] as const)('keeps %s cancellation attached until the native response body finishes', async (action) => {
    let notifyHeaders!: () => void;
    const headersSent = new Promise<void>((resolve) => { notifyHeaders = resolve; });
    handler = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"code":0,');
      notifyHeaders();
    };
    const controller = new AbortController();
    const operation = channel.call({}, 'example', 'read', [], { signal: controller.signal, timeoutMs: 0 }).catch((error: unknown) => error);
    await headersSent;
    if (action === 'caller') controller.abort();
    else await channel.close();
    const failure = await operation;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ reason: HTTP_TRANSPORT_TIMEOUT_REASON });
    if (action === 'close') expect(failure).toMatchObject({ message: 'http closed' });
    await channel.close();
  });

  it('preserves envelope-shaped JSON host files exactly on native fetch', async () => {
    const document = '{"code":40111,"msg":"document, not error","data":null}\n';
    handler = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(document);
    };
    expect(await channel.rest.filesystem.readHostFile('/document.json')).toBe(document);
    expect(new TextDecoder().decode((await channel.rest.filesystem.readHostFileBytes('/document.json')).bytes)).toBe(document);
  });
});
