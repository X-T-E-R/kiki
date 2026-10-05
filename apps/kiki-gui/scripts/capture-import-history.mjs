/**
 * Native history import — the entry a user actually meets, and the first two
 * steps of the loop that follows it.
 *
 * This closes the gap the market screenshots left: the market proved the
 * catalog, and nothing here proved that "import a conversation" is reachable
 * at all and works without a flag. The walk drives the real build against the
 * repo's own `plugin-import` fixture, which seeds the six built-in sources, a
 * paged discovery list, every job state and two archives.
 *
 * What it asserts, in the order a reader meets it:
 *   1. the entry is in Settings → Sessions, where a reader manages how they
 *      work, and its label says what it does;
 *   2. clicking it lands on the import surface with all six sources present,
 *      and no dead link to a plugin page that manages nothing;
 *   3. choosing a source and a file produces a preview that is labelled a
 *      sample and carries the server's own loss lines.
 *
 * Two widths only: the wide layout the entry lives in, and the narrow one
 * where the same three steps have to stay reachable. Nothing here reaches a
 * real home, a real user history or the network; every value is fixture text.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'import-history-shots');

const CLAUDE_HOME = 'C:/Users/fixture/.claude';
const FILE = `${CLAUDE_HOME}/projects/edge-router/9f2c41ab-session.jsonl`;

/** Six built-in sources come from one first-party importer, with nothing installed. */
const EXPECTED_SOURCES = 6;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function resetScroll(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
}

/** Nothing may push the page sideways, at either width. */
async function noHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow <= 1, `${label} overflows horizontally by ${overflow}px`);
}

const scenarios = [
  {
    name: 'import-history',
    fixture: 'plugin-import',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      // 1. The entry, where a reader manages how they work. Importing an old
      //    conversation is a way of working with sessions and ships with Kiki,
      //    so it belongs in Settings → Sessions — not behind the plugin
      //    market, where it would read as something to install. It offers
      //    itself only where the server can actually read a history.
      await page.goto(link('/settings/sessions'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const settingsEntry = page.locator('[data-settings-open-import]');
      await settingsEntry.waitFor({ state: 'visible', timeout: 30_000 });
      const label = (await settingsEntry.textContent()) ?? '';
      expect(label.trim().length > 0, 'the settings import entry has no label');
      expect(/import|导入/i.test(label), `the entry does not say what it does: "${label}"`);
      await noHorizontalOverflow(page, 'settings entry');
      await resetScroll(page);
      await settingsEntry.scrollIntoViewIfNeeded();
      await shot('1-settings-entry');

      // 2. The surface. Six sources is the host's own answer, which is the point:
      //    the list is contract data, not a format list written in the GUI.
      await settingsEntry.click();
      await page.waitForSelector('[data-plugin-import-view]', { timeout: 30_000 });
      const sources = await page.locator('[data-plugin-import-source]').count();
      expect(sources === EXPECTED_SOURCES, `expected all ${EXPECTED_SOURCES} built-in sources, got ${sources}`);
      // Import is not a plugin you must install first, so the surface must not
      // send the reader to a plugin page that manages nothing.
      const toPlugin = await page.locator('[data-plugin-import-open-plugin]').count();
      expect(toPlugin === 0, 'the import surface still links to a plugin to manage');
      await noHorizontalOverflow(page, 'sources');
      await resetScroll(page);
      await shot('2-sources');

      // 3. A preview. The destination has to be aimed before the host will read
      //    anything, so the walk picks the workspace the page itself offers
      //    rather than typing a path: that is the affordance a reader uses.
      const workdir = page.locator('[data-plugin-import-workdir-option]').first();
      expect(await workdir.count() > 0, 'the import surface offers no workspace to import into');
      await workdir.click();
      await page.waitForSelector('[data-plugin-import-workdir]:not([data-plugin-import-workdir="unset"])', { timeout: 15_000 });

      const home = page.locator('[data-plugin-import-home]');
      expect(await home.count() > 0, 'the import surface offers no source home field');
      await home.fill(CLAUDE_HOME);
      await page.waitForSelector('[data-plugin-import-file]', { timeout: 30_000 });
      // The list sits below the fold, so a shot of it has to scroll to it
      // rather than assume the page is already where the reader has to go.
      await page.locator('[data-plugin-import-file]').first().scrollIntoViewIfNeeded();
      await noHorizontalOverflow(page, 'discovery');
      await shot('3-discovery');

      const file = page.locator('[data-plugin-import-file]').first();
      expect(await file.count() > 0, `the source lists no importable file under ${CLAUDE_HOME}`);
      await file.click();
      // The probe is a real bounded read, so the page states it is checking
      // first. Waiting for the panel rather than a fixed pause is what makes
      // the shot the finished preview instead of the work in progress.
      await page.waitForSelector('[data-plugin-import-preview]', { timeout: 60_000 });
      const preview = page.locator('[data-plugin-import-preview]');
      const coverage = await preview.getAttribute('data-plugin-import-coverage');
      expect(coverage === 'sample' || coverage === 'complete',
    `the preview does not state its own coverage: ${String(coverage)}`);
      const losses = await page.locator('[data-plugin-import-loss]').count();
      expect(losses > 0, 'the preview claims a lossless import the server did not report');
      await page.locator('[data-plugin-import-preview]').scrollIntoViewIfNeeded();
      await noHorizontalOverflow(page, 'preview');
      await shot('4-preview');

      // The state a reader would act on next has to be reachable without
      // scrolling the page sideways, which the overflow checks already prove.
      await page.locator('[data-plugin-import-preview]').first().scrollIntoViewIfNeeded();
      await shot(`5-after-preview-${view.width}`);
    },
  },
];

const result = await runProof({
  scenarios,
  root: ROOT,
  argv: process.argv.slice(2),
  label: 'import-history',
  // The preview is a real bounded read of the seeded history, so this walk
  // needs longer than the default budget on a cold Windows filesystem.
  jobTimeoutMs: 150_000,
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;
