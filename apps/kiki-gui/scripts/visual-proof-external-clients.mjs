/**
 * Visual proof for the 0.3.3 external client surfaces: the Settings page and
 * the externally driven session, against the `external-clients` fixture.
 *
 * Both halves of the feature are shot, because the contract is that they read
 * as one product: a client is authorized in Settings, and its work appears in
 * the ordinary session list with the source marked and no model invented.
 *
 *   node scripts/visual-proof-external-clients.mjs
 *   node scripts/visual-proof-external-clients.mjs --only=xc-session
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const settle = (page) => page.waitForTimeout(600);

async function openSettingsPanel({ page, shot, link }) {
  await page.goto(link('/settings/external-clients'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-external-clients]', { timeout: 30_000 });
  await page.waitForSelector('[data-xc-row]', { timeout: 30_000 });
  await settle(page);
  await shot('xc-settings');

  // The expanded row is where the grant facts live, so it has to be looked at
  // rather than inferred from the collapsed summary.
  await page.locator('[data-xc-row="conn_chatgpt"] summary').click();
  await page.waitForSelector('[data-xc-row="conn_chatgpt"][open]', { timeout: 15_000 });
  await settle(page);
  await shot('xc-settings-row-open');

  // The paused row, whose command grant is on: the warning has to read as
  // words, not as a coloured dot.
  await page.locator('[data-xc-row="conn_desktop"] summary').click();
  await page.waitForSelector('[data-xc-paused]', { timeout: 15_000 });
  await settle(page);
  await shot('xc-settings-paused-command');

  // Narrow viewport: the fact labels stack, and nothing overflows sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Narrowing the access policy stops this connection's in-flight work, so the
  // confirmation has to be looked at, not just asserted in a unit test.
  await page.locator('[data-xc-row="conn_chatgpt"] [data-xc-edit]').click();
  await page.waitForSelector('[data-xc-mode="yolo"]', { timeout: 15_000 });
  await page.locator('[data-xc-mode="yolo"]').click();
  await page.locator('[data-xc-row="conn_chatgpt"] [data-xc-save]').click();
  await page.waitForSelector('[data-confirm-action="confirm"]', { timeout: 15_000 });
  await settle(page);
  await shot('xc-policy-confirm');
  await page.keyboard.press('Escape');
  await page.locator('[data-xc-row="conn_chatgpt"] [data-xc-cancel]').click();
  await settle(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#st-card-external-clients').scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('External clients page overflows the 390px viewport');
  await settle(page);
  await shot('xc-settings-390');
}

async function openCreateFlow({ page, shot, link }) {
  await page.goto(link('/settings/external-clients'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-xc-row]', { timeout: 30_000 });
  await page.locator('[data-xc-add]').first().click();
  await page.waitForSelector('[data-xc-create]', { timeout: 15_000 });
  await settle(page);
  await shot('xc-settings-create');
}

async function openListener({ page, shot, link }) {
  await page.goto(link('/settings/external-clients'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-xc-listener]', { timeout: 30_000 });
  await page.locator('[data-xc-listener]').scrollIntoViewIfNeeded();
  await settle(page);
  await shot('xc-settings-listener');
}

async function openSession({ page, shot, link }) {
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const row = page.locator('[data-session-row="session_fixture_external_client"]').first();
  await row.waitFor({ timeout: 30_000 });
  // The source tag must be on the row before it is opened, so this is where
  // the sidebar half of the contract is checked.
  await shot('xc-session-list');
  await row.click();
  await page.waitForSelector('[data-xs-mark]', { timeout: 30_000 });
  await settle(page);
  await shot('xc-session');
  // The note composer is the page's main control on a narrow screen, so it
  // has to be looked at there rather than assumed to reflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-xs-note]').scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('Externally driven session overflows the 390px viewport');
  await settle(page);
  await shot('xc-session-390');
}

async function openContinue({ page, shot, link }) {
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const row = page.locator('[data-session-row="session_fixture_external_client"]').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForSelector('[data-xs-composer]', { timeout: 30_000 });
  // The branch preview reads the server's bounded material list; a partial one
  // must say so instead of looking like the whole story.
  await page.locator('[data-xs-continue-disclosure] > summary').click();
  await page.waitForSelector('[data-xs-continue-materials]', { timeout: 15_000 });
  await settle(page);
  await page.locator('[data-xs-continue-materials]').scrollIntoViewIfNeeded();
  await settle(page);
  await shot('xc-continue-materials');
}

async function openRail({ page, shot, link }) {
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const row = page.locator('[data-session-row="session_fixture_external_client"]').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForSelector('[data-rail-profile-head]', { timeout: 30_000 });
  await settle(page);
  await shot('xc-rail-external');
}

async function openEntry({ page, shot, link }) {
  await page.goto(link('/settings/ai?tab=providers'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-external-clients-entry]', { timeout: 30_000 });
  await page.locator('[data-external-clients-entry]').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const el = document.querySelector('[data-external-clients-entry]');
    el?.closest('[data-settings-scroll]')?.scrollBy(0, -40);
  });
  await settle(page);
  await shot('xc-engines-entry');
}

async function openSessionMark({ page, shot, link }) {
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const row = page.locator('[data-session-row="session_fixture_external_client"]').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForSelector('[data-xs-mark]', { timeout: 30_000 });
  await page.locator('[data-xs-mark]').click();
  await page.waitForSelector('[data-xs-mark-panel]', { timeout: 15_000 });
  await settle(page);
  await shot('xc-session-mark-open');
}

async function openSavedRecord({ page, shot, link }) {
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const row = page.locator('[data-session-row="session_fixture_external_client"]').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  const record = page.locator('[data-xs-external-text]').first();
  await record.waitFor({ timeout: 30_000 });
  await record.locator('[data-xs-external-text-toggle]').click();
  await page.waitForSelector('[data-xs-external-text-body]', { timeout: 15_000 });
  await settle(page);
  await shot('xc-saved-record-open');
}

const scenarios = [
  { name: 'xc-settings', fixture: 'external-clients', matrix: ['width'], run: openSettingsPanel },
  { name: 'xc-create', fixture: 'external-clients', run: openCreateFlow },
  { name: 'xc-listener', fixture: 'external-clients', run: openListener },
  { name: 'xc-session', fixture: 'external-clients', matrix: ['width'], run: openSession },
  { name: 'xc-continue', fixture: 'external-clients', run: openContinue },
  { name: 'xc-rail', fixture: 'external-clients', run: openRail },
  { name: 'xc-entry', fixture: 'external-clients', run: openEntry },
  { name: 'xc-session-mark', fixture: 'external-clients', run: openSessionMark },
  { name: 'xc-saved-record', fixture: 'external-clients', run: openSavedRecord },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'external-clients-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
