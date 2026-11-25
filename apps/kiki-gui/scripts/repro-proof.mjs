import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

async function run() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const output = join(root, '.tmp', 'browser-proof');
  await mkdir(output, { recursive: true });

  const fixture = await startFixtureServer({ port: 0, scenario: 'gui-slice' });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  process.env.KIKI_SERVER_URL = fixtureUrl;

  const vite = await createServer({
    root,
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      watch: { ignored: ['**/*.test.ts', '**/*.test.tsx', '.tmp/**', '**/.tmp/**'] },
    },
  });
  await vite.listen();
  const webUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); });

  try {
    const targetUrl = `${webUrl}/s/session_fixture_gui_slice?server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('[data-transcript-scroll]').waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-transcript-virtual-item]').length > 0,
      null,
      { timeout: 15_000 },
    );

    await page.evaluate(() => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      if (scroller !== null) scroller.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(output, 'first-open-top.png'), fullPage: false });

    const measurements = await page.evaluate(() => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      const items = [...document.querySelectorAll('[data-transcript-virtual-item]')].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          block: el.querySelector('[data-block-id]')?.getAttribute('data-block-id') ?? null,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      });
      return {
        items,
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
      };
    });

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join('; ')}`);
    assert.ok(measurements.items.length > 0, 'expected rendered transcript virtual items');
    assert.ok(measurements.scrollHeight >= measurements.clientHeight, 'transcript scrollHeight must be >= clientHeight');
    const sorted = [...measurements.items].sort((a, b) => a.top - b.top);
    for (let i = 0; i < sorted.length; i += 1) {
      assert.ok(sorted[i].height > 0, `virtual item ${i} (${sorted[i].block}) has non-positive height`);
      if (i > 0) {
        assert.ok(
          sorted[i].top >= sorted[i - 1].bottom - 1,
          `virtual items overlap: ${sorted[i - 1].block} bottom=${sorted[i - 1].bottom} > ${sorted[i].block} top=${sorted[i].top}`,
        );
      }
    }
    console.log(JSON.stringify({ out: output, renderedItems: measurements.items.length }, null, 2));
  } finally {
    await browser.close();
    await vite.close();
    await fixture.stop();
  }
}

await run();
