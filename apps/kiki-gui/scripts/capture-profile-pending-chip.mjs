/**
 * Visual proof for the pending-profile chip fix: a brand-new session that
 * sends its first message must NOT show the "… · next message" chip, while an
 * explicit profile switch must. Run with a fixture server:
 *
 *   node scripts/fixture-server.mjs --port 58901 --scenario basic-stream
 *   node scripts/capture-profile-pending-chip.mjs
 *
 * Output: .tmp/profile-pending-chip/*.png
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.KIKI_CHIP_OUTPUT_DIR ?? join(ROOT, '.tmp', 'profile-pending-chip'));
const BASE = process.env.KIKI_CHIP_WEB ?? 'http://127.0.0.1:5199';
const TOKEN = process.env.KIKI_CHIP_TOKEN ?? 'kiki-fixture-token';
mkdirSync(OUT, { recursive: true });

const link = (path) => `${BASE}${path}#token=${TOKEN}`;

async function shot(page, name) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) =>
      animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  }).catch(() => undefined);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  return `${name}.png`;
}

const chipGone = async (page, name) => {
  const chip = page.locator('#composer-profile-select[data-execution-pending="true"]');
  if (await chip.count() !== 0) throw new Error(`${name}: pending chip is visible but must not be`);
  return shot(page, name);
};

const browser = await chromium.launch({ args: ['--no-proxy-server'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // 1. New session, default profile, first message: no pending chip.
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 20_000 });
  await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });
  await page.fill('textarea', 'First message in a brand-new conversation.');
  await page.press('textarea', 'Enter');
  await page.waitForSelector('textarea[data-composer]', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  const shots = [await chipGone(page, 'first-message-no-chip')];
  // 2. Switch profile explicitly: the chip must appear.
  await page.locator('#composer-profile-select').click();
  await page.waitForTimeout(800);
  const rows = await page.locator('[data-execution-profile]').allTextContents();
  const html = await page.locator('[data-execution-panel]').innerHTML().catch(() => '(no panel)');
  console.log('profile rows:', JSON.stringify(rows));
  console.log('panel html:', html.slice(0, 900));
  const reviewer = page.locator('[data-execution-profile="claude-reviewer"]');
  await reviewer.first().click();
  const confirm = page.locator('[role="alertdialog"] button', { hasText: 'Switch' }).first();
  if (await confirm.count() > 0) await confirm.click();
  await page.waitForSelector('#composer-profile-select[data-execution-pending="true"]', { timeout: 10_000 });
  shots.push(await shot(page, 'after-switch-chip-visible'));
  console.log(JSON.stringify({ shots }, null, 2));
} finally {
  await browser.close();
}
