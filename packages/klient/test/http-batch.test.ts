import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { HttpChannel } from '../src/transports/http/channel.js';

describe('HttpChannel micro-batching', () => {
  it('streams out-of-order NDJSON lines from /api/klient/batch and keeps single calls on /api/klient/call', async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          procedure?: { method: string };
          calls?: Array<{ id: string; procedure: { method: string } }>;
        };
        if (req.url === '/api/klient/call') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'OK', data: `single:${body.procedure?.method}`, request_id: 'r1' }));
          return;
        }
        if (req.url === '/api/klient/batch') {
          req.socket.setNoDelay(true);
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
          const calls = body.calls ?? [];
          let remaining = calls.length;
          for (const item of calls) {
            const delayMs = item.procedure.method === 'slow' ? 140 : 5;
            setTimeout(() => {
              if (!res.writableEnded) {
                res.write(`${JSON.stringify({
                  id: item.id,
                  envelope: { code: 0, msg: 'OK', data: `batch:${item.procedure.method}`, request_id: 'rb' },
                })}\n`);
              }
              remaining -= 1;
              if (remaining === 0 && !res.writableEnded) res.end();
            }, delayMs);
          }
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const channel = new HttpChannel({ endpoint: `http://127.0.0.1:${port}` });
    try {
      expect(await channel.call({}, 'svc', 'one', [])).toBe('single:one');
      expect(paths).toEqual(['/api/klient/call']);

      paths.length = 0;
      const startedAt = performance.now();
      let fastAt = 0;
      let slowAt = 0;
      const slow = channel.call({}, 'svc', 'slow', []).then((val) => {
        slowAt = performance.now() - startedAt;
        return val;
      });
      const fast = channel.call({}, 'svc', 'fast', []).then((val) => {
        fastAt = performance.now() - startedAt;
        return val;
      });
      expect(await Promise.all([slow, fast])).toEqual(['batch:slow', 'batch:fast']);
      expect(paths).toEqual(['/api/klient/batch']);
      expect(slowAt).toBeGreaterThan(fastAt + 75);
    } finally {
      await channel.close();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  it('transparently falls back to individual /api/klient/call requests when /api/klient/batch returns 404', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      requests.push(url.pathname);
      if (url.pathname === '/api/klient/batch') {
        return new Response('Not Found', { status: 404 });
      }
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      const body = JSON.parse(bodyText) as { procedure: { method: string } };
      return new Response(
        JSON.stringify({ code: 0, msg: 'OK', data: `single:${body.procedure.method}`, request_id: 'r1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    try {
      const first = await Promise.all([
        channel.call({}, 'svc', 'alpha', []),
        channel.call({}, 'svc', 'beta', []),
        channel.call({}, 'svc', 'gamma', []),
      ]);
      expect(first).toEqual(['single:alpha', 'single:beta', 'single:gamma']);
      expect(requests).toEqual([
        '/api/klient/batch',
        '/api/klient/call',
        '/api/klient/call',
        '/api/klient/call',
      ]);

      requests.length = 0;
      const second = await Promise.all([
        channel.call({}, 'svc', 'delta', []),
        channel.call({}, 'svc', 'epsilon', []),
      ]);
      expect(second).toEqual(['single:delta', 'single:epsilon']);
      expect(requests).toEqual(['/api/klient/call', '/api/klient/call']);
    } finally {
      await channel.close();
    }
  });

  it('disables batching cleanly when batch: false is configured', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      paths.push(new URL(url).pathname);
      return new Response(
        JSON.stringify({ code: 0, msg: 'OK', data: 'ok', request_id: 'r1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
      batch: false,
    });
    try {
      await Promise.all([
        channel.call({}, 'svc', 'a', []),
        channel.call({}, 'svc', 'b', []),
      ]);
      expect(paths).toEqual(['/api/klient/call', '/api/klient/call']);
    } finally {
      await channel.close();
    }
  });
});
