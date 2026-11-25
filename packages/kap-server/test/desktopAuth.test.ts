import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebAccessStatus } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const DESKTOP_ENDPOINTS = [
  '/api/desktop/spaces',
  '/api/desktop/ssh/profiles',
  '/api/desktop/plugin-focus',
] as const;

describe('desktop routes local-owner security gate', () => {
  let home: string;
  let server: RunningServer;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-desktop-auth-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: home,
      port: 0,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function ownerRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${server.localOwnerToken}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json()) as { code: number; msg: string; data: T };
    expect(response.status, `${path}: ${payload.msg}`).toBe(200);
    expect(payload.code, `${path}: ${payload.msg}`).toBe(0);
    return payload.data;
  }

  it('allows local-owner bearer token and returns 403 for web-access, peer bridge, and non-owner tokens across all /api/desktop/* routes', async () => {
    for (const endpoint of DESKTOP_ENDPOINTS) {
      const ok = await fetch(base + endpoint, {
        headers: { authorization: `Bearer ${server.localOwnerToken}` },
      });
      expect(ok.status, endpoint).toBe(200);
      const body = (await ok.json()) as { code: number };
      expect(body.code, endpoint).toBe(0);
    }

    await ownerRequest<WebAccessStatus>('/api/web-access', 'PUT', { mode: 'temporary', port: 0 });
    const link = await ownerRequest<{ url: string }>('/api/web-access/links', 'POST', {});
    const linkUrl = new URL(link.url);
    const exchangeRes = await fetch(linkUrl.origin + '/api/web-access/exchange', {
      method: 'POST',
      headers: { origin: linkUrl.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ code: linkUrl.hash.slice('#access='.length) }),
    });
    expect(exchangeRes.status).toBe(200);
    const webCookie = exchangeRes.headers.get('set-cookie')!.split(';')[0]!;

    await server.admission.setEnabled(true);
    const pairCode = await ownerRequest<{ code: string }>('/api/remote-connections/inbound/pair-code', 'POST', {
      label: 'Peer Desktop Auth Check',
      allowBridge: true,
    });
    const claimRes = await fetch(linkUrl.origin + '/api/remote-connections/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: pairCode.code,
        source: { homeId: randomUUID(), hostId: 'peer-desktop-check', protocol: 1 },
        sourceLabel: 'Peer Host',
        requestBridge: true,
      }),
    });
    expect(claimRes.status).toBe(200);
    const { peerToken } = ((await claimRes.json()) as { data: { peerToken: string } }).data;
    const serverAuthToken = server.authTokenService.getToken();

    for (const endpoint of DESKTOP_ENDPOINTS) {
      const webOnWebListener = await fetch(linkUrl.origin + endpoint, {
        headers: { cookie: webCookie },
      });
      expect(webOnWebListener.status, `web listener cookie ${endpoint}`).toBe(403);
      expect(((await webOnWebListener.json()) as { msg: string }).msg).toBe('local_owner_required');

      const peerOnMainListener = await fetch(base + endpoint, {
        headers: { authorization: `Bearer ${peerToken}` },
      });
      expect(peerOnMainListener.status, `peer token ${endpoint}`).toBe(403);
      expect(((await peerOnMainListener.json()) as { msg: string }).msg).toBe('local_owner_required');

      const peerOnWebListener = await fetch(linkUrl.origin + endpoint, {
        headers: { authorization: `Bearer ${peerToken}` },
      });
      expect(peerOnWebListener.status, `peer token on web listener ${endpoint}`).toBe(403);
      expect(((await peerOnWebListener.json()) as { msg: string }).msg).toBe('local_owner_required');

      const nonOwnerTokenRes = await fetch(base + endpoint, {
        headers: { authorization: `Bearer ${serverAuthToken}` },
      });
      expect(nonOwnerTokenRes.status, `non-owner auth token ${endpoint}`).toBe(403);
      expect(((await nonOwnerTokenRes.json()) as { msg: string }).msg).toBe('local_owner_required');

      const encodedPath = endpoint.replace('/desktop/', '/%64esktop/');
      const encodedNonOwner = await fetch(base + encodedPath, {
        headers: { authorization: `Bearer ${serverAuthToken}` },
      });
      expect(encodedNonOwner.status, `encoded non-owner ${encodedPath}`).toBe(403);
      expect(((await encodedNonOwner.json()) as { msg: string }).msg).toBe('local_owner_required');
    }

    await ownerRequest<WebAccessStatus>('/api/web-access', 'PUT', { mode: 'temporary' });
    const mainPortLink = await ownerRequest<{ url: string }>('/api/web-access/links', 'POST', {});
    const mainLinkUrl = new URL(mainPortLink.url);
    const mainExchangeRes = await fetch(mainLinkUrl.origin + '/api/web-access/exchange', {
      method: 'POST',
      headers: { origin: mainLinkUrl.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ code: mainLinkUrl.hash.slice('#access='.length) }),
    });
    expect(mainExchangeRes.status).toBe(200);
    const mainWebCookie = mainExchangeRes.headers.get('set-cookie')!.split(';')[0]!;
    for (const endpoint of DESKTOP_ENDPOINTS) {
      const webOnMainListener = await fetch(mainLinkUrl.origin + endpoint, {
        headers: { cookie: mainWebCookie },
      });
      expect(webOnMainListener.status, `main listener web cookie ${endpoint}`).toBe(403);
      expect(((await webOnMainListener.json()) as { msg: string }).msg).toBe('local_owner_required');
    }
  });

  it('keeps /api/desktop/* protected by local-owner auth even when disableAuth is enabled (d24 gate)', async () => {
    const bypassHome = await mkdtemp(join(tmpdir(), 'kiki-desktop-auth-d24-'));
    await writeFile(join(bypassHome, 'config.toml'), '[search]\nenabled = false\n');
    const bypassServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: bypassHome,
      port: 0,
      logLevel: 'silent',
      disableAuth: true,
    });
    const bypassBase = `http://127.0.0.1:${bypassServer.port}`;
    try {
      for (const endpoint of DESKTOP_ENDPOINTS) {
        const unauthed = await fetch(bypassBase + endpoint);
        expect(unauthed.status, `unauthed d24 ${endpoint}`).toBe(401);

        const nonOwner = await fetch(bypassBase + endpoint, {
          headers: { authorization: `Bearer ${bypassServer.authTokenService.getToken()}` },
        });
        expect(nonOwner.status, `non-owner d24 ${endpoint}`).toBe(403);

        const localOwner = await fetch(bypassBase + endpoint, {
          headers: { authorization: `Bearer ${bypassServer.localOwnerToken}` },
        });
        expect(localOwner.status, `local-owner d24 ${endpoint}`).toBe(200);
      }
    } finally {
      await bypassServer.close();
      await rm(bypassHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
