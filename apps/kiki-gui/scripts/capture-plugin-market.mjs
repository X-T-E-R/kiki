/**
 * plugin-market screenshots — the official market at the two widths that
 * matter, driven through the real controls on the real build against a fixture
 * seeded from the shipped `plugins/marketplace.json`. Nothing is patched into
 * the DOM after load, so each image shows what a user with no configuration
 * actually gets.
 *
 *   node scripts/capture-plugin-market.mjs
 *
 * Output: `.tmp/plugin-market-shots` (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'plugin-market-shots');

/** The capabilities page scrolls its own pane; a shot starts at the top. */
async function resetScroll(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
}

const scenarios = [
  {
    name: 'plugin-market',
    fixture: 'plugin-market',
    matrix: ['theme', 'width'],
    run: async ({ page, view, link, shot }) => {
      // The app resolves its palette from the stored preference against the OS
      // preference, so a dark run has to emulate a dark OS or it would quietly
      // capture the light palette and prove nothing.
      await page.emulateMedia({ colorScheme: view.theme });
      await page.goto(link('/capabilities?tab=plugins&session=session_fixture_plugin_market'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-plugins-view]', { timeout: 30_000 });
      await page.waitForSelector('[data-catalog-row]', { timeout: 30_000 });
      await resetScroll(page);
      // The whole market, with no address configured anywhere.
      await shot('market-all');

      // Search reaches every entry, including a package that is far down.
      const search = page.getByRole('searchbox').first();
      await search.fill('extract');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-catalog-row]').length > 0
          && document.querySelectorAll('[data-catalog-row]').length < 5,
        { timeout: 10_000 },
      );
      await resetScroll(page);
      await shot('search');

      // Clear, then the media family as its own block. Reset first and scroll
      // after: resetting afterwards would put the page back at the top and the
      // shot would show the recommended shelf instead of the block it names.
      await search.fill('');
      await page.waitForSelector('#plugins-shelf-official-media [data-catalog-row]', { timeout: 10_000 });
      await resetScroll(page);
      await page.locator('#plugins-shelf-official-media').scrollIntoViewIfNeeded();
      await shot('media-family');

      // A package that is not installed: its detail, with the install path.
      await page.goto(link('/capabilities?tab=plugins&plugin=kiki-office'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-plugin-detail="kiki-office"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('detail-not-installed');

      // The media plugin's own page carries the management entry, so the
      // surface is reached by installing the package rather than a global button.
      await page.goto(link('/capabilities?tab=plugins&plugin=kiki-media'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-plugin-open-media="kiki-media"]', { timeout: 30_000 });
      await page.locator('[data-plugin-open-media="kiki-media"]').scrollIntoViewIfNeeded();
      await resetScroll(page);
      await shot('media-entry');

      // The installed list: what is on this server, whatever its origin.
      await page.goto(link('/capabilities?tab=plugins&view=installed'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-plugins-view="installed"]', { timeout: 30_000 });
      await page.waitForSelector('[data-plugin-row]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('installed');

      // The settings leaf: the same catalog, and the nav it now lives under.
      // The settings leaf stays a management page: the catalog address and
      // the link to the market, not a second market.
      await page.goto(link('/settings/plugins'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('#st-card-plugins', { timeout: 30_000 });
      await page.waitForSelector('[data-catalog-source]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('settings-plugins');

      // The nav the two moved pages now live under, on a real settings page.
      // Below the wide breakpoint the tree lives in a drawer, so the shot
      // opens it rather than asserting a column that is not on screen.
      await page.goto(link('/settings/permissions'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-settings-page-title]', { timeout: 30_000 });
      if (view.width <= 720) {
        await page.locator('[data-settings-nav-trigger]').first().click({ timeout: 15_000 });
        await page.waitForSelector('[role="dialog"] [data-settings-nav-tree]', { timeout: 15_000 });
      } else {
        await page.waitForSelector('nav [data-settings-nav-tree]', { timeout: 30_000 });
      }
      await resetScroll(page);
      await shot('settings-nav');
    },
  },
];

const result = await runProof({
  scenarios,
  root: ROOT,
  argv: process.argv.slice(2),
  label: 'plugin-market',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;
