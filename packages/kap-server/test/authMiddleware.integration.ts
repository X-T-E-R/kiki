import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createAuthHook, authenticatedForwardHeaders } from '../src/middleware/auth';
import { fixedTokenAuth } from './helpers/fixedAuth';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

describe('server-v2 /api bearer auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-middleware-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  it('allows healthz without a token', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const res = await server.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects /api/auth without a token with 40101', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const res = await server.app.inject({ method: 'GET', url: '/api/auth' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('rejects /api/auth with a wrong token', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/auth',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('accepts /api/auth with the trusted local owner capability', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const token = server.localOwnerToken;
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/auth',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(0);
  });

  it('requires auth for /openapi.json', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const res = await server.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(401);
  });
});


it('forwards the authenticated Cookie or bearer principal without replacing it with an owner token', async () => {
  const app = Fastify();
  const authorizeCookie = vi.fn(async () => true);
  app.addHook('onRequest', createAuthHook(fixedTokenAuth('legacy-test-token'), { authorizeCookie }));
  app.post('/api/principal', async (request) => authenticatedForwardHeaders(request));
  try {
    const browser = await app.inject({ method: 'POST', url: '/api/principal', headers: { cookie: 'test_session=browser-secret', origin: 'http://example.test', host: 'example.test' } });
    expect(browser.statusCode).toBe(200); expect(browser.json()).toEqual({ cookie: 'test_session=browser-secret', origin: 'http://example.test', host: 'example.test' });
    expect(authorizeCookie).toHaveBeenCalledOnce();
    const invalid = await app.inject({ method: 'POST', url: '/api/principal', headers: { cookie: 'test_session=browser-secret', authorization: 'Bearer invalid' } });
    expect(invalid.statusCode).toBe(401); expect(authorizeCookie).toHaveBeenCalledOnce();
    const native = await app.inject({ method: 'POST', url: '/api/principal', headers: { authorization: 'Bearer legacy-test-token', cookie: 'test_session=browser-secret' } });
    expect(native.statusCode).toBe(200); expect(native.json()).toEqual({ authorization: 'Bearer legacy-test-token' });
  } finally { await app.close(); }
});
