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
    const preview = opened.json().data as { url: string; preview_id: string };
    const previewBytes = await app.inject(preview.url);
    expect(previewBytes.rawPayload).toEqual(original);
    const direct = await context.newPage(); const embedded = await context.newPage();
    const errors: string[] = [];
    embedded.on('pageerror', (error) => errors.push(error.message));
    await direct.goto(pathToFileURL(source).href);
    await embedded.goto(endpoint + '/parent');
    await embedded.locator('iframe').evaluate((frame, url) => { (frame as HTMLIFrameElement).src = url; }, endpoint + preview.url);
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
    await frame.goto(endpoint + preview.url + '?shot=5#3');
    await frame.waitForFunction(() => (document.querySelector('deck-stage') as HTMLElement & { index: number })?.index === 5);
    const nested = frame.childFrames().find((child) => child.url().includes('design-html-deck-final-v6'));
    expect(nested).toBeDefined();
    await nested!.waitForFunction(() => customElements.get('deck-stage') !== undefined);
    const nestedProof = await nested!.evaluate(() => ({ url: location.href, index: (document.querySelector('deck-stage') as HTMLElement & { index: number }).index, slides: document.querySelector('deck-stage')?.children.length }));
    const isolation = await frame.evaluate(async () => {
      let parentReadable = false; let parentBridge = false; let storage = false;
      try { parentReadable = parent.document !== undefined; } catch {}
      try { parentBridge = Reflect.get(parent, '__TAURI_INTERNALS__') !== undefined; } catch {}
      try { storage = localStorage.getItem('test-owner') !== null; } catch {}
      let api: string;
      try { api = String((await fetch('/api/private', { credentials: 'include' })).status); } catch { api = 'blocked'; }
      return { parentReadable, parentBridge, storage, api, ownBridge: Reflect.get(window, '__TAURI_INTERNALS__') !== undefined };
    });
    expect(isolation).toEqual({ parentReadable: false, parentBridge: false, storage: false, api: 'blocked', ownBridge: false });
    await app.inject({ method: 'DELETE', url: '/api/fs:html-preview/' + preview.preview_id, headers: { authorization: 'Bearer test-owner' } });
    expect((await app.inject(preview.url)).statusCode).toBe(404);
    expect(await readFile(source)).toEqual(original);
    await writeFile(join(output, 'proof.json'), JSON.stringify({ sha256: createHash('sha256').update(original).digest('hex'), directInitial, previewInitial, keyboard, nestedProof, isolation, errors }, null, 2));
  } finally { await context.close(); await app.close(); }
}, 60_000);
