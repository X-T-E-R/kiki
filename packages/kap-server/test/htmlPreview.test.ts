import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import {
  IAppendLogStore,
  IAtomicDocumentStore,
  IBootstrapService,
  IFileSystemStorageService,
  IHostFileSystem,
  ISessionIndex,
  IWorkspaceService,
  type Scope,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { IBlobStore } from '@kiki/agent-core-v2/persistence/interface/blobStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerHtmlPreviewRoutes, HTML_PREVIEW_OPAQUE_CSP } from '../src/routes/htmlPreview';
import { RemoteConnectionManager } from '../src/services/connections/manager';
import { createOriginHook, isOriginAllowed } from '../src/middleware/origin';
import { createSecurityHeadersHook } from '../src/middleware/securityHeaders';
import { ConnectionAudience } from '../src/services/connections/audience';
import type { ConnectionAdmission } from '../src/services/connections/admission';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });
async function fixture(options: { registered?: boolean; automatic?: boolean; privateHome?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'html-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'slides'));
  await mkdir(join(root, 'systems'));
  if (options.privateHome) await mkdir(join(root, 'kiki-home'));
  await writeFile(join(root, 'slides/index.html'), '<!doctype html><script src="../app.js"></script><iframe src="../systems/index.html?shot=2#slide"></iframe>');
  await writeFile(join(root, 'app.js'), 'window.loaded=true');
  await writeFile(join(root, 'systems/index.html'), '<h1>nested</h1>');
  await writeFile(join(root, 'font.woff2'), new Uint8Array([1, 2, 3, 4]));
  const hostFs = { realpath, readText: (path: string) => readFile(path, 'utf8'), stat: async (path: string) => { const s = await stat(path); return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } };
  const core = { accessor: { get: () => hostFs } } as unknown as Scope;
  const app = Fastify();
  app.addHook('onRequest', createOriginHook({}));
  app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  app.get('/api/private', async () => ({ secret: true }));
  registerHtmlPreviewRoutes(app, core, {} as RemoteConnectionManager, {
    allowAutomaticRoot: options.automatic,
    registeredRoots: options.registered ? async () => [root] : undefined,
    privateHomes: options.privateHome ? [join(root, 'kiki-home')] : undefined,
  });
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
    expect(font.headers['access-control-allow-origin']).toBeUndefined();
    expect(document.headers['content-security-policy']).toContain("connect-src 'self' data: blob:");
    expect(document.headers['content-security-policy']).toContain("img-src 'self' data: blob:");
    expect(document.headers['content-security-policy']).toContain("form-action 'none'");
    expect(document.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(data.sandbox).toBe('allow-scripts allow-same-origin');
    const privateResponse = await app.inject({ url: '/api/private', headers: { origin: 'null' } });
    expect(privateResponse.statusCode).toBe(403);
    expect(privateResponse.headers['access-control-allow-origin']).toBeUndefined();
    const normal = await app.inject('/api/private');
    expect(normal.headers['content-security-policy']).toContain("default-src 'self'");
  });
  it('uses the automatic workspace root only for a contained document', async () => {
    const { app, root } = await fixture();
    const response = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path: join(root, 'slides/index.html'), workspace_root: root } });
    expect(response.statusCode).toBe(200);
    const { url } = response.json().data as { url: string };
    expect((await app.inject(new URL('../app.js', url).pathname)).body).toBe('window.loaded=true');
  });

  it('uses the actual workspace root when the workspace path is a link', async () => {
    const { app, root } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'html-linked-workspace-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const alias = join(outside, 'workspace');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path: join(alias, 'slides/index.html'), workspace_root: alias } });
    expect(response.statusCode, response.body).toBe(200);
    const { url } = response.json().data as { url: string };
    expect((await app.inject(new URL('../app.js', url).pathname)).body).toBe('window.loaded=true');
  });

  it.each(['git', 'assay', 'registered'])('finds a nearby %s project root without scanning document dependencies', async (marker) => {
    const { app, root } = await fixture({ registered: marker === 'registered' });
    if (marker === 'git') await mkdir(join(root, '.git'));
    if (marker === 'assay') {
      await mkdir(join(root, '.assay'));
      await writeFile(join(root, '.assay/manifest.json'), '{"__schema":4}');
    }
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path: join(root, 'slides/index.html') } });
    expect(opened.statusCode, opened.body).toBe(200);
    const { url } = opened.json().data as { url: string };
    expect((await app.inject(new URL('../app.js', url).pathname)).body).toBe('window.loaded=true');
    expect((await app.inject(new URL('../systems/index.html?slide=3', url).pathname)).body).toBe('<h1>nested</h1>');
    expect((await app.inject(new URL('../../other-project/private.js', url).pathname)).statusCode).toBe(404);
  });

  it('does not include Kiki credentials in an inferred project resource tree', async () => {
    const { app, root } = await fixture({ registered: true, privateHome: true });
    const home = join(root, 'kiki-home');
    await writeFile(join(home, 'server.local-owner'), 'fixture owner credential');
    await symlink(home, join(root, 'linked-home'), process.platform === 'win32' ? 'junction' : 'dir');
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path: join(root, 'slides/index.html') } });
    expect(opened.statusCode, opened.body).toBe(200);
    const { url } = opened.json().data as { url: string };
    expect((await app.inject(new URL('../app.js', url).pathname)).statusCode).toBe(200);
    for (const resource of ['../kiki-home/server.local-owner', '../linked-home/server.local-owner']) {
      expect((await app.inject(new URL(resource, url).pathname)).statusCode).toBe(403);
    }
  });

  it('blocks protected files and Git control paths through lexical and symlink paths', async () => {
    const { app, root, data } = await fixture();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'secrets'));
    await writeFile(join(root, '.git/config'), 'fixture git config');
    await writeFile(join(root, '.git/index.html'), '<h1>private</h1>');
    await writeFile(join(root, '.env'), 'FIXTURE_TOKEN=private');
    await writeFile(join(root, '.env.example'), 'FIXTURE_TOKEN=');
    await writeFile(join(root, 'secrets/id_ed25519'), 'fixture key');
    await symlink(join(root, '.git'), join(root, 'git-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(root, 'secrets'), join(root, 'key-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['.git', '.GIT/config', '.git/config', 'git-alias/config', '.env', 'secrets/id_ed25519', 'key-alias/id_ed25519']) {
      const response = await app.inject(`/api/html-preview/${data.preview_id}/resource?path=${encodeURIComponent(path)}`);
      expect(response.statusCode, path).toBe(403);
    }
    expect((await app.inject(`/api/html-preview/${data.preview_id}/resource?path=.env.example`)).statusCode).toBe(200);
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root, path: join(root, 'git-alias/index.html') } });
    expect(opened.statusCode).toBe(403);
    await rm(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git'), 'gitdir: ../fixture-control');
    expect((await app.inject(`/api/html-preview/${data.preview_id}/resource?path=.git`)).statusCode).toBe(403);
  });

  it('excludes a linked worktree’s common Git directory from an enclosing explicit root', async () => {
    const { app, root } = await fixture();
    const common = join(root, 'control');
    const control = join(common, 'worktrees', 'slides');
    await mkdir(control, { recursive: true });
    await mkdir(join(common, 'refs'));
    await writeFile(join(root, 'slides/.git'), 'gitdir: ../control/worktrees/slides');
    await writeFile(join(control, 'commondir'), '../..\n');
    await writeFile(join(control, 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(common, 'config'), '[core]\n');
    await writeFile(join(common, 'refs/main'), 'fixture-ref');
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { root, path: join(root, 'slides/index.html') } });
    expect(opened.statusCode, opened.body).toBe(200);
    const { preview_id } = opened.json().data;
    for (const path of ['slides/.git', 'control/worktrees/slides/HEAD', 'control/config', 'control/refs/main']) {
      expect((await app.inject(`/html-preview/${preview_id}/${path}`)).statusCode, path).toBe(403);
    }
    expect((await app.inject(`/html-preview/${preview_id}/app.js`)).statusCode).toBe(200);
  });

  it.each(['', 'credentials'])('grants only the selected HTML inside a private home subdirectory %s', async (subdirectory) => {
    const { app, root } = await fixture({ registered: true, privateHome: true });
    const home = join(root, 'kiki-home');
    const directory = join(home, subdirectory);
    await mkdir(directory, { recursive: true });
    const html = '<!doctype html><script>fetch("./credentials.toml")</script>';
    const path = join(directory, 'sample.html');
    await writeFile(path, html);
    await writeFile(join(directory, 'credentials.toml'), 'token = "fixture-private-credential"');
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path, workspace_root: root } });
    expect(opened.statusCode, opened.body).toBe(200);
    const { url } = opened.json().data as { url: string };
    expect((await app.inject(url)).body).toBe(html);
    expect((await app.inject(new URL('./credentials.toml', url).pathname)).statusCode).toBe(403);
    const explicit = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path, root: directory } });
    expect(explicit.statusCode, explicit.body).toBe(200);
    expect((await app.inject(explicit.json().data.url)).body).toBe(html);
    expect((await app.inject(new URL('./credentials.toml', explicit.json().data.url).pathname)).statusCode).toBe(403);
    const ancestor = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path, root } });
    expect(ancestor.statusCode, ancestor.body).toBe(200);
    expect((await app.inject(new URL('./credentials.toml', ancestor.json().data.url).pathname)).statusCode).toBe(403);
  });

  it('keeps the explicit root contract on SSH-managed servers', async () => {
    const { app, root } = await fixture({ automatic: false });
    const path = join(root, 'slides/index.html');
    expect((await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path, workspace_root: root } })).statusCode).toBe(200);
    const outside = await fixture();
    expect((await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path: join(outside.root, 'slides/index.html'), workspace_root: root } })).statusCode).toBe(403);
  });

  it('opens an outside HTML file with its own directory, without admitting unrelated files', async () => {
    const { app, root } = await fixture();
    const parent = await mkdtemp(join(tmpdir(), 'html-preview-downloads-'));
    cleanups.push(() => rm(parent, { recursive: true, force: true }));
    const actual = join(parent, '网页 资源');
    const alias = join(parent, 'linked');
    await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const html = '<!doctype html><script src="./本地 脚本.js"></script>';
    await writeFile(join(actual, '报告 预览.html'), html);
    await writeFile(join(actual, '本地 脚本.js'), 'window.previewLoaded=true');
    await writeFile(join(parent, 'private.js'), 'secret');
    await symlink(root, join(actual, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', payload: { path: join(alias, '报告 预览.html'), workspace_root: root } });
    expect(opened.statusCode, opened.body).toBe(200);
    const { url } = opened.json().data as { url: string };
    expect((await app.inject(url)).body).toBe(html);
    expect((await app.inject(new URL('./本地 脚本.js', url).pathname)).body).toBe('window.previewLoaded=true');
    expect((await app.inject(new URL('./missing.js', url).pathname)).json()).toMatchObject({ msg: 'preview_resource_not_found' });
    expect((await app.inject(new URL('../private.js', url).pathname)).statusCode).toBe(404);
    expect((await app.inject(new URL('./escape/app.js', url).pathname)).statusCode).toBe(403);
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
  const audience = new ConnectionAudience({ matchBearer: () => ({ id: 'peer-grant', revision: 1 }), authorize: () => ({ id: 'peer-grant', revision: 1 }), attach: () => () => {} } as unknown as ConnectionAdmission, 'owner-token', async () => true, () => 'example-space');
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
      response.on('end', () => resolve({ status: response.statusCode, csp: Array.isArray(response.headers['content-security-policy']) ? response.headers['content-security-policy'].join('; ') : response.headers['content-security-policy'], body }));
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

async function remotePreviewAdmissionFixture() {
  const home = await mkdtemp(join(tmpdir(), 'html-preview-admission-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const identity = { homeId: randomUUID(), hostId: randomUUID(), protocol: 1 as const };
  const target = { homeId: randomUUID(), hostId: randomUUID(), protocol: 1 as const };
  let response = () => Response.json({ code: 40301, msg: 'html_preview_target_owner_grant_required', data: null }, { status: 403 });
  let handshakeStatus = 200; let handshakeReason = 'invalid_owner_credential'; let requiredGrant = 'fixture-grant';
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/handshake')) return handshakeStatus === 200
      ? Response.json({ code: 0, data: { identity: target, serverId: 'fixture', inboundEnabled: true } })
      : Response.json({ code: 40301, msg: handshakeReason, data: null }, { status: handshakeStatus });
    if (url.pathname.endsWith('/claim')) return Response.json({ code: 0, data: { grantId: randomUUID(), revision: 1, grant: 'fixture-grant', target } });
    if (new Headers(init?.headers).get('x-kiki-connection-grant') !== requiredGrant) return Response.json({ code: 40101, msg: 'connection_not_approved', data: null }, { status: 401 });
    if (url.pathname === '/api/meta') return Response.json({ code: 0, data: { readable: true } });
    return response();
  });
  vi.stubGlobal('fetch', transport);
  cleanups.push(async () => { vi.unstubAllGlobals(); });
  const manager = new RemoteConnectionManager(home, identity);
  await manager.ready();
  const record = await manager.add({ label: 'HTML preview fixture', endpoint: 'https://remote.example.test', target, ownerToken: 'fixture-owner', invitation: 'fixture-invitation', backgroundSummary: false });
  cleanups.push(() => manager.close());
  return {
    manager, record, transport, setResponse: (value: () => Response) => { response = value; },
    failHandshake: (reason = 'invalid_owner_credential') => { handshakeStatus = 403; handshakeReason = reason; },
    restoreHandshake: () => { handshakeStatus = 200; },
    replaceRequiredGrant: () => { requiredGrant = 'replacement-grant'; },
  };
}

describe('remote HTML refusals through the real connection manager', () => {
  it.each([
    ['htmlPreviewOpen', 'html_preview_target_owner_grant_required'],
    ['htmlPreviewOpen', 'html_preview_document_origin_requires_local_connection'],
    ['htmlPreviewResource', 'preview_path_outside_root'],
    ['htmlPreviewResource', 'preview_resource_forbidden'],
    ['htmlPreviewClose', 'preview_resource_forbidden'],
  ] as const)('preserves %s refusal %s and the GUI lease for the next ordinary call', async (operation, msg) => {
    const f = await remotePreviewAdmissionFixture();
    const body = ` {"code":40301,"msg":"${msg}","data":null,"request_id":"remote-request"}\n`;
    f.setResponse(() => new Response(body, { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-preview-fixture': 'unchanged' } }));
    const lease = f.manager.lease(f.record.id);
    try {
      const response = await f.manager.forward(f.record.id, { operation, params: { previewId: 'fixture' }, query: operation === 'htmlPreviewResource' ? { path: 'forbidden.js' } : undefined }, lease.signal);
      expect(response.status).toBe(403); expect(response.statusText).toBe('Forbidden');
      expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
      expect(response.headers.get('x-preview-fixture')).toBe('unchanged');
      expect(await response.text()).toBe(body);
      expect(f.manager.get(f.record.id).state).toBe('online');
      expect(lease.signal.aborted).toBe(false);
      expect(f.manager.list()[0]?.activeLeases).toBe(1);
      const next = await f.manager.forward(f.record.id, { operation: 'meta' }, lease.signal);
      expect(await next.json()).toEqual({ code: 0, data: { readable: true } });
    } finally { lease.release(); }
  });

  it('returns a remote open refusal without reading a same-named local HTML file', async () => {
    const f = await remotePreviewAdmissionFixture();
    const localRead = vi.fn(() => { throw new Error('remote refusal must not use local files'); });
    const broker = Fastify();
    registerHtmlPreviewRoutes(broker, { accessor: { get: () => ({ realpath: localRead }) } } as unknown as Scope, f.manager);
    cleanups.push(() => broker.close());
    const lease = f.manager.lease(f.record.id);
    try {
      const response = await broker.inject({ method: 'POST', url: `/api/remote-connections/${f.record.id}/html-preview`, payload: { root: tmpdir(), path: join(tmpdir(), 'index.html') } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 40301, msg: 'html_preview_target_owner_grant_required' });
      expect(localRead).not.toHaveBeenCalled();
      expect(lease.signal.aborted).toBe(false);
      expect(f.manager.get(f.record.id).state).toBe('online');
      expect(await (await f.manager.forward(f.record.id, { operation: 'meta' }, lease.signal)).json()).toMatchObject({ code: 0 });
    } finally { lease.release(); }
  });

  it.each([
    [401, 40301, 'html_preview_target_owner_grant_required'],
    [403, 40301, 'connection_not_approved'],
    [403, 40301, 'unrecognized_preview_denial'],
    [403, 40101, 'html_preview_target_owner_grant_required'],
  ] as const)('still pauses GUI for HTTP %s with code %s and message %s', async (status, code, msg) => {
    const f = await remotePreviewAdmissionFixture();
    f.setResponse(() => Response.json({ code, msg, data: null }, { status }));
    const lease = f.manager.lease(f.record.id);
    await expect(f.manager.forward(f.record.id, { operation: 'htmlPreviewOpen' }, lease.signal)).rejects.toMatchObject({ status, reason: 'connection_not_approved' });
    expect(f.manager.get(f.record.id).state).toBe('authentication_required');
    expect(lease.signal.aborted).toBe(true); lease.release();
  });

  it('does not exempt a preview-shaped refusal on another operation or during handshake', async () => {
    const f = await remotePreviewAdmissionFixture();
    const lease = f.manager.lease(f.record.id);
    await expect(f.manager.forward(f.record.id, { operation: 'sessionCreate', body: {} }, lease.signal)).rejects.toMatchObject({ status: 403, reason: 'connection_not_approved' });
    expect(lease.signal.aborted).toBe(true);
    expect(f.manager.get(f.record.id).state).toBe('authentication_required'); lease.release();
    const g = await remotePreviewAdmissionFixture(); g.failHandshake();
    const handshakeLease = g.manager.lease(g.record.id);
    await expect(g.manager.forward(g.record.id, { operation: 'htmlPreviewOpen' }, handshakeLease.signal)).rejects.toMatchObject({ status: 403 });
    expect(g.manager.get(g.record.id).state).toBe('authentication_required');
    expect(handshakeLease.signal.aborted).toBe(true); handshakeLease.release();
  });

  it('recovers after inbound is restored while keeping the closed service response an error', async () => {
    const f = await remotePreviewAdmissionFixture(); f.failHandshake('inbound_disabled');
    const lease = f.manager.lease(f.record.id);
    try {
      await expect(f.manager.forward(f.record.id, { operation: 'meta' }, lease.signal)).rejects.toMatchObject({ status: 403, reason: 'inbound_disabled' });
      expect(f.manager.get(f.record.id).state).toBe('offline');
      f.restoreHandshake();
      expect(await (await f.manager.forward(f.record.id, { operation: 'meta' }, lease.signal)).json()).toMatchObject({ code: 0 });
      expect(f.manager.get(f.record.id).state).toBe('online');
    } finally { lease.release(); }
  });

  it('rejects a revoked grant again and recovers only after the stored grant is replaced', async () => {
    const f = await remotePreviewAdmissionFixture(); f.replaceRequiredGrant();
    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = f.manager.lease(f.record.id);
      await expect(f.manager.forward(f.record.id, { operation: 'meta' }, lease.signal)).rejects.toMatchObject({ status: 401, reason: 'connection_not_approved' });
      expect(f.manager.get(f.record.id).state).toBe('authentication_required');
      expect(lease.signal.aborted).toBe(true); lease.release();
    }
    const credential = await f.manager.secrets.read<{ ownerToken: string; grant: string; grantId: string; revision: number }>({ connectionId: f.record.credentialRef, purpose: 'gui' });
    await f.manager.secrets.write({ connectionId: f.record.credentialRef, purpose: 'gui' }, { ...credential, grant: 'replacement-grant' });
    const lease = f.manager.lease(f.record.id);
    try {
      expect(await (await f.manager.forward(f.record.id, { operation: 'meta' }, lease.signal)).json()).toMatchObject({ code: 0 });
      expect(f.manager.get(f.record.id).state).toBe('online'); expect(lease.signal.aborted).toBe(false);
    } finally { lease.release(); }
  });

  it('cancels a stalled denial read without awaiting upstream cancellation', async () => {
    const f = await remotePreviewAdmissionFixture(); let cancelled = false;
    let started!: () => void; const reading = new Promise<void>((resolve) => { started = resolve; });
    f.setResponse(() => new Response(new ReadableStream<Uint8Array>({
      pull() { started(); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const controller = new AbortController(); const lease = f.manager.lease(f.record.id, controller.signal);
    const pending = f.manager.forward(f.record.id, { operation: 'htmlPreviewOpen' }, lease.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    await reading; controller.abort(); await rejected;
    expect(cancelled).toBe(true); lease.release();
  });

  it('bounds denial inspection without waiting for a stalled stream cancellation', async () => {
    const f = await remotePreviewAdmissionFixture(); let pulls = 0; let cancelled = false;
    f.setResponse(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(8193)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const lease = f.manager.lease(f.record.id);
    await expect(f.manager.forward(f.record.id, { operation: 'htmlPreviewResource', params: { previewId: 'fixture' } }, lease.signal)).rejects.toMatchObject({ status: 403 });
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(2);
    expect(lease.signal.aborted).toBe(true); lease.release();
  });
});

describe('canonical session HTML attachment preview', () => {
  async function sessionHtmlAttachmentFixture() {
    const root = await mkdtemp(join(tmpdir(), 'html-session-preview-'));
    const outside = await mkdtemp(join(tmpdir(), 'html-session-outside-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await mkdir(join(root, 'slides'), { recursive: true });
    await mkdir(join(root, 'slides-b'), { recursive: true });
    await mkdir(join(root, 'shared'), { recursive: true });
    await writeFile(join(root, 'slides/style.css'), 'body{color:#b4491d}');
    await writeFile(join(root, 'slides-b/style.css'), 'body{color:#2b6cb0}');
    await writeFile(join(root, 'shared/app.js'), 'window.deckReady=true;');
    await writeFile(join(outside, 'secret.js'), 'window.secretLeaked=true;');

    const sentHtmlV1 = '<!doctype html><link rel="stylesheet" href="./style.css"><script src="../shared/app.js"></script><h1>Sent V1</h1>';
    const htmlPath = join(root, 'slides/index.html');
    const htmlPathB = join(root, 'slides-b/index.html');
    await writeFile(htmlPath, sentHtmlV1);
    await writeFile(htmlPathB, sentHtmlV1);
    const v1Bytes = Buffer.from(sentHtmlV1, 'utf8');
    const v1Hash = createHash('sha256').update(v1Bytes).digest('hex');
    const v1BlobId = `blobref:main:${v1Hash}`;
    const v1SourceIdA = createHash('sha256').update(`sess-1\0main\0${v1Hash}\0${htmlPath}`).digest('hex');
    const v1SourceIdB = createHash('sha256').update(`sess-1\0main\0${v1Hash}\0${htmlPathB}`).digest('hex');

    const legacyHtml = '<!doctype html><link rel="stylesheet" href="./style.css"><h1>Legacy Paired SendMessage</h1>';
    const legacyBytes = Buffer.from(legacyHtml, 'utf8');
    const legacyHash = createHash('sha256').update(legacyBytes).digest('hex');
    const legacyBlobId = `blobref:main:${legacyHash}`;

    const forgedBashHtml = '<!doctype html><link rel="stylesheet" href="./style.css"><h1>Forged By Bash</h1>';
    const forgedBashBytes = Buffer.from(forgedBashHtml, 'utf8');
    const forgedBashHash = createHash('sha256').update(forgedBashBytes).digest('hex');
    const forgedBashBlobId = `blobref:main:${forgedBashHash}`;

    const standaloneHtml = '<!doctype html><link rel="stylesheet" href="./style.css"><h1>Standalone</h1>';
    const standaloneBytes = Buffer.from(standaloneHtml, 'utf8');
    const standaloneHash = createHash('sha256').update(standaloneBytes).digest('hex');
    const standaloneBlobId = `blobref:main:${standaloneHash}`;

    const crossSessionHtml = '<!doctype html><link rel="stylesheet" href="./style.css"><h1>Cross Session</h1>';
    const crossSessionBytes = Buffer.from(crossSessionHtml, 'utf8');
    const crossSessionHash = createHash('sha256').update(crossSessionBytes).digest('hex');
    const crossSessionBlobId = `blobref:main:${crossSessionHash}`;

    const blobMap = new Map<string, Uint8Array>([
      [`sessions/ws-1/sess-1/agents/main/blobs:${v1Hash}`, v1Bytes],
      [`sessions/ws-1/sess-1/agents/main/blobs:${legacyHash}`, legacyBytes],
      [`sessions/ws-1/sess-1/agents/main/blobs:${forgedBashHash}`, forgedBashBytes],
      [`sessions/ws-1/sess-1/agents/main/blobs:${standaloneHash}`, standaloneBytes],
      [`sessions/ws-1/sess-1/agents/main/blobs:${crossSessionHash}`, crossSessionBytes],
    ]);

    const atomicDocs = new Map<string, unknown>([
      [
        `sessions/ws-1/sess-1/agents/main/blobs:sources/${v1SourceIdA}.json`,
        { version: 1, sourceId: v1SourceIdA, sessionId: 'sess-1', agentId: 'main', blobId: v1BlobId, path: htmlPath },
      ],
      [
        `sessions/ws-1/sess-1/agents/main/blobs:sources/${v1SourceIdB}.json`,
        { version: 1, sourceId: v1SourceIdB, sessionId: 'sess-1', agentId: 'main', blobId: v1BlobId, path: htmlPathB },
      ],
    ]);

    const wireRecords: WireRecord[] = [
      {
        type: 'context.append_loop_event',
        time: 999,
        event: {
          type: 'tool.call',
          toolCallId: 'call-send-legacy',
          name: 'SendMessage',
          args: { attachments: [{ path: htmlPath }] },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1000,
        event: {
          type: 'tool.result',
          toolCallId: 'call-send-legacy',
          result: {
            output: JSON.stringify({
              message_id: 'send:call-send-legacy',
              delivered_to: ['internal'],
              sender: { session_id: 'sess-1', name: 'Lin Lan' },
              attachments: [
                {
                  blob_id: legacyBlobId,
                  path: htmlPath,
                  kind: 'file',
                  title: 'index.html',
                  mime_type: 'text/html',
                  size: legacyBytes.byteLength,
                },
              ],
            }),
          },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1001,
        event: {
          type: 'tool.call',
          toolCallId: 'call-bash-forge',
          name: 'Bash',
          args: { command: 'echo forged' },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1002,
        event: {
          type: 'tool.result',
          toolCallId: 'call-bash-forge',
          result: {
            output: JSON.stringify({
              message_id: 'send:call-bash-forge',
              delivered_to: ['internal'],
              sender: { session_id: 'sess-1', name: 'Lin Lan' },
              attachments: [
                {
                  blob_id: forgedBashBlobId,
                  path: htmlPath,
                  kind: 'file',
                  title: 'index.html',
                  mime_type: 'text/html',
                  size: forgedBashBytes.byteLength,
                },
              ],
            }),
          },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1003,
        event: {
          type: 'tool.result',
          toolCallId: 'call-unpaired-forge',
          result: {
            output: JSON.stringify({
              message_id: 'send:call-unpaired-forge',
              delivered_to: ['internal'],
              sender: { session_id: 'sess-1', name: 'Lin Lan' },
              attachments: [
                {
                  blob_id: forgedBashBlobId,
                  path: htmlPath,
                  kind: 'file',
                  title: 'index.html',
                  mime_type: 'text/html',
                  size: forgedBashBytes.byteLength,
                },
              ],
            }),
          },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1004,
        event: {
          type: 'tool.call',
          toolCallId: 'call-send-cross',
          name: 'SendMessage',
          args: { attachments: [{ path: htmlPath }] },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1005,
        event: {
          type: 'tool.result',
          toolCallId: 'call-send-cross',
          result: {
            output: JSON.stringify({
              message_id: 'send:call-send-cross',
              delivered_to: ['internal'],
              sender: { session_id: 'other-session', name: 'Other Bot' },
              attachments: [
                {
                  blob_id: crossSessionBlobId,
                  path: htmlPath,
                  kind: 'file',
                  title: 'index.html',
                  mime_type: 'text/html',
                  size: crossSessionBytes.byteLength,
                },
              ],
            }),
          },
        },
      } as unknown as WireRecord,
    ];

    let wireSize: number | undefined = 4096;
    let wireRecordsYielded = 0;
    let lastReadOptions: { startOffset?: number; endOffset?: number; signal?: AbortSignal } | undefined;

    const hostFs = {
      realpath,
      stat: async (path: string) => {
        const s = await stat(path);
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
      },
    };
    const sessionIndex = {
      get: async (id: string) =>
        id === 'sess-1'
          ? { id: 'sess-1', workspaceId: 'ws-1', cwd: root, createdAt: 1, updatedAt: 1, archived: false }
          : undefined,
    };
    const bootstrap = {
      scope: (name: string) => name,
    };
    const blobStore = {
      size: async (scope: string, key: string) => blobMap.get(`${scope}:${key}`)?.byteLength,
      get: async (scope: string, key: string) => blobMap.get(`${scope}:${key}`),
      getStream: async function* (scope: string, key: string, range?: { start: number; end: number }) {
        const data = blobMap.get(`${scope}:${key}`);
        if (data === undefined) return;
        yield range === undefined ? data : data.subarray(range.start, range.end + 1);
      },
    };
    const atomicDocumentStore = {
      get: async (scope: string, key: string) => atomicDocs.get(`${scope}:${key}`),
      set: async (scope: string, key: string, value: unknown) => {
        atomicDocs.set(`${scope}:${key}`, value);
      },
    };
    const storageService = {
      size: async (scope: string, key: string) =>
        scope === 'sessions/ws-1/sess-1/agents/main' && key === 'wire.jsonl' ? wireSize : undefined,
    };
    const appendLogStore = {
      read: async function* (
        scope: string,
        key: string,
        options?: { startOffset?: number; endOffset?: number; signal?: AbortSignal; onRecordBytes?: (bytes: number) => void },
      ) {
        lastReadOptions = options;
        if (scope === 'sessions/ws-1/sess-1/agents/main' && key === 'wire.jsonl') {
          for (const rec of wireRecords) {
            options?.signal?.throwIfAborted();
            options?.onRecordBytes?.(256);
            wireRecordsYielded += 1;
            yield rec;
          }
        }
      },
    };
    const workspaceService = {
      get: async (id: string) => (id === 'ws-1' ? { id: 'ws-1', root } : undefined),
    };

    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IHostFileSystem) return hostFs;
          if (token === ISessionIndex) return sessionIndex;
          if (token === IBootstrapService) return bootstrap;
          if (token === IBlobStore) return blobStore;
          if (token === IAtomicDocumentStore) return atomicDocumentStore;
          if (token === IFileSystemStorageService) return storageService;
          if (token === IAppendLogStore) return appendLogStore;
          if (token === IWorkspaceService) return workspaceService;
          throw new Error(`Unexpected token: ${String(token)}`);
        },
      },
    } as unknown as Scope;

    const app = Fastify();
    app.addHook('onRequest', createOriginHook({}));
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
    registerHtmlPreviewRoutes(app, core, {} as RemoteConnectionManager, {
      registeredRoots: async () => [root],
    });
    cleanups.push(() => app.close());

    return {
      app,
      root,
      outside,
      htmlPath,
      htmlPathB,
      sentHtmlV1,
      v1BlobId,
      v1SourceIdA,
      v1SourceIdB,
      legacyHtml,
      legacyBlobId,
      forgedBashHtml,
      forgedBashBlobId,
      standaloneHtml,
      standaloneBlobId,
      crossSessionHtml,
      crossSessionBlobId,
      wireRecords,
      setWireSize: (next: number | undefined) => {
        wireSize = next;
      },
      getWireRecordsYielded: () => wireRecordsYielded,
      resetWireMetrics: () => {
        wireRecordsYielded = 0;
        lastReadOptions = undefined;
      },
      getLastReadOptions: () => lastReadOptions,
    };
  }

  it('serves the sent canonical blob after the host entry HTML is modified, using the persisted SendMessage attachment source without scanning wire', async () => {
    const f = await sessionHtmlAttachmentFixture();
    await writeFile(f.htmlPath, '<!doctype html><h1>Modified On Host V2</h1>');
    f.resetWireMetrics();

    const opened = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.v1BlobId,
        source_id: f.v1SourceIdA,
        name: 'index.html',
      },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(f.getWireRecordsYielded()).toBe(0);
    const { url } = opened.json().data as { url: string };

    const entryResponse = await f.app.inject(url);
    expect(entryResponse.statusCode).toBe(200);
    expect(entryResponse.body).toBe(f.sentHtmlV1);
    expect(entryResponse.body).not.toContain('Modified On Host V2');

    const cssResponse = await f.app.inject(new URL('./style.css', url).pathname);
    expect(cssResponse.statusCode).toBe(200);
    expect(cssResponse.body).toBe('body{color:#b4491d}');

    const jsResponse = await f.app.inject(new URL('../shared/app.js', url).pathname);
    expect(jsResponse.statusCode).toBe(200);
    expect(jsResponse.body).toBe('window.deckReady=true;');

    const outsideResponse = await f.app.inject(new URL('../../secret.js', url).pathname);
    expect(outsideResponse.statusCode).toBe(404);
  });

  it('keeps identical HTML blobs sent from different directories isolated by source_id and rejects mismatched or forged source_id / path overrides', async () => {
    const f = await sessionHtmlAttachmentFixture();
    f.resetWireMetrics();

    const openA = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.v1BlobId,
        source_id: f.v1SourceIdA,
        name: 'index.html',
      },
    });
    expect(openA.statusCode, openA.body).toBe(200);
    const urlA = (openA.json().data as { url: string }).url;
    expect((await f.app.inject(urlA)).body).toBe(f.sentHtmlV1);
    expect((await f.app.inject(new URL('./style.css', urlA).pathname)).body).toBe('body{color:#b4491d}');

    const openB = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.v1BlobId,
        source_id: f.v1SourceIdB,
        name: 'index.html',
      },
    });
    expect(openB.statusCode, openB.body).toBe(200);
    const urlB = (openB.json().data as { url: string }).url;
    expect((await f.app.inject(urlB)).body).toBe(f.sentHtmlV1);
    expect((await f.app.inject(new URL('./style.css', urlB).pathname)).body).toBe('body{color:#2b6cb0}');

    const reopenA = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.v1BlobId,
        source_id: f.v1SourceIdA,
        path: f.htmlPathB,
        root: join(f.root, 'slides-b'),
        name: 'index.html',
      },
    });
    expect(reopenA.statusCode, reopenA.body).toBe(200);
    const urlReopenA = (reopenA.json().data as { url: string }).url;
    expect((await f.app.inject(new URL('./style.css', urlReopenA).pathname)).body).toBe('body{color:#b4491d}');

    const mismatchedBlob = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.standaloneBlobId,
        source_id: f.v1SourceIdB,
        path: f.htmlPathB,
        name: 'index.html',
      },
    });
    expect(mismatchedBlob.statusCode, mismatchedBlob.body).toBe(200);
    const urlMismatched = (mismatchedBlob.json().data as { url: string }).url;
    expect((await f.app.inject(urlMismatched)).body).toBe(f.standaloneHtml);
    expect((await f.app.inject(new URL('./style.css', urlMismatched).pathname)).statusCode).toBe(404);
    expect(f.getWireRecordsYielded()).toBe(0);
  });

  it('opens legacy blobref attachments without source_id as single-file canonical HTML even when a recent tail receipt sent identical bytes from another directory (A older than 32 MiB tail, B recent)', async () => {
    const f = await sessionHtmlAttachmentFixture();
    f.setWireSize(32 * 1024 * 1024);
    f.wireRecords.push(
      {
        type: 'context.append_loop_event',
        time: 1010,
        event: {
          type: 'tool.call',
          toolCallId: 'call-send-recent-b',
          name: 'SendMessage',
          args: { attachments: [{ path: f.htmlPathB }] },
        },
      } as unknown as WireRecord,
      {
        type: 'context.append_loop_event',
        time: 1011,
        event: {
          type: 'tool.result',
          toolCallId: 'call-send-recent-b',
          result: {
            output: JSON.stringify({
              message_id: 'send:call-send-recent-b',
              delivered_to: ['internal'],
              sender: { session_id: 'sess-1', name: 'Lin Lan' },
              attachments: [
                {
                  blob_id: f.v1BlobId,
                  path: f.htmlPathB,
                  kind: 'file',
                  title: 'index.html',
                  mime_type: 'text/html',
                  size: Buffer.byteLength(f.sentHtmlV1),
                },
              ],
            }),
          },
        },
      } as unknown as WireRecord,
    );
    f.resetWireMetrics();

    const oldAWithoutSourceId = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.v1BlobId,
        name: 'index.html',
      },
    });
    expect(oldAWithoutSourceId.statusCode, oldAWithoutSourceId.body).toBe(200);
    expect(f.getWireRecordsYielded()).toBe(0);
    const oldAUrl = (oldAWithoutSourceId.json().data as { url: string }).url;
    expect((await f.app.inject(oldAUrl)).body).toBe(f.sentHtmlV1);
    expect((await f.app.inject(new URL('./style.css', oldAUrl).pathname)).statusCode).toBe(404);

    const legacyWithoutSourceId = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.legacyBlobId,
        name: 'index.html',
      },
    });
    expect(legacyWithoutSourceId.statusCode, legacyWithoutSourceId.body).toBe(200);
    expect(f.getWireRecordsYielded()).toBe(0);
    const legacyUrl = (legacyWithoutSourceId.json().data as { url: string }).url;
    expect((await f.app.inject(legacyUrl)).body).toBe(f.legacyHtml);
    expect((await f.app.inject(new URL('./style.css', legacyUrl).pathname)).statusCode).toBe(404);

    const bashForged = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.forgedBashBlobId,
        name: 'index.html',
      },
    });
    expect(bashForged.statusCode, bashForged.body).toBe(200);
    expect(f.getWireRecordsYielded()).toBe(0);
    const bashForgedUrl = (bashForged.json().data as { url: string }).url;
    expect((await f.app.inject(bashForgedUrl)).body).toBe(f.forgedBashHtml);
    expect((await f.app.inject(new URL('./style.css', bashForgedUrl).pathname)).statusCode).toBe(404);
  });

  it('ignores caller-supplied path/root overrides and isolates cross-session or pathless blobs as single-file entries', async () => {
    const f = await sessionHtmlAttachmentFixture();

    const forged = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.standaloneBlobId,
        name: 'index.html',
        path: join(f.outside, 'secret.js'),
        root: f.outside,
        workspace_root: f.outside,
      },
    });
    expect(forged.statusCode, forged.body).toBe(200);
    const forgedUrl = (forged.json().data as { url: string }).url;
    expect((await f.app.inject(forgedUrl)).body).toBe(f.standaloneHtml);
    expect((await f.app.inject(new URL('./style.css', forgedUrl).pathname)).statusCode).toBe(404);
    expect((await f.app.inject(new URL('./secret.js', forgedUrl).pathname)).statusCode).toBe(404);

    const cross = await f.app.inject({
      method: 'POST',
      url: '/api/fs:html-preview',
      payload: {
        session_id: 'sess-1',
        file_id: f.crossSessionBlobId,
        name: 'index.html',
      },
    });
    expect(cross.statusCode, cross.body).toBe(200);
    const crossUrl = (cross.json().data as { url: string }).url;
    expect((await f.app.inject(crossUrl)).body).toBe(f.crossSessionHtml);
    expect((await f.app.inject(new URL('./style.css', crossUrl).pathname)).statusCode).toBe(404);
  });
});
