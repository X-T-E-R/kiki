import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';
import { pictures, SID } from '../fixtures/sent-images.scenario.mjs';
import { registerSessionMediaRoutes } from '../../../packages/kap-server/src/routes/sessionMedia.ts';
import { boundedAttachment } from '../../../packages/kap-server/src/transport/klient/boundedTranscript.ts';

const require = createRequire(new URL('../../../packages/kap-server/package.json', import.meta.url));
const Fastify = require('fastify');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'sent-image-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const fixture = await startFixtureServer({ port: 0, scenario: 'sent-images' });
const main = fixture.sessions.get(SID).transcript.ensure('main');
const canonical = structuredClone(main.snapshot);
assert.equal(canonical.attachments.length, 3);
canonical.attachments.forEach((attachment, index) => { attachment.name = pictures[index].name; attachment.size = pictures[index].bytes.byteLength; });
main.snapshot.attachments = canonical.attachments.map((attachment) => boundedAttachment(attachment, 'main', 2048));
const evidence = { shell: 'fixture', media: 'production KAP routes + canonical cold snapshot + inlineMedia + source compression + production GUI/client/browser decode', sourceBytes: pictures.map(({ name, width, height, bytes }) => ({ name, width, height, bytes: bytes.byteLength })), coldReads: 0, requests: [], errors: [], decoded: {}, checks: [] };
const app = Fastify();
app.addHook('preHandler', async (request, reply) => {
  if (request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) return reply.code(401).send();
});
const service = {
  forSessionLive: () => undefined,
  readColdSnapshot: async (sessionId, agentId) => { evidence.coldReads += 1; return sessionId === SID && agentId === 'main' ? canonical : undefined; },
};
await app.register(async (router) => { registerSessionMediaRoutes(router, {}, service); }, { prefix: '/api' });
const mediaEndpoint = await app.listen({ host: '127.0.0.1', port: 0 });
const originalHttp = fixture.handleHttp.bind(fixture);
fixture.handleHttp = async (request, response) => {
  if (!request.url.startsWith(`/api/sessions/${SID}/media/`)) return originalHttp(request, response);
  if (typeof request.headers.origin === 'string') {
    response.setHeader('access-control-allow-origin', request.headers.origin);
    response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    response.setHeader('access-control-allow-headers', 'Authorization, If-None-Match, Range');
    response.setHeader('access-control-expose-headers', 'Content-Disposition, ETag');
    response.setHeader('vary', 'Origin');
  }
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const started = Date.now();
  const authorized = request.headers.authorization === `Bearer ${FIXTURE_TOKEN}` || /(?:^|;\s*)kiki_web_[0-9a-f]+=/.test(request.headers.cookie ?? '');
  const upstream = await fetch(`${mediaEndpoint}${request.url}`, { headers: { authorization: authorized ? `Bearer ${FIXTURE_TOKEN}` : '', 'if-none-match': request.headers['if-none-match'] ?? '' } });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  evidence.requests.push({ path: request.url, authorized, bearerPresent: request.headers.authorization !== undefined, cookiePresent: request.headers.cookie !== undefined, status: upstream.status, bytes: bytes.byteLength, ms: Date.now() - started });
  if (upstream.status !== 200 && upstream.status !== 304) console.log('[sent-image-proof] media failed', JSON.stringify(evidence.requests.at(-1)));
  response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([key]) => !['connection', 'transfer-encoding'].includes(key))));
  response.end(bytes);
};
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: null } });
await vite.listen();
await vite.watcher.close();
console.log('[sent-image-proof] vite ready');
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
evidence.authentication = 'Production GUI HTTP client sends the fixed fixture bearer from its connection. The production-media test host requires it; web-session establishment is outside this fixture.';
page.on('pageerror', (error) => evidence.errors.push(error.message));
page.on('response', async (response) => {
  if (response.status() < 400) return;
  const failure = { url: response.url().replace(/[?&]token=[^&]+/g, ''), status: response.status(), body: (await response.text().catch(() => '')).slice(0, 3000) };
  evidence.requests.push(failure);
  console.log('[sent-image-proof] HTTP failed', JSON.stringify(failure));
});
await page.addInitScript(() => localStorage.setItem('kiki.locale', 'zh'));
const readImages = async () => page.locator('[data-transcript-scroll] img').evaluateAll((images) => images.map((image) => ({ name: image.alt, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height })));
const loaded = async () => {
  await page.waitForFunction(() => { const images = [...document.querySelectorAll('[data-transcript-scroll] img')]; return document.querySelector('[data-transcript-scroll] [data-media-broken]') || images.length === 3 && images.every((image) => image.naturalWidth > 0 && image.getBoundingClientRect().width > 0); }, undefined, { timeout: 30_000 });
  assert.equal(await page.locator('[data-transcript-scroll] [data-media-broken]').count(), 0, 'automatic saved images should not end in a read/decode failure');
};
try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/s/${SID}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`, { timeout: 120_000 });
  console.log('[sent-image-proof] full GUI navigated');
  await loaded();
  console.log('[sent-image-proof] three images decoded');
  evidence.decoded.beforeClick = await readImages();
  assert.equal(await page.getByText('加载完整文件', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-transcript-scroll] a[download]').count(), 0);
  assert.equal(evidence.requests.filter(({ path }) => !path.includes('/preview')).length, 0);
  await page.screenshot({ path: join(output, '01-auto-visible.png'), fullPage: true });
  evidence.checks.push('three saved PNGs decoded automatically without a load gate or per-image Download');
  for (let index = 0; index < 3; index += 1) {
    await page.locator(`[data-transcript-scroll] img[alt="${pictures[index].name}"]`).click();
    await page.waitForFunction(() => document.querySelector('[data-attachment-preview] img')?.naturalWidth > 0, undefined, { timeout: 120_000 });
    const decoded = await page.locator('[data-attachment-preview] img').evaluate(async (image) => {
      await image.decode();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, lastPixel: [...context.getImageData(image.naturalWidth - 1, image.naturalHeight - 1, 1, 1).data] };
    });
    assert.equal(decoded.naturalWidth, pictures[index].width);
    assert.equal(decoded.naturalHeight, pictures[index].height);
    assert.equal(decoded.lastPixel[3], 255);
    evidence.decoded[`opened-${index}`] = decoded;
    await page.screenshot({ path: join(output, `02-opened-${index}.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  }
  await page.reload();
  await loaded();
  evidence.decoded.coldReload = await readImages();
  await page.screenshot({ path: join(output, '03-cold-reload.png'), fullPage: true });
  assert.ok(evidence.coldReads >= 9);
  const old = { source: { url: canonical.attachments[1].source.url.slice(0, 2048) } };
  evidence.truncationControl = 'Explicit 2048-character data-URL prefix simulates the former sliced-source defect; current boundedAttachment is used for the success path.';
  const raster = async (url) => page.evaluate(async (src) => {
    const image = new Image(); image.src = src;
    let decoded = true; try { await image.decode(); } catch { decoded = false; }
    let lastPixel = null;
    if (decoded) {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      lastPixel = [...context.getImageData(image.naturalWidth - 1, image.naturalHeight - 1, 1, 1).data];
    }
    return { sourceChars: src.length, decoded, naturalWidth: image.naturalWidth, lastPixel };
  }, url);
  evidence.oldTruncatedSource = await raster(old.source.url);
  evidence.completeSourceControl = await raster(canonical.attachments[1].source.url);
  assert.equal(evidence.completeSourceControl.lastPixel[3], 255);
  assert.notDeepEqual(evidence.oldTruncatedSource.lastPixel, evidence.completeSourceControl.lastPixel);
  evidence.checks.push('a truncated PNG may report natural dimensions but does not preserve the complete image pixels');
  const originalSource = canonical.attachments[0].source;
  delete canonical.attachments[0].source;
  await page.locator('[data-transcript-scroll] img[alt="small.png"]').click();
  await page.locator('[data-attachment-preview] [data-media-broken="read"]').waitFor();
  await page.screenshot({ path: join(output, '04-missing-original.png'), fullPage: true });
  canonical.attachments[0].source = originalSource;
  await page.locator('[data-attachment-preview] [data-media-broken]').click();
  await page.waitForFunction(() => document.querySelector('[data-attachment-preview] img')?.naturalWidth === 16);
  evidence.checks.push('missing original is a recoverable read failure; retry reads restored canonical source');
  evidence.checks.push('cold reload reads the canonical saved PNGs without resuming a live session');
  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = String(error);
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Sent image evidence: ${output}`);
  await browser.close(); await vite.close(); await fixture.stop(); await app.close();
}
