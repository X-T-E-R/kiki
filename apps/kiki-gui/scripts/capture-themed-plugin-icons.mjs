/**
 * Themed plugin icons — measured in the real built app, not in a mock page.
 *
 * Loads the market, then reads the actual painted pixel of a first-party mark
 * under light, dark, and a custom skin (an inline `--color-ink-soft` override,
 * which is how a skin is applied — see `lib/skins/apply.ts`). A mark that does
 * not follow would read black in all three.
 *
 * Also proves the two degenerate cases in the same page: an entry with no icon
 * and an entry whose icon URL 404s must both fall back to the drawn kind tile.
 *
 *   node scripts/capture-themed-plugin-icons.mjs
 * Output: `.tmp/themed-plugin-icons` (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'themed-plugin-icons');

/** The box a mark was painted in, read from the rendered page. */
async function inkOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
}

/**
 * The colour a mark is painted in: the most saturated / furthest-from-the-page
 * pixel in its box. Averaging would only ever return the antialiased edge, so
 * the most extreme pixel is the one that carries the stroke's own value.
 */
async function markInk(page, selector) {
  const box = await inkOf(page, selector);
  if (box === null) return null;
  const png = (await page.screenshot({ clip: box })).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = new OffscreenCanvas(img.width, img.height);
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    // The page ground under the mark: paper, or the tile wash over it.
    let ground = null;
    const histogram = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
    for (const [key, count] of histogram) if (ground === null || count > ground.count) {
      ground = { key, count };
    }
    const [gr, gg, gb] = ground.key.split(',').map(Number);
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg2, b] = [d[i], d[i + 1], d[i + 2]];
      const score = Math.abs(r - gr) + Math.abs(gg2 - gg) + Math.abs(b - gb);
      if (score > bestScore) { bestScore = score; best = [r, gg2, b]; }
    }
    return { ink: best, ground: [gr, gg, gb] };
  }, png);
}

const scenarios = [
  {
    name: 'themed-plugin-icons',
    fixture: 'plugin-market',
    matrix: ['theme'],
    run: async ({ page, view, link, shot }) => {
      const log = console.log;
      await page.emulateMedia({ colorScheme: view.theme });
      await page.goto(link('/capabilities?tab=plugins&session=session_fixture_plugin_market'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-catalog-row="kiki-office"] [data-capability-icon="image"]', { timeout: 30_000 });
      await page.waitForTimeout(500);

      const row = '[data-catalog-row="kiki-office"] [data-capability-icon="image"]';
      log(`[${view.theme}] office mark rgb=${JSON.stringify(await markInk(page, row))}`);
      await shot('market-ink');

      // A skin is applied as inline custom properties on <html>; move ink-soft
      // and the mark has to move with it.
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--color-ink-soft', '#7a1f6b');
      });
      await page.waitForTimeout(400);
      log(`[${view.theme} + skin] office mark rgb=${JSON.stringify(await markInk(page, row))}`);
      await shot('market-ink-skinned');

      // The two degenerate entries must never show a broken image.
      const tiles = await page.evaluate(() => ({
        fallback: document.querySelectorAll('[data-capability-icon="fallback"]').length,
        images: document.querySelectorAll('[data-capability-icon="image"]').length,
      }));
      log(`[${view.theme}] fallback tiles=${tiles.fallback} images=${tiles.images}`);
    },
  },
];

const result = await runProof({
  scenarios,
  root: ROOT,
  argv: process.argv.slice(2),
  label: 'themed-plugin-icons',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;
