/**
 * Visual proof for spaces (multi-home), on the shared runner with a desktop
 * shell mock (scripts/space-desktop-mock.mjs) over fixture `spaces`.
 *
 *   node scripts/visual-proof-spaces.mjs [--matrix=all] [--only=spaces-walk]
 *
 * Walk (asserted, not just captured): main space → Settings › Spaces list →
 * create a space (dialog shot) → it appears → switch into it (reload) →
 * the sidebar chip, the settings band, and the Defaults origin badges →
 * Restore inheritance flips the badge → back to the main space. Also shots
 * of the switcher menu, the credential dialog (with SSH hosts), the
 * restart-required result, and the typed-name delete confirmation.
 * Themes light/dark at 1440 and 390; shots under KIKI_PROOF_OUTPUT_DIR.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import { spaceDesktopMock } from './space-desktop-mock.mjs';
import { runProof } from '../proof/runner.mjs';
import { SPACE_ACME, SPACE_PAPER } from '../fixtures/spaces.scenario.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SPACES = [
  { id: 'main', path: 'C:\\Users\\fixture\\.kiki' },
  { id: SPACE_ACME, name: 'ACME confidential', color: '#0f766e', path: 'D:\\secure\\kiki-acme', hot: true, pending: 2, busy: 1 },
  { id: SPACE_PAPER, name: 'Thesis writing', color: '#7e22ce', path: 'C:\\Users\\fixture\\.kiki-spaces\\thesis-writing', credentials: 'isolated' },
];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function boot({ page, webUrl, fixtureUrl }, windowMode = 'switch', spaces = SPACES) {
  await page.context().addInitScript(spaceDesktopMock, { fixtureUrl, token: FIXTURE_TOKEN, spaces, windowMode });
  await page.goto(`${webUrl}/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
}

async function openSettings(page, webUrl, selector = '[data-space-list]') {
  await page.goto(`${webUrl}/settings/spaces`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page.waitForSelector('[data-space-row]', { timeout: 20_000 });
  await page.waitForTimeout(300);
}

async function waitReload(page, selector) {
  await page.waitForEvent('load', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/**
 * Layout checks for the wordmark trigger: it stays inside the header row, the
 * search and activity icons stay fully visible, a long space name truncates
 * instead of pushing them out, and an open menu fits the viewport.
 */
async function checkTrigger(page, label) {
  const report = await page.evaluate(() => {
    const box = (element) => element?.getBoundingClientRect() ?? null;
    const trigger = document.querySelector('[data-space-switcher]');
    const row = trigger?.closest('.h-12');
    const search = box(document.querySelector('[data-search-toggle]'));
    const bell = box(document.querySelector('[data-nav-activity]'));
    const name = document.querySelector('[data-space-switcher-name]');
    const menu = box(document.querySelector('[data-space-switcher-menu]'));
    return {
      trigger: box(trigger), row: box(row), search, bell,
      nameClipped: name === null ? null : name.scrollWidth > name.clientWidth,
      nameWidth: name?.clientWidth ?? null,
      menu, viewport: { width: window.innerWidth, height: window.innerHeight },
      focusOutline: document.activeElement === trigger ? getComputedStyle(trigger).outlineStyle : null,
      chevron: getComputedStyle(trigger.querySelector('svg:last-of-type')).color,
      nameColor: name === null ? null : getComputedStyle(name).color,
      surface: getComputedStyle(trigger.closest('[data-session-sidebar]') ?? document.body).backgroundColor,
    };
  });
  const { trigger, row, search, bell, menu, viewport } = report;
  expect(trigger !== null && row !== null, `${label}: trigger missing`);
  expect(trigger.left >= row.left - 0.5 && trigger.right <= search.left + 0.5, `${label}: trigger overlaps search (${trigger.right} > ${search.left})`);
  expect(bell.right <= row.right + 0.5 && search.width >= 28, `${label}: header icons pushed out`);
  if (menu !== null) {
    expect(menu.left >= 0 && menu.right <= viewport.width && menu.bottom <= viewport.height, `${label}: menu leaves the viewport`);
  }
  console.log(`[trigger] ${label} ${JSON.stringify({ w: Math.round(trigger.width), name: report.nameWidth, clipped: report.nameClipped, focus: report.focusOutline, chevron: report.chevron, text: report.nameColor, surface: report.surface })}`);
  return report;
}

async function openSidebar(page, width) {
  if (width >= 768) return;
  await page.click('button[aria-label]:has(svg[data-icon="menu"])');
  await page.waitForTimeout(400);
}


/** The acceptance walk: create → listed → switch → badges → restore → back. */
async function walk(context) {
  const { page, view, webUrl, shot, control } = context;
  await boot(context);
  await openSettings(page, webUrl);
  await shot('spaces-list-main');

  await page.click('[data-space-new]');
  await page.waitForSelector('[data-space-create]');
  await page.fill('[data-space-name]', 'Client B');
  await page.click('[data-space-color="#4c64a9"]');
  await page.click('[data-space-inherit-credentials="isolated"]');
  await shot('spaces-create');
  // Create-and-open enters a space with no remembered page yet.
  const create = await page.evaluate(() => document.querySelector('[data-space-path]')?.value);
  expect(typeof create === 'string' && create.endsWith('client-b'), `suggested path ${create}`);
  await page.click('[data-space-create-submit]');
  await waitReload(page, '[data-space-switcher]');
  expect(new URL(page.url()).pathname === '/new', 'a new space must open its own start page');
  const state = (await control({ action: 'space_state' })).data;
  const created = state.items.find((item) => item.name === 'Client B');
  expect(created !== undefined && created.credentials === 'isolated', 'Client B was not created as isolated');
  // Create-and-open reloaded into the new space (desktop): its band is up.
  await openSettings(page, webUrl, '[data-settings-space-band]');
  expect((await page.textContent('[data-settings-space-band]'))?.includes('Client B') === true, 'band does not name the new space');

  // Into ACME from the sidebar switcher.
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await page.click(`[data-space-switch-item="${SPACE_ACME}"]`);
  await waitReload(page, `[data-space-switcher="${SPACE_ACME}"]`);
  await page.goto(`${webUrl}/settings/ai?tab=defaults`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-default-origin="new-session"] [data-origin="home"]', { timeout: 20_000 });
  expect(await page.locator('[data-default-origin="fast"] [data-origin="base"]').count() === 1, 'fast model should read inherited');
  await shot('spaces-origins');
  await page.click('[data-default-origin="new-session"] [data-origin-restore]');
  await page.waitForSelector('[data-default-origin="new-session"] [data-origin="base"]', { timeout: 10_000 });
  const log = (await control({ action: 'space_state' })).data.log;
  expect(log.some((entry) => entry.removeOverride?.domain === 'default_model'), 'restore did not call removeOverride');
  await shot('spaces-origins-restored');

  // The space's own Spaces page: credentials card + remaining override.
  await openSettings(page, webUrl, '[data-space-overrides]');
  await shot('spaces-sub');

  // The wordmark menu from inside a space: no New space…, manage only.
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  expect(await page.locator('[data-space-new-entry]').count() === 0, 'a space must not offer New space…');
  await checkTrigger(page, `sub-open ${view.width}`);
  await shot('spaces-switcher-sub');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-space-switcher="${SPACE_ACME}"]`, { timeout: 30_000 });

  // Back to the main space.
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.click('[data-space-switch-item="main"]');
  await waitReload(page, '[data-space-switcher="main"]');
  expect(await page.locator('[data-settings-space-band]').count() === 0, 'main space must not show the band');
}

/** Switcher menu, credential switch (with SSH copy), restart-required, delete confirm. */
async function dialogs(context) {
  const { page, view, webUrl, shot, control } = context;
  await boot(context);
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await checkTrigger(page, `multi-open ${view.width}`);
  await shot('spaces-switcher');
  await page.keyboard.press('Escape');

  await openSettings(page, webUrl);
  await page.click(`[data-space-menu="${SPACE_ACME}"]`);
  await page.waitForSelector('[data-space-row-menu]');
  expect(await page.locator('[data-space-menu-item="delete"][disabled]').count() === 1, 'delete must be disabled while ACME runs');
  await shot('spaces-row-menu-blocked');
  await page.click('[data-space-menu-item="credentials"]');
  await page.waitForSelector('[data-space-copy-ssh-host="prod-db"]');
  await page.click('[data-space-copy-ssh-host="prod-db"]');
  await page.click('[data-space-copy-ssh-host="staging"]');
  await shot('spaces-credentials');
  await page.click('[data-space-credentials-confirm]');
  await page.waitForSelector('[data-space-restart-note]');
  const update = (await control({ action: 'space_state' })).data.log.find((entry) => entry.update !== undefined)?.update;
  expect(update?.body?.copy_ssh_credentials?.hosts?.length === 2, `copy hosts ${JSON.stringify(update)}`);
  await shot('spaces-restart-required');

  await page.click(`[data-space-menu="${SPACE_PAPER}"]`);
  await page.click('[data-space-menu-item="delete"]');
  await page.waitForSelector('[data-space-delete]');
  expect(await page.locator('[data-space-delete-confirm][disabled]').count() === 1, 'delete must wait for the typed name');
  await page.fill('[data-space-delete-input]', 'Thesis');
  await shot('spaces-delete-confirm');
  await page.fill('[data-space-delete-input]', 'Thesis writing');
  expect(await page.locator('[data-space-delete-confirm]:not([disabled])').count() === 1, 'exact name must enable delete');
  await page.click('[data-space-delete-confirm]');
  await page.waitForSelector(`[data-space-row="${SPACE_PAPER}"]`, { state: 'detached' });
}

/** Windows mode: the switcher offers "Open window", and the setting notes the next launch. */
async function windowsMode(context) {
  const { page, view, webUrl, shot } = context;
  await boot(context, 'windows');
  await openSettings(page, webUrl);
  await page.click('[data-space-window-choice="switch"]');
  await page.waitForSelector('[data-space-window-note] .text-amber-ink');
  await shot('spaces-window-pending');
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await shot('spaces-switcher-windows');
}

/** A single-home user: the wordmark is the only space UI, and it leads to create. */
async function single(context) {
  const { page, view, shot } = context;
  await boot(context, 'switch', [SPACES[0]]);
  await openSidebar(page, view.width);
  await page.waitForTimeout(300);
  expect(await page.locator('[data-space-switcher-name]').count() === 0, 'single home must not name a space');
  await checkTrigger(page, `single-closed ${view.width}`);
  await shot('spaces-single-closed');
  await page.focus('[data-space-switcher]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-space-switcher-menu] [data-space-new-entry]');
  await checkTrigger(page, `single-menu ${view.width}`);
  await shot('spaces-single-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-space-switcher')) === true, 'focus must return to the wordmark');
  expect((await checkTrigger(page, `single-focus ${view.width}`)).focusOutline === 'solid', 'focus ring missing');
  await shot('spaces-single-focus');
  await page.keyboard.press('Enter');
  await page.click('[data-space-new-entry]');
  await page.waitForSelector('[data-space-create]', { timeout: 20_000 });
  expect(!page.url().includes('new=1'), `create flag should be dropped: ${page.url()}`);
}

const scenarios = [
  { name: 'spaces-walk', fixture: 'spaces', matrix: ['theme', 'width'], run: walk },
  { name: 'spaces-dialogs', fixture: 'spaces', matrix: ['theme', 'width'], run: dialogs },
  { name: 'spaces-single', fixture: 'spaces-single', matrix: ['theme', 'width'], run: single },
  { name: 'spaces-windows', fixture: 'spaces', matrix: ['theme'], run: windowsMode },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'spaces-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
