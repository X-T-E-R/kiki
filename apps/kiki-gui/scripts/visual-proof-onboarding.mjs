/**
 * Visual proof for the first-run onboarding run and the guide it ends on, plus
 * the tour's own model row, over the `first-run` fixture (nothing configured, so
 * the wizard auto-opens).
 *
 *   node scripts/visual-proof-onboarding.mjs [--matrix=all] [--only=onboarding-walk]
 *
 * The run has three steps: the welcome page (language + appearance), the
 * permission default, and the guide. Connecting a model is not a page of its
 * own: the guide states the current connection — read from the server's own
 * `auth` and provider probes — and opens the Connections card in Settings that
 * actually owns sign-in and the API-key form. So the walks below check that the
 * row reaches that real card, that nothing is written from the wizard, and that
 * the tour's own row reaches it too and keeps the way back.
 *
 * Walks (asserted, not just captured):
 *  - onboarding-walk — welcome → approvals → guide; the capability layout, the
 *    skill install preview (cancelled), focus, and "Let Kiki set it up" opening
 *    a session whose composer holds the /kiki-ops request, unsent.
 *  - onboarding-skip — closing from the guide starts nothing and routes nowhere.
 *  - onboarding-model-connection — the guide's model row opens the real card.
 *  - discover-model-connection — the /discover map's row opens it too, leaving
 *    the tour keeps its position, and the resume tag comes back to it. The
 *    station and resume paper tags must clear the composer and the search box.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT = {
  en: { next: 'Next', closeSetup: 'Close setup', ask: 'Let Kiki set it up', cancel: 'Cancel' },
  zh: { next: '下一步', closeSetup: '关闭引导', ask: '让 Kiki 帮你配置', cancel: '取消' },
};

const CONNECTIONS_CARD = '#st-card-providers-add, [data-add-connection-panel]';

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function openWizard(page) {
  const wizard = page.locator('[role="dialog"][aria-label]').first();
  await wizard.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(450);
  return wizard;
}

/** Welcome → approvals → the guide, through the wizard's own advance. */
async function toGuide(page, wizard, text, shot) {
  await wizard.locator('[data-onboarding-appearance]').waitFor({ timeout: 5000 });
  if (shot !== undefined) await shot('onboarding-1-welcome');
  await wizard.getByRole('button', { name: text.next, exact: true }).click();
  // Nothing configures a model between them: the welcome page's advance lands
  // on the permission default.
  await wizard.locator('[data-permission-choice]').first().waitFor({ timeout: 5000 });
  expect(await wizard.locator('[data-onboarding-model-id]').count() === 0, 'the run holds no model form');
  if (shot !== undefined) await shot('onboarding-2-permissions');
  await wizard.getByRole('button', { name: text.next, exact: true }).click();
  await wizard.locator('[data-onboarding-capabilities]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
}

/** Layout checks that a screenshot alone can miss. */
async function checkCapabilitiesLayout(page, label) {
  const report = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"] [data-onboarding-capabilities]');
    const rows = [...document.querySelectorAll('[data-onboarding-cap]')];
    const overflow = rows.filter((row) => row.scrollWidth > row.clientWidth + 1).map((row) => row.dataset.onboardingCap);
    // The accent and its hover step (the pointer may rest on the button).
    const accentRgb = ['--color-accent', '--color-accent-deep'].map((token) => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    });
    const accents = [...document.querySelectorAll('[role="dialog"] button')]
      .filter((button) => accentRgb.includes(getComputedStyle(button).backgroundColor))
      .map((button) => button.textContent);
    return { rows: rows.length, overflow, accents, pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, hasPanel: panel !== null };
  });
  expect(report.hasPanel && report.rows === 9, `${label}: expected 9 capability rows, saw ${report.rows}`);
  expect(report.overflow.length === 0, `${label}: rows overflow ${report.overflow.join(',')}`);
  expect(!report.pageOverflow, `${label}: page overflows horizontally`);
  expect(report.accents.length === 1, `${label}: exactly one accent-filled button, saw ${JSON.stringify(report.accents)}`);
  console.log(`[layout] ${label} ${JSON.stringify(report)}`);
}

/**
 * A paper tag is pinned to the top-right corner, so the one thing it must never
 * do is sit on top of the control the page is asking the person to use. Measured
 * as real geometry at the width under test, not read off the class list.
 */
async function checkTagClears(page, label, tagSelector, targetSelectors) {
  const report = await page.evaluate(({ tagSelector: tag, targetSelectors: targets }) => {
    const tagElement = document.querySelector(tag);
    if (tagElement === null) return { tagMissing: true };
    const box = tagElement.getBoundingClientRect();
    const hits = [];
    for (const selector of targets) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const overlaps = !(rect.right <= box.left || rect.left >= box.right || rect.bottom <= box.top || rect.top >= box.bottom);
        if (overlaps) hits.push(`${selector} (${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)})`);
      }
    }
    return { tagMissing: false, box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }, hits, outside: box.left < -1 || box.right > window.innerWidth + 1 || box.top < -1 || box.bottom > window.innerHeight + 1 };
  }, { tagSelector, targetSelectors });
  expect(!report.tagMissing, `${label}: ${tagSelector} is not on the page`);
  expect(report.hits.length === 0, `${label}: ${tagSelector} covers ${report.hits.join(', ')}`);
  expect(report.outside !== true, `${label}: ${tagSelector} runs outside the viewport at ${JSON.stringify(report.box)}`);
  console.log(`[layout] ${label} tag ${JSON.stringify(report.box)} clears ${targetSelectors.join(', ')}`);
}

async function walk({ page, view, shot }) {
  const text = TEXT[view.locale];
  const wizard = await openWizard(page);
  await toGuide(page, wizard, text, shot);
  await checkCapabilitiesLayout(page, `caps ${view.locale} ${view.theme} ${view.width}`);
  await shot('onboarding-3-capabilities');
  // The body scrolls inside the dialog; capture the lower half too.
  await wizard.locator('[data-onboarding-cap="bots"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('onboarding-3-capabilities-end');

  // The model connection closes the guide, and it is a row, not a step: the
  // current state comes from the server's own probes.
  const modelRow = wizard.locator('[data-onboarding-model-connection] [data-model-connection]');
  await modelRow.waitFor({ timeout: 5000 });
  const modelState = await modelRow.getAttribute('data-model-connection');
  expect(['missing', 'ready', 'unknown'].includes(modelState), `unexpected model state ${modelState}`);
  expect(await wizard.locator('[data-connection-choice]').count() === 0, 'the guide configures no model inline');

  // Skill install: preview first, confirm writes; cancel here.
  await wizard.locator('[data-cap-install="claude"]').click();
  await page.waitForSelector('[data-host-skill-dialog="ready"] [data-host-skill-path]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('onboarding-3-skill-preview');
  await page.locator('[data-host-skill-dialog] button', { hasText: text.cancel }).click();
  await page.waitForSelector('[data-host-skill-dialog]', { state: 'detached', timeout: 5000 });
  expect(await page.locator('[data-onboarding-capabilities]').count() === 1, 'cancelling the install keeps the wizard on its page');

  // Keyboard focus is visible on a row action.
  await wizard.locator('[data-onboarding-cap="ssh"] [data-cap-ask]').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  await shot('onboarding-3-capabilities-focus');

  // "Let Kiki set it up" → a session with the request pre-filled, unsent.
  await wizard.locator('[data-onboarding-cap="ssh"] [data-cap-ask]').click();
  await page.waitForURL(/\/s\//, { timeout: 15_000 });
  await page.waitForSelector('[role="dialog"][aria-label]', { state: 'detached', timeout: 10_000 }).catch(() => undefined);
  const composer = page.locator('textarea').first();
  await composer.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  const draft = await composer.inputValue();
  expect(draft.startsWith('/kiki-ops ') && /SSH/.test(draft), `composer must hold the /kiki-ops SSH request, saw "${draft.slice(0, 80)}"`);
  await shot('onboarding-4-ask-session');
}

/**
 * Leaving the run from its last step. The wizard has no "Start" button: the
 * step's own finish is "Let Kiki set it up", which opens a session, and leaving
 * without one is the close control. This walk is the second one — it must
 * dismiss without starting anything, and without routing anywhere.
 */
async function skip({ page, view }) {
  const text = TEXT[view.locale];
  const wizard = await openWizard(page);
  await toGuide(page, wizard, text);
  await wizard.getByRole('button', { name: text.closeSetup, exact: true }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label]', { state: 'detached', timeout: 10_000 });
  expect(page.url().includes('/new'), `closing returns to /new, saw ${page.url()}`);
  expect(await page.locator('textarea').first().inputValue() === '', 'closing leaves the composer empty');
}

/** The guide's model row leaves the run for the one page that writes a provider. */
async function modelConnection({ page, view, shot }) {
  const text = TEXT[view.locale];
  const wizard = await openWizard(page);
  await toGuide(page, wizard, text);
  const row = wizard.locator('[data-onboarding-model-connection] [data-model-connection]');
  await row.waitFor({ timeout: 5000 });
  expect(await row.getAttribute('data-model-connection') === 'missing', 'this fixture has nothing configured');
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('onboarding-3-model-connection');

  // The same row at the narrow width: it must wrap, not overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await row.scrollIntoViewIfNeeded();
  await shot('onboarding-3-model-connection-narrow');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  await wizard.locator('[data-model-connection-open]').click();
  await page.waitForSelector(CONNECTIONS_CARD, { timeout: 20_000 });
  const url = new URL(page.url());
  expect(url.pathname === '/settings/ai', `the row opens the Connections card, saw ${page.url()}`);
  expect(url.hash === '#st-card-providers-add', `the deep link names the add card, saw ${url.hash}`);
  await page.waitForTimeout(400);
  await shot('onboarding-4-connections-card');
  expect(await wizard.count() === 0, 'the run ends when it leaves for the real card');
}

/**
 * The tour's map carries the same row, and leaving the guide for Settings has a
 * way back: the position is kept and the resume tag follows the person there.
 */
async function discoverModelConnection({ page, view, shot, link }) {
  const open = async (path, selector) => {
    await page.goto(link(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { timeout: 20_000 });
    await page.waitForTimeout(300);
  };

  await open('/discover', '[data-discovery-page]');
  const row = page.locator('[data-discovery-model-connection] [data-model-connection]');
  await row.waitFor({ timeout: 10_000 });
  expect(await row.getAttribute('data-model-connection') === 'missing', 'this fixture has nothing configured');
  await shot('discover-map');

  // A real route first, so the tour has a position of its own to keep.
  await page.click('[data-start-route="overview"]');
  await page.waitForSelector('[data-discovery-tour-tag]', { timeout: 15_000 });
  expect(page.url().includes('/new'), `the overview route starts at its first stop, saw ${page.url()}`);
  await checkTagClears(page, `station tag ${view.locale} ${view.theme} ${view.width}`, '[data-discovery-tour-tag]', ['textarea[data-composer]', '[data-send-ready]']);
  await shot('discover-first-stop');

  // Back to the map, then out to Settings from its own model row.
  await open('/discover', '[data-discovery-page]');
  await page.click('[data-discovery-model-connection] [data-model-connection-open]');
  await page.waitForSelector(CONNECTIONS_CARD, { timeout: 20_000 });
  expect(new URL(page.url()).pathname === '/settings/ai', `the map row opens the Connections card, saw ${page.url()}`);

  const resume = page.locator('[data-discovery-resume-tag]');
  await resume.waitFor({ timeout: 10_000 });
  await checkTagClears(page, `resume tag ${view.locale} ${view.theme} ${view.width}`, '[data-discovery-resume-tag]', ['[data-settings-search]']);
  await shot('discover-settings-resume');

  // And the way back actually returns to the tour.
  await resume.getByRole('button').click();
  await page.waitForSelector('[data-discovery-tour-tag]', { timeout: 15_000 });
  await shot('discover-resumed');

  // 390 is where a pinned tag has no room: it yields to the bookmark, and the
  // expand control still opens the full guide over the composer without covering
  // it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.waitForSelector('[data-discovery-tour-tag="collapsed"]', { timeout: 5000 });
  await checkTagClears(page, 'station bookmark narrow 390', '[data-discovery-tour-tag]', ['textarea[data-composer]', '[data-send-ready]']);
  await shot('discover-resumed-narrow');
  await page.click('[data-discovery-expand]');
  await page.waitForSelector('[data-discovery-tour-tag="expanded"]', { timeout: 5000 });
  await checkTagClears(page, 'station guide narrow 390', '[data-discovery-tour-tag]', ['textarea[data-composer]', '[data-send-ready]']);
  await shot('discover-resumed-narrow-expanded');
}

const scenarios = [
  { name: 'onboarding-walk', fixture: 'first-run', onboarding: false, matrix: ['theme', 'width'], run: walk },
  { name: 'onboarding-skip', fixture: 'first-run', onboarding: false, run: skip },
  { name: 'onboarding-model-connection', fixture: 'first-run', onboarding: false, matrix: ['width'], run: modelConnection },
  { name: 'discover-model-connection', fixture: 'first-run', matrix: ['width'], run: discoverModelConnection },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'onboarding-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
