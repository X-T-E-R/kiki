/** Focused main-tree N1 integration check. Canonical matrix remains n1-visual-proof.mjs in the N1 candidate. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACK_SELECTOR = 'button[aria-label^="Back"], button[aria-label^="返回"]';
const DIALOG = '[role="alertdialog"]';
function checks(label) {
  const failures = [];
  return {
    ok(id, condition, detail) {
      console.log(`[check] ${condition === true ? 'PASS' : 'FAIL'} ${label}/${id} — ${detail}`);
      if (condition !== true) failures.push(`${id}: ${detail}`);
    },
    summary() { if (failures.length) throw new Error(failures.join(' | ')); },
  };
}
async function navStore(page) {
  return page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('kiki.navHistory.v1') ?? 'null'); }
    catch { return null; }
  });
}
async function historyCursor(page) {
  return page.evaluate(() => ({ url: location.href, state: history.state }));
}
function backButtons(page) { return page.locator(BACK_SELECTOR); }
function expectedBackLabel(destination, locale) {
  const names = locale === 'zh' ? { settings: '设置', usage: '用量' } : { settings: 'Settings', usage: 'Usage' };
  return locale === 'zh' ? `返回到 ${names[destination]}` : `Back to ${names[destination]}`;
}
async function backArrows(page) {
  return page.locator('body').evaluateAll((roots, selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)])
    .filter((element) => element.offsetParent !== null)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label'), width: Math.round(rect.width), height: Math.round(rect.height) };
    }), BACK_SELECTOR);
}
async function scrollMetrics(page, selector) {
  return page.locator(selector).first().evaluate((element) => ({ top: Math.round(element.scrollTop), max: Math.round(element.scrollHeight - element.clientHeight) }));
}
async function wheelScroll(page, selector, deltaY) {
  await page.locator(selector).first().hover();
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(500);
  return scrollMetrics(page, selector);
}
async function pushViaSidebar(page, attribute) {
  const box = await page.locator('[data-nav-usage]').first().boundingBox();
  if ((box?.x ?? 0) < 0) {
    await page.locator('button[aria-label="Open session menu"], button[aria-label="打开会话菜单"]').first().click();
    await page.waitForTimeout(600);
  }
  await page.locator(`[${attribute}]:visible`).first().click();
}
async function gotoSettingsSection(page, section) {
  if (await page.locator(`[data-settings-nav-leaf="${section}"]:visible`).count() === 0) {
    await page.locator('[data-settings-nav-trigger]:visible').first().click();
    await page.waitForTimeout(500);
  }
  await page.locator(`[data-settings-nav-leaf="${section}"]:visible`).first().click();
  await page.waitForTimeout(700);
}
async function editAdvancedDraft(page) {
  const textarea = page.locator('#st-card-advanced textarea').first();
  await textarea.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ');
  await page.waitForTimeout(400);
  return {
    value: await textarea.evaluate((element) => element.value),
    cursor: await textarea.evaluate((element) => element.selectionStart),
    dirtyIndicator: await page.locator('[data-settings-unsaved]:visible').count(),
  };
}
function currentSnapshot(store) {
  const id = store?.entries?.[store.currentIndex]?.visitId;
  return store?.snapshots?.find((snapshot) => snapshot.visitId === id) ?? null;
}

// Targeted port of the N1 candidate's usageSnapshot and dirtyGuard acceptance checks.
async function usageSnapshot({ page, view, link, shot }) {
  const assert = checks(`usage-snapshot@${view.width}`);
  await page.goto(link('/settings/general'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-settings-page-title]', { timeout: 30_000 });
  await page.waitForTimeout(800);
  await gotoSettingsSection(page, 'developer');
  await page.waitForSelector('#st-card-advanced textarea', { timeout: 30_000 });
  await page.waitForTimeout(800);
  const settingsScroll = await wheelScroll(page, '[data-settings-scroll]', 100);
  const settingsArrowsCold = await backArrows(page);
  assert.ok('usage-0', settingsScroll.top > 0 && settingsArrowsCold.length === 1 && settingsArrowsCold[0].label === expectedBackLabel('settings', view.locale),
    `settings source: scroll=${settingsScroll.top} arrows=${JSON.stringify(settingsArrowsCold)}`);
  await pushViaSidebar(page, 'data-nav-usage');
  await page.waitForSelector('[data-usage-page]', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  const sourceArrows = await backArrows(page);
  assert.ok('usage-1', sourceArrows.length === 1 && sourceArrows[0].label === expectedBackLabel('settings', view.locale), JSON.stringify(sourceArrows));
  const beforePanel = await navStore(page);
  await page.locator('[data-usage-panel="history"]').first().click();
  await page.waitForSelector('[data-usage-trend]', { timeout: 30_000 });
  await page.waitForTimeout(1200);
  const afterPanel = await navStore(page);
  const panelArrows = await backArrows(page);
  assert.ok('order-4', afterPanel.entries.length === beforePanel.entries.length && panelArrows[0]?.label === expectedBackLabel('settings', view.locale),
    `panel entries ${beforePanel.entries.length}->${afterPanel.entries.length}`);
  const buckets = page.locator('[data-usage-trend] button[data-bucket]');
  const bucketCount = await buckets.count();
  assert.ok('usage-2a', bucketCount > 0, `buckets=${bucketCount}`);
  const bucket = buckets.nth(Math.max(0, bucketCount - 2));
  const bucketKey = await bucket.getAttribute('data-bucket');
  await bucket.click();
  await page.waitForTimeout(600);
  const drillSessions = await page.locator('[data-usage-drilldown-session]').count();
  const drilldownOpen = await page.locator('[data-usage-drilldown]').count();
  assert.ok('usage-2b', (await bucket.getAttribute('aria-pressed')) === 'true' && drilldownOpen > 0, `bucket=${bucketKey} drilldown=${drilldownOpen}`);
  const usageScroll = await wheelScroll(page, 'main[data-usage-scroll]', 300);
  assert.ok('usage-2c', usageScroll.top > 0, `usage scroll=${usageScroll.top}`);
  const stored = currentSnapshot(await navStore(page));
  assert.ok('usage-2c2', stored?.ui?.scrollTop === usageScroll.top && stored?.ui?.selectedBucketKey === bucketKey, `snapshot=${JSON.stringify(stored?.ui)}`);
  await shot('n1-usage-bucket-selected');
  const target = drillSessions > 0 ? page.locator('[data-usage-drilldown-session]').first() : page.locator('[data-usage-session]').first();
  await target.click();
  await page.waitForTimeout(1300);
  assert.ok('usage-2d', new URL(page.url()).pathname.startsWith('/s/'), `session=${page.url()}`);
  await page.goBack();
  await page.waitForTimeout(1500);
  const pressedKey = await page.locator('[data-usage-trend] button[data-bucket][aria-pressed="true"]').first().getAttribute('data-bucket').catch(() => null);
  const restoredDrilldown = await page.locator('[data-usage-drilldown]').count();
  const restoredScroll = await scrollMetrics(page, 'main[data-usage-scroll]');
  const restoredArrows = await backArrows(page);
  assert.ok('usage-2e', pressedKey === bucketKey && restoredDrilldown > 0, `selected=${pressedKey} expected=${bucketKey} drilldown=${restoredDrilldown}`);
  assert.ok('usage-2f', restoredScroll.top === usageScroll.top, `scroll=${restoredScroll.top} expected=${usageScroll.top}`);
  assert.ok('usage-2g', restoredArrows[0]?.label === expectedBackLabel('settings', view.locale), JSON.stringify(restoredArrows));
  await shot('n1-usage-returned-from-session');
  let clicks = 0;
  while (clicks < 4 && new URL(page.url()).pathname !== '/settings/developer') {
    if ((await backArrows(page)).length === 0) break;
    await backButtons(page).first().click();
    clicks += 1;
    await page.waitForTimeout(1100);
  }
  const settingsAfterUsage = await scrollMetrics(page, '[data-settings-scroll]');
  const settingsLeaf = await page.locator('[data-settings-nav-leaf][aria-current="page"]').first().getAttribute('data-settings-nav-leaf').catch(() => null);
  assert.ok('usage-3', new URL(page.url()).pathname === '/settings/developer' && settingsLeaf === 'developer' && settingsAfterUsage.top === settingsScroll.top,
    `after ${clicks} back: path=${page.url()} section=${settingsLeaf} scroll=${settingsAfterUsage.top} expected=${settingsScroll.top}`);
  await shot('n1-returned-settings-from-usage');
  assert.summary();
}

async function dirtyGuard({ page, view, link, shot }) {
  const assert = checks(`dirty-guard@${view.width}`);
  await page.goto(link('/settings/general'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-settings-page-title]', { timeout: 30_000 });
  await page.waitForTimeout(700);
  await gotoSettingsSection(page, 'developer');
  await page.waitForSelector('#st-card-advanced textarea', { timeout: 30_000 });
  await page.waitForTimeout(700);
  const arrows = await backArrows(page);
  assert.ok('dirty-1', arrows.length === 1 && arrows[0].label === expectedBackLabel('settings', view.locale), JSON.stringify(arrows));
  const draft = await editAdvancedDraft(page);
  assert.ok('dirty-2', draft.dirtyIndicator > 0, `dirty=${draft.dirtyIndicator}`);
  await shot('n1-dirty-edit');
  const before = { ...await historyCursor(page), store: await navStore(page) };
  await backButtons(page).first().click();
  await page.waitForTimeout(700);
  const dialog = page.locator(DIALOG);
  assert.ok('dirty-3', (await dialog.count()) === 1 && (await dialog.locator('[data-confirm-action="confirm"]').count()) === 1, `dialogs=${await dialog.count()}`);
  await shot('n1-dirty-dialog');
  await dialog.locator('button').first().click();
  await page.waitForTimeout(800);
  const after = await historyCursor(page);
  const field = await page.locator('#st-card-advanced textarea').first().evaluate((element) => ({ value: element.value, cursor: element.selectionStart }));
  assert.ok('dirty-4', (await page.locator(DIALOG).count()) === 0 && new URL(page.url()).pathname === '/settings/developer' &&
    field.value === draft.value && field.cursor === draft.cursor && JSON.stringify(after.state) === JSON.stringify(before.state) &&
    (await navStore(page)).currentIndex === before.store.currentIndex,
    `cancel: url=${page.url()} valueKept=${field.value === draft.value} cursor=${field.cursor}/${draft.cursor} historyKept=${JSON.stringify(after.state) === JSON.stringify(before.state)}`);
  await shot('n1-dirty-cancelled-kept');
  await backButtons(page).first().click();
  await page.waitForTimeout(600);
  await page.locator(DIALOG).locator('[data-confirm-action="confirm"]').first().click();
  await page.waitForSelector('[data-settings-page-title]', { timeout: 30_000 });
  await page.waitForTimeout(900);
  assert.ok('dirty-5', new URL(page.url()).pathname === '/settings/general' && (await page.locator('#st-card-advanced textarea').count()) === 0, `confirmed=${page.url()}`);
  await gotoSettingsSection(page, 'developer');
  await page.waitForSelector('#st-card-advanced textarea', { timeout: 30_000 });
  await page.waitForTimeout(700);
  const secondDraft = await editAdvancedDraft(page);
  assert.ok('dirty-6a', secondDraft.dirtyIndicator > 0, `dirty=${secondDraft.dirtyIndicator}`);
  const beforePop = { ...await historyCursor(page), store: await navStore(page) };
  await page.goBack();
  await page.waitForTimeout(1200);
  const count = await page.locator(DIALOG).count();
  const popState = await historyCursor(page);
  const survived = (await page.locator('#st-card-advanced textarea').count()) > 0 &&
    (await page.locator('#st-card-advanced textarea').first().evaluate((element) => element.value)) === secondDraft.value;
  assert.ok('dirty-6b', count === 1 && new URL(page.url()).pathname === '/settings/developer' && survived, `browser Back: dialogs=${count} url=${page.url()} draft=${survived}`);
  if (count > 0) {
    await page.locator(DIALOG).locator('button').first().click();
    await page.waitForTimeout(700);
    const cancelledField = await page.locator('#st-card-advanced textarea').first().evaluate((element) => ({ value: element.value, caret: element.selectionStart }));
    assert.ok('dirty-6c', new URL(page.url()).pathname === '/settings/developer' && (await page.locator('#st-card-advanced textarea').count()) === 1 &&
      cancelledField.value === secondDraft.value && cancelledField.caret === secondDraft.cursor && popState.url === beforePop.url &&
      JSON.stringify(popState.state) === JSON.stringify(beforePop.state) && (await navStore(page))?.currentIndex === beforePop.store?.currentIndex,
      `cancelled POP: url=${page.url()} value=${cancelledField.value === secondDraft.value} caret=${cancelledField.caret}/${secondDraft.cursor} history=${JSON.stringify(popState.state) === JSON.stringify(beforePop.state)}`);
    await shot('n1-dirty-browser-back-cancelled');
  } else await shot('n1-dirty-browser-back-discarded');
  assert.summary();
}

const { failed, outputDir } = await runProof({
  root: ROOT,
  scenarios: [
    { name: 'n1-usage-snapshot', fixture: 'usage-dashboard', matrix: ['width'], run: usageSnapshot },
    { name: 'n1-dirty-guard', fixture: 'settings', matrix: ['width'], run: dirtyGuard },
  ],
  argv: process.argv.slice(2),
  label: 'n1-main-integration',
  distDir: join(ROOT, '.tmp', 'n1-main-integration', 'dist'),
});
console.log(`[n1-main-integration] screenshots: ${outputDir}`);
for (const result of failed) console.error(`[n1-main-integration] ${result.id}: ${result.error}`);
process.exitCode = failed.length > 0 ? 1 : 0;
