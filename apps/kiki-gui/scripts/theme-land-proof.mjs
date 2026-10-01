import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'theme-land');
await mkdir(output, { recursive: true });
const fixture = await startFixtureServer({ port: 0, scenario: 'skins' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
await vite.listen();
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const link = (path) => `${base}${path}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;
const families = ['paper', 'porcelain', 'celadon', 'apricot', 'iris', 'contrast'];
const retired = ['linen', 'graphite', 'forest', 'claret', 'heather', 'nocturne', 'sand', 'slate'];
const text = await readFile(join(root, 'src/lib/skins/builtin.ts'), 'utf8');
const expected = Object.fromEntries([...text.matchAll(/id: (?:'([a-z]+)'|DEFAULT_SKIN_ID),[\s\S]*?variants: \{([\s\S]*?)(?=\n  \},)/g)]
  .map((skin) => [skin[1] ?? 'paper', Object.fromEntries(['light', 'dark'].map((mode) => {
    const block = skin[2].match(new RegExp(`${mode}: \\{ colors: \\{([\\s\\S]*?)\\}`))[1];
    return [mode, Object.fromEntries([...block.matchAll(/([A-Za-z]+): '(#[0-9A-F]{6})'/g)].map((m) => [m[1], m[2]]))];
  }))]));
const checks = [];
await page.addInitScript(() => {
  localStorage.setItem('kiki.locale', 'zh');
  localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
});
const setLook = async (id, theme) => {
  await page.evaluate(([skinId, mode]) => {
    localStorage.setItem('kiki.skin', JSON.stringify({ selection: { source: 'builtin', id: skinId }, tweaks: {} }));
    localStorage.setItem('kiki.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('kiki.settings') ?? '{}'), theme: mode }));
  }, [id, theme]);
};
const checkTokens = async (id, mode) => {
  const actual = await page.evaluate((tokens) => {
    const html = document.documentElement;
    const style = getComputedStyle(html);
    return { id: html.dataset.skin, theme: html.dataset.theme, colors: Object.fromEntries(tokens.map((token) => {
      const name = token === 'shadowInk' ? '--kiki-shadow-ink' : `--color-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      return [token, style.getPropertyValue(name).trim()];
    })) };
  }, Object.keys(expected[id][mode]));
  assert.equal(actual.id, id);
  assert.equal(actual.theme, mode);
  for (const [token, value] of Object.entries(expected[id][mode])) {
    const wanted = token === 'shadowInk' ? [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).join(' ') : value;
    assert.equal(actual.colors[token].toUpperCase(), wanted, `${id}/${mode}/${token}`);
  }
};
try {
  await page.goto(link('/settings/appearance'), { timeout: 120_000 });
  await page.waitForSelector('[data-skin-choice="porcelain"]');
  for (const id of retired) assert.equal(await page.locator(`[data-skin-choice="${id}"]`).count(), 0);
  for (const id of families) assert.equal(await page.locator(`[data-skin-choice="${id}"]`).count(), 1);
  checks.push('picker has six paired built-ins and no retired choices');
  for (const id of families) {
    for (const mode of ['light', 'dark']) {
      await setLook(id, mode);
      await page.goto(link('/s/session_fixture_skins'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea[data-composer]', { timeout: 30_000 });
      await page.waitForFunction(() => document.body.innerText.includes('export const answer = 42;'), { timeout: 30_000 });
      await checkTokens(id, mode);
      assert.ok(await page.locator('.app-sidebar').isVisible());
      assert.ok(await page.locator('[data-transcript-scroll]').isVisible());
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(output, `${id}-${mode}-session.png`) });
      checks.push(`${id}/${mode}: 36 computed tokens, sidebar, transcript, composer, 1440x900 screenshot`);
    }
  }
  for (const mode of ['light', 'dark']) {
    await setLook('paper', mode);
    await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-skin-choice="iris"]');
    await page.locator('#st-card-appearance').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `picker-${mode}.png`) });
  }
  for (const id of retired) {
    for (const mode of ['light', 'dark']) {
      await setLook(id, mode);
      await page.goto(link('/s/session_fixture_skins'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea[data-composer]');
      await checkTokens('paper', mode);
      checks.push(`${id}/${mode}: restored default pair on reload`);
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${checks.length} checks; 14 screenshots; ${output}`);
} catch (error) {
  errors.push(String(error));
  await page.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify({ fixture: 'skins', viewport: { width: 1440, height: 900 }, checks, errors }, null, 2));
  await browser.close();
  await vite.close();
  await fixture.stop();
}
