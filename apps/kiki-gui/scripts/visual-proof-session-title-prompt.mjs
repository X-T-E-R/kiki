/**
 * Visual proof for the session title prompt (803 title card).
 *
 * The card's states are the thing worth looking at, so each scenario is one
 * state and each is shot twice: at the settings column width and at 390px,
 * where the editor, its two actions and the built-in preview all have to
 * stack without pushing the page sideways.
 *
 *   node scripts/visual-proof-session-title-prompt.mjs
 *   node scripts/visual-proof-session-title-prompt.mjs --only=title-default
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = '#st-card-session-title [data-session-title-prompt]';

/**
 * One scenario, one state, two widths. The 390px shot also fails the run if
 * the page scrolls sideways, which is the only way a narrow layout breaks
 * silently in a desktop-width screenshot.
 */
function titleState(name, { openDefault = false } = {}) {
  return async ({ page, shot, link }) => {
    await page.goto(link('/settings/sessions'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(CARD, { timeout: 30_000 });
    await page.locator('#st-card-session-title').scrollIntoViewIfNeeded();
    if (openDefault) {
      await page.click('[data-session-title-prompt-toggle-default]');
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(400);
    await page.locator('#st-card-session-title').screenshot({ path: await shot(`title-${name}`) });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.locator('#st-card-session-title').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error(`The session title card overflows the 390px viewport in "${name}"`);
    await page.locator('#st-card-session-title').screenshot({ path: await shot(`title-${name}-390`) });
  };
}

const scenarios = [
  { name: 'title-default', fixture: 'session-title-prompt-default', matrix: ['theme'], run: titleState('default') },
  { name: 'title-custom', fixture: 'session-title-prompt-custom', matrix: ['theme'], run: titleState('custom') },
  {
    name: 'title-default-open', fixture: 'session-title-prompt-default', matrix: ['theme'],
    run: titleState('default-open', { openDefault: true }),
  },
  {
    name: 'title-no-metadata', fixture: 'session-title-prompt-no-metadata', matrix: ['theme'],
    run: titleState('no-metadata'),
  },
];

await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'session-title-prompt' });