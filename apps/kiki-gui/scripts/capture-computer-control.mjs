/**
 * computer-control screenshots — the settings 电脑控制 leaf, driven through the
 * real controls on the real build: the fixture seeds the capability and the MCP
 * catalog, and the walk clicks install, edits a field, tests the connection and
 * stops it. Nothing is patched into the DOM after load, so every image shows
 * what the page does with the server's own answers.
 *
 *   node scripts/capture-computer-control.mjs              # en/light/1440
 *   node scripts/capture-computer-control.mjs --matrix=all # locale × theme × width
 *
 * Output: `.tmp/computer-control-shots` (override with KIKI_PROOF_OUTPUT_DIR).
 * The build under test is the one-shot vite build the shared proof runner makes.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'computer-control-shots');

const EDITED_BINARY = 'C:\\Users\\fixture\\bin\\cua-driver.exe';

const scenarios = [
  {
    name: 'computer-control',
    fixture: 'computer-control',
    matrix: ['theme', 'width'],
    run: async ({ page, link, shot }) => {
      await page.goto(link('/settings/computer-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // The machine line is the server's own platform/arch, not a decoration.
      await page.waitForSelector('[data-computer-platform]', { timeout: 30_000 });
      await page.waitForSelector('[data-computer-state="not_installed"]', { timeout: 30_000 });
      // The seeded global MCP entry is not a computer connection, so the block
      // is in its empty state until the executor install registers one.
      await page.waitForSelector('[data-computer-new]', { timeout: 30_000 });
      await shot('not-installed');

      // The creation form: installer defaults, a commit bar that stays in view,
      // and Discard as the way back to the list.
      await page.locator('[data-computer-new]').click();
      await page.waitForSelector('[data-computer-name-input]', { timeout: 10_000 });
      await page.locator('[data-settings-draft]').scrollIntoViewIfNeeded();
      await shot('new-connection');
      await page.locator('[data-settings-discard]').click();
      await page.waitForSelector('[data-computer-new]', { timeout: 10_000 });

      // The install plan is the only path to an install, and the confirm sheet
      // lists its real facts.
      await page.locator('[data-computer-install-btn]').click();
      await page.waitForSelector('[data-confirm-action="confirm"]', { timeout: 10_000 });
      await shot('install-confirm');
      await page.locator('[data-confirm-action="confirm"]').click();
      await page.waitForSelector('[data-computer-state="ready"]', { timeout: 30_000 });
      await page.waitForSelector('[data-computer-connection="kiki-computer"]', { timeout: 30_000 });
      await shot('installed');

      // Detection details stay folded until asked for; the optional step says
      // it was not checked instead of claiming the desktop is reachable.
      await page.locator('[data-computer-steps] summary').click();
      await shot('install-details');

      await page.locator('[data-computer-connection="kiki-computer"]').click();
      await page.waitForSelector('[data-computer-command-input]', { timeout: 10_000 });
      await shot('connection-detail');

      await page.fill('[data-computer-command-input]', EDITED_BINARY);
      await page.waitForSelector('[data-settings-draft]:not([hidden])', { timeout: 10_000 });
      await page.locator('[data-settings-draft]').scrollIntoViewIfNeeded();
      await shot('draft-dirty');

      await page.locator('[data-computer-test-btn]').click();
      await page.waitForSelector('[data-computer-test-result]', { timeout: 30_000 });
      await shot('test-result');

      await page.locator('[data-settings-draft] button').first().click();
      await page.waitForSelector('[data-saved-tick]', { timeout: 30_000 });
      // A clean draft collapses the bar to the one-line ✓; that line is what the
      // shot has to show.
      await page.locator('[data-saved-tick]').scrollIntoViewIfNeeded();
      await shot('saved');

      await page.locator('[data-computer-stop-btn]').click();
      await page.waitForSelector('[data-confirm-action="confirm"]', { timeout: 10_000 });
      await shot('stop-confirm');
      await page.locator('[data-confirm-action="confirm"]').click();
      await page.waitForSelector('[data-computer-stop-result]', { timeout: 30_000 });
      await shot('stop-result');
    },
  },
];

const result = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'computer-control',
});
console.log(`computer-control shots in ${result.outputDir}`);
if (result.failed.length > 0) process.exitCode = 1;
