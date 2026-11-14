import { request as httpRequest } from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecurityHeadersHook } from '../../src/middleware/securityHeaders';
import { registerPluginPanelDocuments } from '../../src/routes/pluginPanelDocuments';
import { ConnectionAdmission } from '../../src/services/connections/admission';
import { ConnectionAudience } from '../../src/services/connections/audience';
import { setWebPrincipal } from '../../src/services/webAccess';

const PANEL_HTML = '<!doctype html><html><body><script>window.fixture = "unsafe-inline";</script></body></html>';
const TTL_MS = 10 * 60_000;

interface MintResponse {
  url: string;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
}

function requestWithHost(url: string, host = new URL(url).host): Promise<RawResponse> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      headers: { host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text: async () => body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

describe('plugin panel documents', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
    const mint = registerPluginPanelDocuments(app);
    app.get('/mint', async (request): Promise<MintResponse> => ({ url: await mint(PANEL_HTML, request) }));
    app.get('/mint-web', async (request): Promise<MintResponse> => {
      setWebPrincipal(request, { kind: 'web', sessionId: 'fixture-session' });
      return { url: await mint(PANEL_HTML, request) };
    });
    const admission = {
      matchBearer: () => undefined,
      authorize: () => ({ id: 'fixture-grant', revision: 1 }),
      attach: () => () => undefined,
    } as unknown as ConnectionAdmission;
    const audience = new ConnectionAudience(admission, 'local-owner', async () => true, () => 'main');
    app.get('/api/plugins/demo/panels/settings/document', async (request, reply): Promise<MintResponse | undefined> => {
      if (!await audience.authorize('owner-token', request, reply)) return undefined;
      return { url: await mint(PANEL_HTML, request) };
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function mintDocument(headers: Record<string, string>, remoteAddress: string): Promise<string> {
    const response = await app.inject({ method: 'GET', url: '/mint', headers, remoteAddress });
    expect(response.statusCode).toBe(200);
    return (response.json() as MintResponse).url;
  }

  it('serves loopback grants from the shared local listener with strict CSP and no authorization', async () => {
    const url = await mintDocument({ host: 'localhost' }, '127.0.0.1');
    const parsed = new URL(url);
    expect(parsed.hostname).toMatch(/^[a-f0-9]{32}\.kiki-document\.localhost$/u);
    expect(parsed.pathname).toMatch(/^\/plugin-panel\/[a-f0-9]{64}$/u);
    const secondUrl = new URL(await mintDocument({ host: 'localhost' }, '127.0.0.1'));
    expect(secondUrl.port).toBe(parsed.port);
    expect(secondUrl.hostname).toMatch(/^[a-f0-9]{32}\.kiki-document\.localhost$/u);

    const response = await requestWithHost(url, parsed.host);
    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(response.headers['content-security-policy']).toContain("script-src 'unsafe-inline'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await response.text()).toContain('<script>window.fixture = "unsafe-inline";</script>');
  });

  it('rejects a wrong host and unknown grant on the loopback listener', async () => {
    const url = await mintDocument({ host: 'localhost' }, '127.0.0.1');
    const parsed = new URL(url);
    const wrongHost = await requestWithHost(url, `wrong.kiki-document.localhost:${parsed.port}`);
    expect(wrongHost.status).toBe(404);

    const unknown = await requestWithHost(`http://127.0.0.1:${parsed.port}/plugin-panel/${'f'.repeat(64)}`, parsed.host);
    expect(unknown.status).toBe(404);
  });

  it('uses the raw main-server path for nonloopback and web principals without a CSP override', async () => {
    const remoteUrl = await mintDocument({ host: '192.0.2.10' }, '192.0.2.10');
    expect(remoteUrl).toMatch(/^\/plugin-panel\/[a-f0-9]{64}$/u);
    const remoteResponse = await app.inject({ method: 'GET', url: remoteUrl, headers: { host: '192.0.2.10' } });
    expect(remoteResponse.statusCode).toBe(200);
    expect(remoteResponse.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(remoteResponse.headers['content-security-policy']).toContain("script-src 'unsafe-inline'");
    expect(remoteResponse.headers['content-security-policy']).not.toContain("default-src 'self'");

    const webUrlResponse = await app.inject({ method: 'GET', url: '/mint-web', headers: { host: 'localhost' }, remoteAddress: '127.0.0.1' });
    const webUrl = (webUrlResponse.json() as MintResponse).url;
    expect(webUrl).toMatch(/^\/plugin-panel\/[a-f0-9]{64}$/u);
    expect((await app.inject({ method: 'GET', url: webUrl, headers: { host: 'localhost' } })).statusCode).toBe(200);

    const peerResponse = await app.inject({
      method: 'GET',
      url: '/api/plugins/demo/panels/settings/document',
      headers: { host: 'localhost' },
      remoteAddress: '127.0.0.1',
    });
    const peerUrl = (peerResponse.json() as MintResponse).url;
    expect(peerUrl).toMatch(/^\/plugin-panel\/[a-f0-9]{64}$/u);
  });

  it('expires grants at the ten-minute TTL', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const url = await mintDocument({ host: '192.0.2.10' }, '192.0.2.10');
      clock.mockReturnValue(now + TTL_MS);
      const response = await app.inject({ method: 'GET', url, headers: { host: '192.0.2.10' } });
      expect(response.statusCode).toBe(404);
    } finally {
      clock.mockRestore();
    }
  });

  it('evicts the oldest grant after reaching the 128-grant bound', async () => {
    const urls: string[] = [];
    for (let i = 0; i < 129; i += 1) urls.push(await mintDocument({ host: '192.0.2.10' }, '192.0.2.10'));

    expect((await app.inject({ method: 'GET', url: urls[0]!, headers: { host: '192.0.2.10' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: urls[1]!, headers: { host: '192.0.2.10' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: urls[128]!, headers: { host: '192.0.2.10' } })).statusCode).toBe(200);
  });
});
