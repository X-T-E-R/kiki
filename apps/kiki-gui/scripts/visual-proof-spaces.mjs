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

/**
 * The proof runs in every locale the runner asks for, so text assertions follow
 * `lang` rather than assuming English. Numbers and data attributes never do.
 */
const L = {
  setHere: { en: 'set here', zh: '项在本空间固定' },
  follows: { en: 'Follows the main space', zh: '跟随主空间' },
  pushTitle: { en: 'Use these changes for the main space', zh: '把改动用于主空间' },
  mainNow: { en: 'Main space now', zh: '主空间现在' },
  pushConfirm: { en: 'Update the main space and follow', zh: '更新主空间并跟随' },
  // The titles this interface already had for the settings it can name: a known
  // row must never fall back to the server's English name.
  defaultModel: { en: 'Default model', zh: '默认模型' },
  theme: { en: 'Theme', zh: '主题' },
  skin: { en: 'Skin', zh: '皮肤' },
  // The row label the appearance page already uses for the prose role, and the
  // card text beside the appearance packs link.
  prose: { en: 'Assistant replies', zh: '助手回复' },
  packs: { en: 'Open appearance packs', zh: '打开外观包' },
  deviceOnly: { en: 'saved on this device', zh: '保存在这台设备上了' },
};

/** A 1×1 PNG: the media check reads its first bytes and accepts it as a picture. */
const LOCAL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPQS2/5DwAD+QIZKe2MDwAAAABJRU5ErkJggg==', 'base64');

async function language(page) {
  return (await page.getAttribute('html', 'lang') ?? 'en').startsWith('zh') ? 'zh' : 'en';
}

/**
 * Main-tree boot convention: the connection travels in the URL (`server`, `token`)
 * even in desktop mode, with the shell mock layered on top of it.
 */
function deepLink(webUrl, fixtureUrl, path, hash = '') {
  const joiner = path.includes('?') ? '&' : '?';
  return `${webUrl}${path}${joiner}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}${hash === '' ? '' : `#${hash}`}`;
}

async function boot({ page, webUrl, fixtureUrl }, windowMode = 'switch', spaces = SPACES) {
  await page.context().addInitScript(spaceDesktopMock, { fixtureUrl, token: FIXTURE_TOKEN, spaces, windowMode });
  await page.goto(deepLink(webUrl, fixtureUrl, '/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
}

/**
 * Boot straight into one space. The switcher's own navigation is another
 * slice's flow (and its own tests), so the evidence for this slice's surfaces
 * starts where the window already is the space it configures.
 */
async function bootAt({ page, webUrl, fixtureUrl, control }, homeId, spaces = SPACES) {
  await page.context().addInitScript(spaceDesktopMock, { fixtureUrl, token: FIXTURE_TOKEN, spaces, windowMode: 'switch' });
  await page.addInitScript((id) => { sessionStorage.setItem('kiki.proof.activeSpace', id); }, homeId);
  // The fixture serves the config of whichever backend is active, so the space
  // has to be active on both sides: the desktop's own `switch_space` does this
  // call when it opens a window, and the storage boot alone would leave the
  // server still answering for the main space.
  await control({ action: 'space', id: homeId });
  await page.goto(deepLink(webUrl, fixtureUrl, '/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
}

async function openSettings(page, webUrl, fixtureUrl, selector = '[data-space-list]') {
  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/spaces'), { waitUntil: 'domcontentloaded' });
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


// Failure evidence for this finite navigation walk only. No tokens, URL query,
// connection configs, or snapshots are copied into the trace.
async function logSpaceNavigation(context, label) {
  const { page, fixtureUrl } = context;
  const browser = await page.evaluate(() => {
    const identity = (meta) => ({ serverHomeId: meta?.server_home_id, currentSpaceId: meta?.current_space_id });
    const values = [];
    const root = document.querySelector('#root');
    const container = root?.[Object.keys(root).find((key) => key.startsWith('__reactContainer$'))];
    const visit = (fiber, count = { n: 0 }) => {
      if (!fiber || count.n++ > 2000) return;
      const value = fiber.memoizedProps?.value;
      if (value?.needsScopeReload !== undefined) values.push({ connection: { needsScopeReload: value.needsScopeReload,
        scopeId: value.scopeId, meta: identity(value.meta) } });
      if (value?.state?.phase !== undefined && typeof value.retry === 'function') {
        const refs = [];
        for (let hook = fiber.return?.memoizedState; hook; hook = hook.next) {
          const current = hook.memoizedState?.current;
          if (current?.scope && typeof current.route === 'string') refs.push({ route: current.route, scope: current.scope });
        }
        values.push({ boundary: { state: value.state, acceptedDestinations: refs } });
      }
      visit(fiber.child, count); visit(fiber.sibling, count);
    };
    visit(container?.stateNode?.current);
    const state = window.history.state;
    return { path: window.location.pathname, history: { idx: state?.idx, key: state?.key, nav: state?.usr?.kikiNav },
      nativeHome: sessionStorage.getItem('kiki.proof.activeSpace'),
      navigation: JSON.parse(sessionStorage.getItem('kiki.proof.activeSpace.navigation') ?? '[]'),
      dom: { ready: document.readyState, switchers: document.querySelectorAll('[data-space-switcher]').length,
        rootTextLength: root?.textContent?.length, rootChildren: root?.childElementCount }, values };
  });
  const response = await fetch(`${fixtureUrl}/api/meta`, { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } });
  const meta = (await response.json()).data;
  console.log(`[spaces-nav-trace] ${label} ${JSON.stringify({ browser,
    backend: { status: response.status, serverHomeId: meta?.server_home_id, currentSpaceId: meta?.current_space_id } })}`);
}

/** The acceptance walk: create → listed → switch → badges → restore → back. */
async function walk(context) {
  const { page, view, webUrl, fixtureUrl, shot, control } = context;
  if (process.env.KIKI_SPACES_WALK_NAV_ONLY === '1') page.on('response', (response) => {
    if (response.status() >= 400) console.log(`[spaces-nav-http] ${response.status()} ${new URL(response.url()).pathname}`);
  });
  await boot(context);
  const lang = await language(page);
  await openSettings(page, webUrl, fixtureUrl);
  await shot('spaces-list-main');

  await page.click('[data-space-new]');
  await page.waitForSelector('[data-space-create]');
  await page.fill('[data-space-name]', 'Client B');
  await page.click('[data-space-color="#4c64a9"]');
  await page.click('[data-space-inherit-credentials="isolated"]');
  // The first screen carries only the answer that changes what this space is
  // (shared or isolated accounts); the rest is one closed disclosure.
  expect(await page.locator('[data-space-inherit-row="credentials"]').isVisible() === true, 'credentials shares or isolates accounts and stays on the first screen');
  expect(await page.locator('[data-space-inherit-row="plugins"]').count() === 1, 'the other inheritance rows are still offered');
  expect(await page.locator('[data-space-inherit-row="plugins"]').isVisible() === false, 'a cold row is folded away by default');
  await shot('spaces-create');
  // Opened, the disclosure holds the same rows and the always-separate note.
  await page.click('[data-space-inherit-more] summary');
  await page.waitForSelector('[data-space-inherit-row="plugins"]', { state: 'visible' });
  expect(await page.locator('[data-space-inherit-row="credentials"]').isVisible() === true, 'credentials stays on the first screen while the rest is open');
  await shot('spaces-create-inherit-open');
  // Create-and-open enters a space with no remembered page yet.
  const create = await page.evaluate(() => document.querySelector('[data-space-path]')?.value);
  expect(typeof create === 'string' && create.endsWith('client-b'), `suggested path ${create}`);
  if (process.env.KIKI_SPACES_WALK_NAV_ONLY === '1') await logSpaceNavigation(context, 'before-create');
  await page.click('[data-space-create-submit]');
  try { await waitReload(page, '[data-space-switcher]'); }
  catch (error) {
    if (process.env.KIKI_SPACES_WALK_NAV_ONLY === '1') await logSpaceNavigation(context, 'create-failed');
    throw error;
  }
  expect(new URL(page.url()).pathname === '/new', 'a new space must open its own start page');
  const state = (await control({ action: 'space_state' })).data;
  const created = state.items.find((item) => item.name === 'Client B');
  expect(created !== undefined && created.credentials === 'isolated', 'Client B was not created as isolated');
  if (process.env.KIKI_SPACES_WALK_NAV_ONLY === '1') {
    const active = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_active_space'));
    const meta = (await (await fetch(`${fixtureUrl}/api/meta`, { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } })).json()).data;
    expect(active.homeId === created.id && active.name === 'Client B' && active.credentialsShared === false, `created desktop identity ${JSON.stringify(active)}`);
    expect(meta.current_space_id === created.id && state.active === created.id, `created backend identity ${JSON.stringify(meta)}`);
    expect(await page.locator(`[data-space-switcher="${created.id}"]`).count() === 1, 'created space must own the sidebar identity');
    console.log(`[spaces-nav] entered ${JSON.stringify({ path: new URL(page.url()).pathname, desktop: active, currentSpaceId: meta.current_space_id })}`);
    await shot('spaces-created-new');
  }
  // Create-and-open reloaded into the new space (desktop): its band is up.
  await openSettings(page, webUrl, fixtureUrl, '[data-settings-space-band]');
  expect((await page.textContent('[data-settings-space-band]'))?.includes('Client B') === true, 'band does not name the new space');
  if (process.env.KIKI_SPACES_WALK_NAV_ONLY === '1') {
    await shot('spaces-created-band');
    await openSidebar(page, view.width);
    await page.click('[data-space-switcher]');
    await page.waitForSelector('[data-space-switcher-menu]');
    await page.click('[data-space-switch-item="main"]');
    await waitReload(page, '[data-space-switcher="main"]');
    const active = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_active_space'));
    const meta = (await (await fetch(`${fixtureUrl}/api/meta`, { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } })).json()).data;
    expect(active.homeId === 'main' && meta.current_space_id === 'main', `returned main identity ${JSON.stringify({ active, meta })}`);
    expect(await page.locator('[data-settings-space-band]').count() === 0, 'main space must not show the band');
    const commands = await page.evaluate(() => JSON.parse(sessionStorage.getItem('kiki.proof.activeSpace.commands') ?? '[]'));
    const navigation = commands.filter((call) => ['prepare_space', 'switch_space', 'open_space'].includes(call.command));
    expect(JSON.stringify(navigation) === JSON.stringify([
      { command: 'prepare_space', homeId: created.id }, { command: 'switch_space', homeId: created.id },
      { command: 'prepare_space', homeId: 'main' }, { command: 'switch_space', homeId: 'main' },
    ]), `staged navigation commands ${JSON.stringify(navigation)}`);
    console.log(`[spaces-nav] returned ${JSON.stringify({ path: new URL(page.url()).pathname, desktop: active, currentSpaceId: meta.current_space_id, navigation })}`);
    await shot('spaces-returned-main');
    return;
  }

  // Into ACME from the sidebar switcher.
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await page.click(`[data-space-switch-item="${SPACE_ACME}"]`);
  await waitReload(page, `[data-space-switcher="${SPACE_ACME}"]`);
  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/ai?tab=defaults'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-default-origin="new-session"] [data-origin="home"]', { timeout: 20_000 });
  expect(await page.locator('[data-default-origin="fast"] [data-origin="base"]').count() === 1, 'fast model should read inherited');
  await shot('spaces-origins');

  // Restore inheritance is a planned space change like any other: the panel
  // names the setting in this interface's own words, opening it writes
  // nothing, and cancelling writes nothing either.
  await page.click('[data-default-origin="new-session"] [data-origin-restore]');
  await page.waitForSelector('[data-space-change-dialog="follow"]');
  // The panel opens before the server's list arrives, so the row is what says
  // the plan is here.
  await page.waitForSelector('[data-space-change-rows] [data-space-change-row]', { timeout: 20_000 });
  const planText = await page.textContent('[data-space-change-dialog]');
  expect(planText?.includes(L.defaultModel[lang]) === true, `restore plan names the setting: ${planText}`);
  await shot('spaces-origins-plan');
  await page.click('[data-space-change-cancel]');
  await page.waitForSelector('[data-space-change-dialog]', { state: 'detached' });
  const quiet = (await control({ action: 'space_state' })).data.log;
  expect(quiet.some((entry) => entry.spaceSettings !== undefined) === false, 'a cancelled restore must not apply');
  expect(quiet.some((entry) => entry.removeOverride !== undefined) === false, 'restore must not delete the key on its own');

  // Confirming follows the main space's value, and the mark reads it back from
  // the server rather than from what the button did.
  await page.click('[data-default-origin="new-session"] [data-origin-restore]');
  await page.waitForSelector('[data-space-change-dialog]');
  await page.click('[data-space-change-apply]');
  await page.waitForSelector('[data-default-origin="new-session"] [data-origin="base"]', { timeout: 10_000 });
  const log = (await control({ action: 'space_state' })).data.log;
  const restored = log.filter((entry) => entry.spaceSettings !== undefined);
  expect(restored.length === 1 && restored[0].spaceSettings.action === 'follow'
    && restored[0].spaceSettings.selected.includes('config:default_model'), `restore plan ${JSON.stringify(restored)}`);
  expect(log.some((entry) => entry.removeOverride !== undefined) === false, 'restore must not delete the config key by itself');
  await shot('spaces-origins-restored');

  // The space's own Spaces page: its settings detail and its accounts card.
  await openSettings(page, webUrl, fixtureUrl, '[data-space-settings]');
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
  const { page, view, webUrl, fixtureUrl, shot, control } = context;
  await boot(context);
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await checkTrigger(page, `multi-open ${view.width}`);
  await shot('spaces-switcher');
  await page.keyboard.press('Escape');

  await openSettings(page, webUrl, fixtureUrl);
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
  const { page, view, webUrl, fixtureUrl, shot } = context;
  await boot(context, 'windows');
  await openSettings(page, webUrl, fixtureUrl);
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

/** Space settings: the row menu opens a detail, a group change previews, cancels, applies. */
async function settings(context) {
  const { page, view, webUrl, fixtureUrl, shot, control } = context;
  await boot(context);
  await openSettings(page, webUrl, fixtureUrl);
  const lang = await language(page);

  await page.click(`[data-space-menu="${SPACE_ACME}"]`);
  await page.waitForSelector('[data-space-row-menu]');
  await shot('spaces-row-menu-settings');
  await page.click('[data-space-menu-item="settings"]');
  await page.waitForSelector('[data-space-settings]');
  await page.waitForSelector('[data-space-group-summary="appearance"]');
  // Real state, not a guess: ACME changed the theme and the skin here.
  const appearance = await page.textContent('[data-space-group-summary="appearance"]');
  expect(appearance?.includes(`2 ${L.setHere[lang]}`) === true, `appearance summary: ${appearance}`);
  expect(await page.locator('[data-space-change]').count() >= 8, 'every group offers a change');
  await shot('spaces-settings-detail');

  // Preview: the real differences between this space and the main space, the
  // equal ones folded away, and the line for what the main space adds later.
  // Equal values are still worth switching: their mode changes from fixed back
  // to following, which is why they count.
  await page.click('[data-space-change="config"]');
  await page.waitForSelector('[data-space-change-dialog]');
  await shot('spaces-settings-preview');
  const changedRows = await page.locator('[data-space-change-rows] [data-space-change-row]').count();
  expect(changedRows === 2, `config differences: ${changedRows}`);
  await page.click('[data-space-change-same-toggle]');
  const sameRows = await page.locator('[data-space-change-same-rows] [data-space-change-row]').count();
  expect(sameRows === 3, `config equal rows: ${sameRows}`);
  expect(await page.locator('[data-space-change-group-rows] [data-space-change-row]').count() === 1, 'the future-items line');
  await shot('spaces-settings-preview-expanded');

  // Taking one row out of this change keeps its value and its mode, and the
  // button counts what is really left.
  await page.click('[data-space-change-rows] [data-space-change-row] input');
  expect(await page.locator('[data-space-change-rows] [data-space-change-state="off"]').count() === 1, 'the dropped row stays visible');
  const afterDrop = await page.textContent('[data-space-change-apply]');
  expect(afterDrop?.includes('4') === true, `button after dropping one row: ${afterDrop}`);
  await page.click('[data-space-change-rows] [data-space-change-row] input');
  expect((await page.textContent('[data-space-change-apply]'))?.includes('5') === true, 'the row counts again');

  // The default-selection line is a choice of its own; dropping it leaves the
  // five items to change.
  await page.click('[data-space-change-group-rows] [data-space-change-row] input');
  await page.click('[data-space-change-apply]');
  await page.waitForSelector('[data-space-change-dialog]', { state: 'detached' });
  const applied = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings !== undefined);
  expect(applied.length === 1 && applied[0].spaceSettings.selected.length === 5, `apply ${JSON.stringify(applied)}`);
  expect(applied[0].spaceSettings.selected.includes('group:config') === false, 'the dropped line is not sent');
  await page.waitForSelector('[data-space-undo]');
  const followed = await page.textContent('[data-space-group-summary="config"]');
  expect(followed?.includes(L.follows[lang]) === true && followed.includes(L.setHere[lang]) === false, `config summary after the change: ${followed}`);
  await shot('spaces-settings-followed');

  // Nothing selected is not a submission: the button waits.
  await page.click('[data-space-change="plugins"]');
  await page.waitForSelector('[data-space-change-dialog]');
  await page.waitForSelector('[data-space-change-group-rows] [data-space-change-row]');
  const sameToggle = page.locator('[data-space-change-same-toggle]');
  if (await sameToggle.count() === 1) await sameToggle.click();
  const boxes = page.locator('[data-space-change-dialog] input[type="checkbox"]:not([disabled])');
  const boxCount = await boxes.count();
  expect(boxCount >= 1, 'the plugins plan has rows');
  for (let index = 0; index < boxCount; index += 1) {
    const box = boxes.nth(index);
    if (await box.isChecked()) await box.click();
  }
  expect(await page.locator('[data-space-change-apply][disabled]').count() === 1, 'an empty change cannot be sent');
  await page.click('[data-space-change-cancel]');
  await page.waitForSelector('[data-space-change-dialog]', { state: 'detached' });
  const quiet = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings !== undefined);
  expect(quiet.length === 1, `a cancelled preview must not apply: ${quiet.length}`);

  // Undo belongs to the last real change and puts the summary back.
  await page.click('[data-space-undo]');
  await page.waitForSelector('[data-space-undo]', { state: 'detached' });
  await page.waitForTimeout(300);
  const undone = await page.textContent('[data-space-group-summary="config"]');
  expect(undone?.includes(`3 ${L.setHere[lang]}`) === true, `config summary after undo: ${undone}`);
  await shot('spaces-settings-undone');
}

/** Inside a space: its own detail, the origin marks, and the device's older look. */
async function subspaceSettings(context) {
  const { page, view, webUrl, fixtureUrl, shot, control } = context;
  // This device already had a light look; ACME carries a dark one.
  await page.context().addInitScript(() => { localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' })); });
  await boot(context);
  const lang = await language(page);
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await page.click(`[data-space-switch-item="${SPACE_ACME}"]`);
  await waitReload(page, `[data-space-switcher="${SPACE_ACME}"]`);

  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/spaces'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-space-settings]');
  await page.waitForSelector('[data-space-own-choices]');
  await page.locator('[data-space-settings]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  // The space's own theme, so this is the flat detail as that space looks.
  expect(await page.evaluate(() => document.documentElement.dataset['theme']) === 'dark', 'the space theme must win on its own page too');
  const ownTheme = await page.textContent('[data-space-own-item="pref:theme"]');
  expect(ownTheme?.includes(L.theme[lang]) === true, `own choice name: ${ownTheme}`);
  await shot('spaces-sub-detail-first');

  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/appearance'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pref-origin="theme-fixed"]');
  // The space's own theme is what renders, not this device's stored one.
  expect(await page.evaluate(() => document.documentElement.dataset['theme']) === 'dark', 'the space theme must win');
  await shot('spaces-origin-marks');

  // Following a value that differs opens the shared list; applying it makes the
  // space use the main space's theme and keep following it.
  await page.click('[data-pref-origin-menu="theme"]');
  await page.waitForSelector('[data-space-row-menu]');
  await shot('spaces-origin-menu');
  await page.click('[data-space-menu-item="follow"]');
  await page.waitForSelector('[data-space-change-dialog]');
  // A setting this interface has a title for is named in this locale, never in
  // the server's English.
  const themePlan = await page.textContent('[data-space-change-dialog]');
  expect(themePlan?.includes(L.theme[lang]) === true, `follow plan names the setting: ${themePlan}`);
  await shot('spaces-origin-dialog');
  expect(await page.locator('[data-space-change-push]').count() === 1, 'a child space offers the main-space path');
  await page.click('[data-space-change-apply]');
  await page.waitForSelector('[data-space-change-dialog]', { state: 'detached' });
  await page.waitForSelector('[data-pref-origin="theme-follow"]');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.dataset['theme']) === 'light', 'the main space theme now renders');
  await shot('spaces-origin-followed');
  const follows = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings?.action === 'follow');
  expect(follows.length === 1, `a follow applied: ${follows.length}`);

  // Fixing an item that already holds the main space's value needs no list to
  // read: it completes on its own.
  await page.click('[data-pref-origin-menu="proseFont"]');
  await page.waitForSelector('[data-space-row-menu]');
  await page.click('[data-space-menu-item="fixed"]');
  await page.waitForSelector('[data-pref-origin="proseFont-fixed"]');
  expect(await page.locator('[data-space-change-dialog]').count() === 0, 'a same-value fix completes without a list');
  const fixed = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings?.action === 'fixed');
  expect(fixed.length === 1, `a same-value fix applied: ${fixed.length}`);

  // The main-space path is its own step in the same panel, named for what it
  // does — not a side effect of following.
  await page.click('[data-pref-origin-menu="skin"]');
  await page.waitForSelector('[data-space-row-menu]');
  await page.click('[data-space-menu-item="follow"]');
  await page.waitForSelector('[data-space-change-dialog]');
  await page.click('[data-space-change-push]');
  await page.waitForSelector('[data-space-change-back]');
  await page.waitForSelector('[data-space-change-rows][data-space-plan="push-to-main"] [data-space-change-row]');
  const pushText = await page.textContent('[data-space-change-dialog]');
  expect(pushText?.includes(L.pushTitle[lang]) === true, `push title: ${pushText}`);
  expect(pushText?.includes(L.mainNow[lang]) === true, 'the values shown are the main space’s');
  expect((await page.textContent('[data-space-change-apply]'))?.includes(L.pushConfirm[lang]) === true, 'the last button names the destination');
  await shot('spaces-origin-push');
  await page.click('[data-space-change-back]');
  await page.waitForSelector('[data-space-change-push]');

  // Cancelling the list writes nothing.
  await page.click('[data-space-change-cancel]');
  await page.waitForSelector('[data-space-change-dialog]', { state: 'detached' });
  const applies = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings !== undefined);
  expect(applies.length === 2, `a cancelled list must not apply: ${applies.length}`);

  // A picture that only exists on this device cannot travel with the space. It
  // stays here, with the way out beside it: the appearance packs. Choosing a
  // pack's own picture is a real space change — that is when one is written.
  await page.setInputFiles('[data-bg-file]', { name: 'tide-local.png', mimeType: 'image/png', buffer: LOCAL_PNG });
  await page.waitForSelector('[data-pref-origin-packs]', { timeout: 10_000 });
  const deviceNote = await page.evaluate(() => document.querySelector('[data-pref-origin-packs]')?.parentElement?.textContent ?? '');
  expect(deviceNote.includes(L.deviceOnly[lang]) === true, `device-only note: ${deviceNote}`);
  const staysLocal = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings !== undefined);
  expect(staysLocal.length === 2, `a device-only picture must not be sent as a space value: ${staysLocal.length}`);
  // The note sits with the background card's own source mark, so the card has
  // to be in view for the shot to show what the person sees.
  await page.locator('[data-pref-origin-packs]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot('spaces-origin-device-only');

  await page.click('[data-pref-origin-packs]');
  await page.waitForSelector('[data-pack-use="dusk-harbor"]', { timeout: 30_000 });
  await page.locator('[data-pack-use="dusk-harbor"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('spaces-origin-packs');
  await page.click('[data-pack-use="dusk-harbor"]');
  await page.waitForSelector('[data-pack-use="dusk-harbor"][aria-pressed="true"]', { timeout: 10_000 });
  // The skin and the picture are two writes in flight together, so the log is
  // read until the picture's own write has landed rather than once.
  const carried = async () => (await control({ action: 'space_state' })).data.log
    .filter((entry) => entry.spaceSettings?.selected?.includes('pref:background') === true);
  for (let attempt = 0; attempt < 20 && (await carried()).length === 0; attempt += 1) await page.waitForTimeout(150);
  expect((await carried()).length >= 1, `using a pack must write the background to the space: ${JSON.stringify(await carried())}`);
  await page.waitForSelector('[data-pref-origin-packs]', { state: 'detached', timeout: 10_000 });
  await shot('spaces-origin-pack-used');

  // This device's own look is offered on the space page, never applied silently.
  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/spaces'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-space-settings]');
  await page.waitForSelector('[data-space-own-choices]');
  await page.locator('[data-space-settings]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('spaces-sub-detail');
  if (await page.locator('[data-space-device-conflict]').count() === 1) {
    await shot('spaces-device-conflict');
    await page.click('[data-space-device-keep]');
    await page.waitForSelector('[data-space-device-conflict]', { state: 'detached' });
  }
}

/** The in-place restore route: plan, cancel with nothing written, apply, read back. */
async function followRoute(context) {
  const { page, webUrl, fixtureUrl, shot, control } = context;
  await bootAt(context, SPACE_ACME);
  const lang = await language(page);
  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/ai?tab=defaults'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-default-origin="new-session"] [data-origin="home"]', { timeout: 20_000 });
  expect(await page.locator('[data-default-origin="fast"] [data-origin="base"]').count() === 1, 'fast model should read inherited');
  await shot('spaces-follow-origin');

  await page.click('[data-default-origin="new-session"] [data-origin-restore]');
  await page.waitForSelector('[data-space-change-dialog="follow"]');
  await page.waitForSelector('[data-space-change-rows] [data-space-change-row]', { timeout: 20_000 });
  const planText = await page.textContent('[data-space-change-dialog]');
  expect(planText?.includes(L.defaultModel[lang]) === true, `follow plan names the setting: ${planText}`);
  await shot('spaces-follow-plan');

  // Cancelling writes nothing at all.
  const before = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings !== undefined);
  await page.click('[data-space-change-cancel]');
  await page.waitForSelector('[data-space-change-dialog]', { state: 'detached' });
  const after = (await control({ action: 'space_state' })).data.log.filter((entry) => entry.spaceSettings !== undefined);
  expect(after.length === before.length, 'a cancelled restore must not apply');
  expect((await control({ action: 'space_state' })).data.log.some((entry) => entry.removeOverride !== undefined) === false, 'restore must not delete the config key on its own');

  // Confirming follows the main space's value, and the mark reads it back.
  await page.click('[data-default-origin="new-session"] [data-origin-restore]');
  await page.waitForSelector('[data-space-change-rows] [data-space-change-row]', { timeout: 20_000 });
  await page.click('[data-space-change-apply]');
  await page.waitForSelector('[data-default-origin="new-session"] [data-origin="base"]', { timeout: 20_000 });
  const log = (await control({ action: 'space_state' })).data.log;
  const applied = log.filter((entry) => entry.spaceSettings !== undefined);
  expect(applied.length === 1 && applied[0].spaceSettings.action === 'follow'
    && applied[0].spaceSettings.selected.includes('config:default_model'), `restore plan ${JSON.stringify(applied)}`);
  expect(log.some((entry) => entry.removeOverride !== undefined) === false, 'restore must not delete the config key by itself');
  await shot('spaces-follow-restored');
}

/** The two copy states: the prose mark on its own row, and a device-only picture. */
async function copyFrames(context) {
  const { page, webUrl, fixtureUrl, shot } = context;
  const lang = await language(page);
  await bootAt(context, SPACE_ACME);
  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/appearance'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-font-role="prose"]');
  const prose = await page.textContent('[data-font-role="prose"]');
  expect(prose?.includes(L.prose[lang]) === true, `prose row label: ${prose}`);
  // The mark sits on the prose row itself rather than in a block of its own.
  expect(prose?.includes(L.follows[lang]) === true, `the prose row carries its own source mark: ${prose}`);
  await page.locator('[data-font-role="prose"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot('spaces-prose-origin');

  // A picture that only exists here is kept, and the card says what that means
  // for the space, with the way out beside it.
  await page.setInputFiles('[data-bg-file]', { name: 'tide-local.png', mimeType: 'image/png', buffer: LOCAL_PNG });
  await page.waitForSelector('[data-pref-origin-packs]', { timeout: 10_000 });
  const note = await page.evaluate(() => {
    const link = document.querySelector('[data-pref-origin-packs]');
    return { text: link?.parentElement?.textContent ?? '', href: link?.getAttribute('href') ?? '' };
  });
  expect(note.text.includes(L.deviceOnly[lang]) === true, `device-only note: ${note.text}`);
  // The way out sits beside the explanation: this picture can only travel
  // inside an appearance pack, and that page is one click away.
  expect(note.text.includes(L.packs[lang]) === true && note.href === '/settings/appearance', `pack link beside the note: ${JSON.stringify(note)}`);
  await page.locator('[data-pref-origin-packs]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot('spaces-bg-device-only');
}

const scenarios = [
  { name: 'spaces-walk', fixture: 'spaces', matrix: ['theme', 'width'], run: walk },
  { name: 'spaces-dialogs', fixture: 'spaces', matrix: ['theme', 'width'], run: dialogs },
  { name: 'spaces-settings', fixture: 'spaces', matrix: ['theme', 'width'], run: settings },
  { name: 'spaces-sub-settings', fixture: 'spaces', matrix: ['theme', 'width'], run: subspaceSettings },
  { name: 'spaces-single', fixture: 'spaces-single', matrix: ['theme', 'width'], run: single },
  { name: 'spaces-windows', fixture: 'spaces', matrix: ['theme'], run: windowsMode },
  { name: 'spaces-follow-route', fixture: 'spaces', matrix: [], run: followRoute },
  { name: 'spaces-copy-frames', fixture: 'spaces', matrix: ['width'], run: copyFrames },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'spaces-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
