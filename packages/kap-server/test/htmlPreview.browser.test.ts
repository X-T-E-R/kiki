import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { expect, it } from 'vitest';
import { registerHtmlPreviewRoutes } from '../src/routes/htmlPreview';
import type { RemoteConnectionManager } from '../src/services/connections/manager';
import { createOriginHook } from '../src/middleware/origin';
import { createAuthHook } from '../src/middleware/auth';
import { createSecurityHeadersHook } from '../src/middleware/securityHeaders';
import type { IAuthTokenService } from '../src/services/auth/authTokenService';

it.skipIf(process.env['KIKI_HTML_SAMPLE'] === undefined)('compares the original browser document with the real preview resource tree', async () => {
  const source = process.env['KIKI_HTML_SAMPLE']!;
  const root = process.env['KIKI_HTML_ROOT']!;
  const output = process.env['KIKI_HTML_PROOF']!;
  await mkdir(output, { recursive: true });
  const original = await readFile(source);
  const hostFs = { realpath, stat: async (path: string) => { const s = await stat(path); return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } };
  const app = Fastify();
  app.addHook('onRequest', createOriginHook({}));
  app.addHook('onRequest', createAuthHook({ isValid: async (token: string) => token === 'test-owner' } as IAuthTokenService));
  app.get('/api/private', async () => ({ secret: true }));
  app.get('/parent', async (_req, reply) => reply.type('text/html').send('<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style><script>window.__TAURI_INTERNALS__={secret:true};localStorage.setItem("test-owner","private")</script><iframe allow="fullscreen" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe>'));
  registerHtmlPreviewRoutes(app, { accessor: { get: (token: { toString(): string }) => token.toString() === 'workspaceService' ? { list: async () => [{ root }] } : hostFs } } as unknown as Scope, {} as RemoteConnectionManager);
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(join(output, 'browser-profile'), { executablePath: process.env['KIKI_HTML_BROWSER'], headless: true, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }).catch(async (error: unknown) => { await writeFile(join(output, 'launch-error.txt'), String(error)); throw error; });
  try {
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', headers: { authorization: 'Bearer test-owner' }, payload: { root, path: source } });
    expect(opened.statusCode, opened.body).toBe(200);
    const preview = opened.json().data as { url: string; preview_id: string; sandbox: string };
    const previewBytes = await app.inject(preview.url);
    expect(previewBytes.rawPayload).toEqual(original);
    const direct = await context.newPage(); const embedded = await context.newPage();
    const errors: string[] = [];
    embedded.on('pageerror', (error) => errors.push(error.message));
    await direct.goto(pathToFileURL(source).href);
    await embedded.goto(endpoint + '/parent');
    await embedded.locator('iframe').evaluate((frame, preview) => { (frame as HTMLIFrameElement).sandbox.value = preview.sandbox; (frame as HTMLIFrameElement).src = preview.url; }, preview);
    await direct.waitForFunction(() => customElements.get('deck-stage') !== undefined);
    await embedded.frameLocator('iframe').locator('deck-stage').waitFor();
    const frame = embedded.frames().find((candidate) => candidate.url().includes('/html-preview/'))!;
    await frame.waitForFunction(() => customElements.get('deck-stage') !== undefined);
    await direct.evaluate(() => document.fonts.ready); await frame.evaluate(() => document.fonts.ready);
    const snapshot = () => {
      const deck = document.querySelector('deck-stage') as HTMLElement & { index: number };
      return { slides: deck.children.length, index: deck.index, shadow: deck.shadowRoot !== null, fonts: [...document.fonts].map((font) => ({ family: font.family, status: font.status })), images: [...document.images].filter((image) => !image.closest('[data-deck-thumb]')).map((image) => ({ src: image.getAttribute('src'), width: image.naturalWidth, complete: image.complete })), viewport: { width: innerWidth, height: innerHeight }, activeBounds: document.querySelector('[data-deck-active]')?.getBoundingClientRect().toJSON() };
    };
    const directInitial = await direct.evaluate(snapshot); const previewInitial = await frame.evaluate(snapshot);
    expect(previewInitial.slides).toBe(15); expect(previewInitial.shadow).toBe(true);
    expect(previewInitial.viewport).toEqual(directInitial.viewport);
    expect(previewInitial.fonts).toEqual(directInitial.fonts);
    await direct.screenshot({ path: join(output, 'direct.png') }); await embedded.screenshot({ path: join(output, 'preview.png') });
    await direct.keyboard.press('ArrowRight'); await embedded.mouse.click(700, 450); await embedded.keyboard.press('ArrowRight');
    const keyboard = { direct: await direct.evaluate(() => (document.querySelector('deck-stage') as HTMLElement & { index: number }).index), preview: await frame.evaluate(() => (document.querySelector('deck-stage') as HTMLElement & { index: number }).index) };
    expect(keyboard.preview).toBe(keyboard.direct);
    await frame.goto(preview.url + '?shot=5#3');
    await frame.waitForFunction(() => (document.querySelector('deck-stage') as HTMLElement & { index: number })?.index === 5);
    const nested = frame.childFrames().find((child) => child.url().includes('design-html-deck-final-v6'));
    expect(nested).toBeDefined();
    await nested!.waitForFunction(() => customElements.get('deck-stage') !== undefined);
    const nestedProof = await nested!.evaluate(() => ({ url: location.href, index: (document.querySelector('deck-stage') as HTMLElement & { index: number }).index, slides: document.querySelector('deck-stage')?.children.length }));
    const isolation = await frame.evaluate(async (endpoint) => {
      let parentReadable = false; let parentBridge = false; let storage = false;
      try { parentReadable = parent.document !== undefined; } catch {}
      try { parentBridge = Reflect.get(parent, '__TAURI_INTERNALS__') !== undefined; } catch {}
      try { storage = localStorage.getItem('test-owner') !== null; } catch {}
      let api: string;
      try { api = String((await fetch(endpoint + '/api/private', { credentials: 'include' })).status); } catch { api = 'blocked'; }
      return { parentReadable, parentBridge, storage, api, ownBridge: Reflect.get(window, '__TAURI_INTERNALS__') !== undefined };
    }, endpoint);
    expect(isolation).toEqual({ parentReadable: false, parentBridge: false, storage: false, api: 'blocked', ownBridge: false });
    await app.inject({ method: 'DELETE', url: '/api/fs:html-preview/' + preview.preview_id, headers: { authorization: 'Bearer test-owner' } });
    expect((await app.inject(preview.url)).statusCode).toBe(404);
    expect(await readFile(source)).toEqual(original);
    await writeFile(join(output, 'proof.json'), JSON.stringify({ sha256: createHash('sha256').update(original).digest('hex'), directInitial, previewInitial, keyboard, nestedProof, isolation, errors }, null, 2));
  } finally { await context.close(); await app.close(); }
}, 60_000);


it.skipIf(process.env['KIKI_HTML_ORIGIN_PROOF'] === undefined)('preserves browser document origin capabilities without sharing the privileged app origin', async () => {
  const output = process.env['KIKI_HTML_ORIGIN_PROOF']!;
  const root = join(output, 'fixture'); const source = join(root, 'slides/index.html');
  await mkdir(join(root, 'slides'), { recursive: true });
  const html = '<!doctype html><title>Document origin capabilities</title><h1>Document origin capabilities</h1><script>localStorage.setItem("visits",String(Number(localStorage.getItem("visits")||0)+1));window.result=Promise.allSettled([import("../app.mjs").then(m=>m.value),fetch("../data.json").then(r=>r.json())]).then(([module,fetch])=>({module,fetch,visits:localStorage.getItem("visits")}))</script>';
  await writeFile(source, html);
  await writeFile(join(root, 'app.mjs'), 'import { value } from "./dep.js"; export { value };');
  await writeFile(join(root, 'dep.js'), 'export const value = "module-relative-ok";');
  await writeFile(join(root, 'data.json'), '{"message":"relative-fetch-ok"}');
  const hostFs = { realpath, stat: async (path: string) => { const s = await stat(path); return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } };
  const app = Fastify();
  app.addHook('onRequest', createOriginHook({}));
  app.addHook('onRequest', createAuthHook({ isValid: async (token: string) => token === 'test-owner' } as IAuthTokenService));
  app.get('/api/private', async () => ({ secret: true }));
  const appSecurity = createSecurityHeadersHook({ tls: false });
  app.addHook('onSend', async (req, reply, payload) => req.url === '/parent' ? appSecurity(req, reply, payload) : payload);
  app.get('/parent.js', async (_req, reply) => reply.type('text/javascript').send('window.__TAURI_INTERNALS__={secret:true};localStorage.setItem("owner-secret","private")'));
  app.get('/parent', async (_req, reply) => reply.type('text/html').send('<!doctype html><script src="/parent.js"></script><iframe></iframe>'));
  app.get('/baseline/*', async (req, reply) => {
    const path = (req.params as { '*': string })['*'];
    if (!['slides/index.html', 'app.mjs', 'dep.js', 'data.json'].includes(path)) return reply.code(404).send();
    return reply.type(path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : 'text/javascript').send(await readFile(join(root, path)));
  });
  registerHtmlPreviewRoutes(app, { accessor: { get: () => hostFs } } as unknown as Scope, {} as RemoteConnectionManager);
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(join(output, 'browser-profile'), { executablePath: process.env['KIKI_HTML_BROWSER'], headless: true });
  try {
    const opened = await app.inject({ method: 'POST', url: '/api/fs:html-preview', headers: { authorization: 'Bearer test-owner' }, payload: { path: source, root } });
    expect(opened.statusCode, opened.body).toBe(200);
    const preview = opened.json().data as { url: string; sandbox: string; preview_id: string };
    const file = await context.newPage(); await file.goto(pathToFileURL(source).href);
    const fileProof = await file.evaluate(async () => await Reflect.get(window, 'result'));
    expect(fileProof.visits).toBe('1');
    expect(fileProof.module.status).toBe('rejected'); expect(fileProof.fetch.status).toBe('rejected');
    const baseline = await context.newPage(); await baseline.goto(endpoint + '/baseline/slides/index.html');
    const baselineProof = await baseline.evaluate(async () => await Reflect.get(window, 'result'));
    const embedded = await context.newPage(); const parentResponse = await embedded.goto(endpoint + '/parent');
    const parentFixture = await embedded.evaluate(() => ({ bridge: Reflect.get(window, '__TAURI_INTERNALS__'), storage: localStorage.getItem('owner-secret') }));
    expect(parentFixture).toEqual({ bridge: { secret: true }, storage: 'private' });
    expect(parentResponse?.headers()['content-security-policy']).toContain("frame-src 'self' http://*.kiki-document.localhost:*");
    await embedded.locator('iframe').evaluate((element, preview) => { const frame = element as HTMLIFrameElement; frame.sandbox.value = preview.sandbox; frame.src = preview.url + '?mode=origin#ready'; }, preview);
    await embedded.frameLocator('iframe').locator('h1').waitFor();
    const frame = embedded.frames().find((frame) => frame.url().startsWith(preview.url))!;
    await frame.waitForFunction(() => Reflect.get(window, 'result') !== undefined);
    const documentProof = await frame.evaluate(async () => await Reflect.get(window, 'result'));
    expect(documentProof).toEqual(baselineProof);
    expect(documentProof.module).toEqual({ status: 'fulfilled', value: 'module-relative-ok' });
    expect(documentProof.fetch).toEqual({ status: 'fulfilled', value: { message: 'relative-fetch-ok' } });
    const isolation = await frame.evaluate(async (endpoint) => {
      let parentReadable = false; let parentBridge = false;
      try { parentReadable = parent.document !== undefined; } catch {}
      try { parentBridge = Reflect.get(parent, '__TAURI_INTERNALS__') !== undefined; } catch {}
      let api = 'blocked';
      try { api = String((await fetch(endpoint + '/api/private', { credentials: 'include' })).status); } catch {}
      return { parentReadable, parentBridge, ownerStorage: localStorage.getItem('owner-secret'), ownBridge: Reflect.get(window, '__TAURI_INTERNALS__') !== undefined, api, origin: location.origin, query: location.search, hash: location.hash };
    }, endpoint);
    expect(isolation).toMatchObject({ parentReadable: false, parentBridge: false, ownerStorage: null, ownBridge: false, api: 'blocked', query: '?mode=origin', hash: '#ready' });
    await frame.goto(preview.url);
    await frame.waitForFunction(() => Reflect.get(window, 'result') !== undefined);
    const afterReload = await frame.evaluate(async () => await Reflect.get(window, 'result'));
    expect(afterReload.visits).toBe('2');
    await app.inject({ method: 'DELETE', url: '/api/fs:html-preview/' + preview.preview_id, headers: { authorization: 'Bearer test-owner' } });
    const afterClose = await frame.evaluate(async () => { try { await fetch(location.href); return 'loaded'; } catch { return 'revoked'; } });
    expect(afterClose).toBe('revoked');
    expect(await readFile(source, 'utf8')).toBe(html);
    await writeFile(join(output, 'proof.json'), JSON.stringify({ fileProof, baselineProof, documentProof, afterReload, parentFixture, parentCsp: parentResponse?.headers()['content-security-policy'], isolation, afterClose, sandbox: preview.sandbox }, null, 2));
  } finally { await context.close(); await app.close(); }
}, 60_000);
