import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHtmlPreviewRoutes, HTML_PREVIEW_OPAQUE_CSP } from '../src/routes/htmlPreview';
import type { RemoteConnectionManager } from '../src/services/connections/manager';
import { createOriginHook, isOriginAllowed } from '../src/middleware/origin';
import { createSecurityHeadersHook } from '../src/middleware/securityHeaders';
import { ConnectionAudience } from '../src/services/connections/audience';
import type { ConnectionAdmission } from '../src/services/connections/admission';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'html-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'slides'));
  await mkdir(join(root, 'systems'));
  await writeFile(join(root, 'slides/index.html'), '<!doctype html><script src="../app.js"></script><iframe src="../systems/index.html?shot=2#slide"></iframe>');
  await writeFile(join(root, 'app.js'), 'window.loaded=true');
  await writeFile(join(root, 'systems/index.html'), '<h1>nested</h1>');
  await writeFile(join(root, 'font.woff2'), new Uint8Array([1, 2, 3, 4]));
  const hostFs = { realpath, stat: async (path: string) => { const s = await stat(path); return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } };
  const core = { accessor: { get: (token: { toString(): string }) => token.toString() === 'workspaceService' ? { list: async () => [{ root }] } : hostFs } } as unknown as Scope;
  const app = Fastify();
  app.addHook('onRequest', createOriginHook({}));
  app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  app.get('/api/private', async () => ({ secret: true }));
  registerHtmlPreviewRoutes(app, core, {} as RemoteConnectionManager);
  cleanups.push(() => app.close());
  const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root, path: join(root, 'slides/index.html') } });
  expect(opened.statusCode, opened.body).toBe(200);
  const data = opened.json().data as { url: string; preview_id: string; sandbox: string };
  return { app, root, data };
}
describe('browser document resource tree', () => {
  it('serves unmodified documents and relative sibling resources with MIME and opaque-origin policy', async () => {
    const { app, root, data } = await fixture();
    const document = await app.inject(data.url + '?shot=3');
    expect(document.rawPayload).toEqual(await readFile(join(root, 'slides/index.html')));
    expect(document.headers['content-security-policy']).toBe(HTML_PREVIEW_OPAQUE_CSP);
    expect(data.sandbox).toContain('allow-scripts');
    expect(data.sandbox).toContain('allow-same-origin');
    const nested = new URL('../systems/index.html?shot=2#slide', data.url);
    const resource = await app.inject(nested.pathname + nested.search);
    expect(resource.statusCode).toBe(200);
    expect(resource.body).toBe('<h1>nested</h1>');
    const script = await app.inject(new URL('../app.js', data.url).pathname);
    expect(script.headers['content-type']).toContain('text/javascript');
    const font = await app.inject({ url: new URL('../font.woff2', data.url).pathname, headers: { origin: 'null' } });
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.headers['access-control-allow-origin']).toBe('*');
    const privateResponse = await app.inject({ url: '/api/private', headers: { origin: 'null' } });
    expect(privateResponse.statusCode).toBe(403);
    expect(privateResponse.headers['access-control-allow-origin']).toBeUndefined();
    const normal = await app.inject('/api/private');
    expect(normal.headers['content-security-policy']).toContain("default-src 'self'");
  });
  it('rejects traversal and canonical symlink escapes and revokes tab capability on close', async () => {
    const { app, root, data } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'html-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'secret.html'), 'secret');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await app.inject(`/html-preview/${data.preview_id}/escape/secret.html`)).statusCode).toBe(403);
    expect((await app.inject(`/api/html-preview/${data.preview_id}/resource?path=..%2Fsecret.html`)).statusCode).toBe(403);
    expect((await app.inject(`/html-preview/${data.preview_id}/%2e%2e/secret.html`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root, path: join(outside, 'secret.html') } })).statusCode).toBe(403);
    const unregistered = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root: outside, path: join(outside, 'secret.html') } });
    expect(unregistered.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: '/api/fs:html-preview/' + unregistered.json().data.preview_id });
    expect((await app.inject({ method: 'DELETE', url: '/api/fs:html-preview/' + data.preview_id })).statusCode).toBe(200);
    expect((await app.inject(data.url)).statusCode).toBe(404);
  });
});

it('serves remote-host bytes through a local capability and revokes on connection loss', async () => {
  const target = await fixture();
  const endpoint = await target.app.listen({ host: '127.0.0.1', port: 0 });
  const controllers = new Set<AbortController>();
  const calls: string[] = [];
  const manager = {
    lease: (_id: string, parent?: AbortSignal) => {
      const controller = new AbortController(); controllers.add(controller);
      parent?.addEventListener('abort', () => controller.abort(), { once: true });
      return { signal: controller.signal, release: () => { controllers.delete(controller); controller.abort(); } };
    },
    resolveTransport: () => ({}),
    forward: async (_id: string, input: { operation: string; params?: { previewId?: string }; query?: { path?: string }; body?: unknown }, signal: AbortSignal) => {
      calls.push(input.operation);
      const path = input.operation === 'htmlPreviewOpen' ? '/api/fs:html-preview' : input.operation === 'htmlPreviewClose' ? '/api/fs:html-preview/' + input.params?.previewId : '/api/html-preview/' + input.params?.previewId + '/resource?path=' + encodeURIComponent(input.query?.path ?? '');
      return fetch(endpoint + path, { signal, method: input.operation === 'htmlPreviewOpen' ? 'POST' : input.operation === 'htmlPreviewClose' ? 'DELETE' : 'GET', headers: { 'content-type': 'application/json' }, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
    },
  };
  const broker = Fastify();
  registerHtmlPreviewRoutes(broker, { accessor: { get: () => ({ realpath: () => { throw new Error('must not read broker filesystem for remote paths'); } }) } } as unknown as Scope, manager as unknown as RemoteConnectionManager);
  cleanups.push(() => broker.close());
  const response = await broker.inject({ method: 'POST', url: '/api/remote-connections/example/html-preview', payload: { root: target.root, path: join(target.root, 'slides/index.html') } });
  expect(response.statusCode, response.body).toBe(200);
  const opened = response.json().data as { preview_id: string; url: string };
  expect(opened.preview_id).not.toBe(target.data.preview_id);
  const content = await broker.inject(opened.url);
  expect(content.rawPayload).toEqual(await readFile(join(target.root, 'slides/index.html')));
  expect(content.headers['content-security-policy']).toBe(HTML_PREVIEW_OPAQUE_CSP);
  expect(calls).toEqual(['htmlPreviewOpen', 'htmlPreviewResource']);
  for (const controller of [...controllers]) controller.abort();
  expect((await broker.inject(opened.url)).statusCode).toBe(404);
});

it('requires target-owner authorization rather than treating peer credentials as a host-root grant', async () => {
  const audience = new ConnectionAudience({ authorize: () => ({ id: 'peer-grant', revision: 1 }), attach: () => () => {} } as unknown as ConnectionAdmission, 'owner-token', async () => true, () => 'example-space');
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => { await audience.authorize('peer-token', request, reply); });
  registerHtmlPreviewRoutes(app, { accessor: { get: () => ({ realpath: () => { throw new Error('must not open peer host root'); } }) } } as unknown as Scope, {} as RemoteConnectionManager);
  cleanups.push(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root: '/example', path: '/example/index.html' } });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: 40301, msg: 'html_preview_target_owner_grant_required' });
});


it('uses a unique document origin with no API surface, rejects its API origin and closes its listener', async () => {
  const { app, root, data } = await fixture();
  const url = new URL(data.url);
  expect(url.hostname).toMatch(/^[a-f0-9]{32}\.kiki-document\.localhost$/u);
  const host = url.host; url.hostname = '127.0.0.1';
  const { get } = await import('node:http');
  const request = (url: URL, host: string) => new Promise<{ status: number | undefined; csp: string | undefined; body: string }>((resolve, reject) => {
    get(url, { headers: { host } }, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, csp: response.headers['content-security-policy'], body }));
      response.on('error', reject);
    }).on('error', reject);
  });
  const response = await request(url, host);
  expect(response.status).toBe(200);
  expect(response.csp).toContain('allow-same-origin');
  expect(response.body).toBe(await readFile(join(root, 'slides/index.html'), 'utf8'));
  expect((await request(new URL('/api/private', url), host)).status).toBe(404);
  expect((await request(url, url.host)).status).toBe(403);
  const other = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root, path: join(root, 'slides/index.html') } });
  const second = other.json().data as { url: string; preview_id: string };
  expect(new URL(second.url).origin).not.toBe(new URL(data.url).origin);
  expect((await request(new URL(new URL(second.url).pathname, url), host)).status).toBe(404);
  expect(isOriginAllowed(new URL(data.url).origin, '127.0.0.1:1234', [new URL(data.url).origin])).toBe(false);
  const api = await app.inject({ url: '/api/private', headers: { origin: new URL(data.url).origin } });
  expect(api.statusCode).toBe(403);
  expect(api.headers['access-control-allow-origin']).toBeUndefined();
  await app.inject({ method: 'DELETE', url: '/api/fs:html-preview/' + data.preview_id });
  await expect(fetch(url, { headers: { host } })).rejects.toThrow();
  const nonLocal = await app.inject({ method: 'POST', url: '/api/fs:html-preview', remoteAddress: '192.0.2.10', payload: { root, path: join(root, 'slides/index.html') } });
  expect(nonLocal.statusCode).toBe(403);
  expect(nonLocal.json().msg).toBe('html_preview_document_origin_requires_local_connection');
});
