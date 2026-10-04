/**
 * One real-route check for the S2 surface that only exists inside the page: the
 * new-service-instance form on the Search settings page.
 *
 *   node scripts/visual-proof-nbsearch-instance.mjs
 *
 * Everything else in S2 can be driven from a harness because the tabs are pure;
 * this one is behind the section's own tab strip and its providers list, so it
 * is walked through the real route: /settings/search?tab=providers, the entry
 * button "新建同服务实例" / "New instance of a service", then the form. One job
 * covers both widths — 1440 and 390 in the same context — because the question
 * is reachability and fit, not a full matrix. Screenshots land in the runner's
 * disposable output directory.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

/** Horizontal overflow of the page itself, in CSS pixels. */
async function pageOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const scenario = {
  name: 'settings-nbsearch-instance',
  fixture: 'settings-nbsearch',
  run: async ({ page, link, shot }) => {
    await page.goto(link('/settings/search?tab=providers'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const entry = page.locator('[data-nb-search-new-instance]');
    await entry.waitFor({ timeout: 30_000 });
    // The label the user actually sees for this entry, recorded for the report.
    const entryLabel = (await entry.textContent())?.trim() ?? '';
    if (entryLabel === '') problems.push('the new-instance entry has no label');
    console.log(`[nbsearch-instance] entry reads "${entryLabel}"`);
    await entry.click();
    const editor = page.locator('[data-nb-search-instance-editor]');
    await editor.waitFor({ timeout: 10_000 });
    if (!await editor.isVisible()) problems.push('the new-instance form is in the DOM but not visible');

    // Step one is the provider picker; the binding fields follow the choice.
    const picker = editor.locator('[data-nb-search-provider-options] [data-nb-search-provider-option]');
    const optionCount = await picker.count();
    if (optionCount === 0) problems.push('the new-instance form offers no service to bind');
    await picker.nth(optionCount > 1 ? 1 : 0).click();

    // The form has to name its own fields, not just render a grid.
    for (const label of ['[data-nb-search-instance-id]', '[data-nb-search-instance-create]']) {
      await editor.locator(label).first().waitFor({ timeout: 10_000 });
      if (await editor.locator(label).count() === 0) problems.push(`the new-instance form is missing ${label}`);
    }
    if (!await editor.locator('[data-nb-search-instance-id]').isEditable()) {
      problems.push('the new-instance ID field is not editable');
    }
    const overflow1440 = await pageOverflow(page);
    if (overflow1440 > 1) problems.push(`the instance form overflows 1440 by ${overflow1440}px`);
    await shot('nbsearch-instance-1440');

    await page.setViewportSize({ width: 390, height: 844 });
    await editor.scrollIntoViewIfNeeded();
    const overflow390 = await pageOverflow(page);
    if (overflow390 > 1) problems.push(`the instance form overflows 390 by ${overflow390}px`);
    // The create action must stay reachable without horizontal scrolling.
    const create = await editor.locator('[data-nb-search-instance-create]').boundingBox();
    if (create === null || create.x < 0 || create.x + create.width > 390) {
      problems.push(`the create button is outside the 390px viewport: ${JSON.stringify(create)}`);
    }
    await shot('nbsearch-instance-390');
  },
};

const result = await runProof({
  root: ROOT,
  scenarios: [scenario],
  argv: process.argv.slice(2),
  label: 'nbsearch-instance',
});

if (problems.length > 0 || result.failed.length > 0) {
  console.error('[nbsearch-instance] FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  for (const failure of result.failed) console.error(`  - ${failure.id}: ${failure.error}`);
  process.exit(1);
}
console.log(`[nbsearch-instance] PROOF DONE -> ${result.outputDir}`);
