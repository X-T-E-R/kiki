/**
 * Visual proof for the first-run onboarding run and the hub its last step opens,
 * over the `first-run` fixture (nothing configured, so the wizard auto-opens).
 *
 *   node scripts/visual-proof-onboarding.mjs [--matrix=all] [--only=onboarding-walk]
 *
 * The run has three steps: the welcome page (language + appearance), the
 * permission default, and one invitation to the tour. The invitation is a
 * sentence and one action — "Discover Kiki" — which opens the real /discover
 * hub; the capability list, the four interest routes and the model connection
 * all live on their own real pages, not in the welcome. Connecting a model
 * happens where it is needed: the hub's row states the current connection from
 * the server's own `auth` and provider probes and opens the Connections card in
 * Settings that actually owns sign-in and the API-key form.
 *
 * Walks (asserted, not just captured):
 *  - onboarding-walk — welcome → approvals → the invitation; the closing page is
 *    one sentence and one action (no capability rows, no route grid, no model
 *    row, nothing to scroll), the panel is shorter than its 85vh cap, and the
 *    action lands on the real route map.
 *  - onboarding-skip — closing from the invitation starts nothing and routes
 *    nowhere.
 *  - discover-model-connection — the /discover map's row opens the real card,
 *    leaving the tour keeps its position, and the resume tag comes back to it.
 *    The station and resume paper tags must clear the composer and the search box.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT = {
  en: { next: 'Next', closeSetup: 'Close setup', discover: 'Discover Kiki', cancel: 'Cancel' },
  zh: { next: '下一步', closeSetup: '关闭引导', discover: '发现 Kiki', cancel: '取消' },
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

/** Welcome → approvals → the closing invitation, through the wizard's own advance. */
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
  await wizard.locator('[data-onboarding-discover]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
}

/**
 * The closing page is one sentence and one action, and it must not pretend to
 * be the hub: no capability rows, no route grid, no model row of its own, and no
 * reserved empty height — the panel is a cap, so a short page stays short. All
 * of that is geometry and the DOM, which a screenshot alone can miss.
 */
async function checkClosingStepLayout(page, text, label) {
  const report = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    const body = document.querySelector('[role="dialog"] [data-onboarding-discover]');
    const cta = document.querySelector('[role="dialog"] [data-onboarding-discover-start]');
    const box = panel === null ? null : panel.getBoundingClientRect();
    const bodyBox = body === null ? null : body.getBoundingClientRect();
    const ctaBox = cta === null ? null : cta.getBoundingClientRect();
    const scroller = document.querySelector('[role="dialog"] [data-onboarding-step-scroll]');
    const inside = (inner) => inner !== null && box !== null
      && inner.top >= box.top - 1 && inner.bottom <= box.bottom + 1;
    return {
      panelHeight: box === null ? -1 : Math.round(box.height),
      viewport: window.innerHeight,
      // 85vh is the cap; a page this short must come nowhere near it.
      reservedCap: box === null || box.height >= window.innerHeight * 0.84,
      bodyInside: inside(bodyBox),
      ctaInside: inside(ctaBox),
      ctas: [...document.querySelectorAll('[role="dialog"] [data-onboarding-discover-start]')]
        .map((element) => element.textContent),
      legacy: {
        caps: document.querySelectorAll('[data-onboarding-cap], [data-onboarding-capabilities]').length,
        routes: document.querySelectorAll('[data-discovery-onboarding-route], [data-discovery-onboarding-overview]').length,
        model: document.querySelectorAll('[data-onboarding-model-connection] [data-model-connection]').length,
      },
      scrolls: scroller === null ? false : scroller.scrollHeight > scroller.clientHeight + 1,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  expect(report.ctas.length === 1 && report.ctas[0] === text.discover,
    `${label}: expected exactly one "${text.discover}" action, saw ${JSON.stringify(report.ctas)}`);
  expect(report.legacy.caps === 0 && report.legacy.routes === 0 && report.legacy.model === 0,
    `${label}: the closing page repeats what the hub owns ${JSON.stringify(report.legacy)}`);
  expect(report.reservedCap !== true, `${label}: panel reserved ${report.panelHeight}px of a ${report.viewport}px viewport`);
  expect(report.bodyInside && report.ctaInside, `${label}: the invitation or its action falls outside the panel`);
  expect(report.scrolls !== true, `${label}: the closing page scrolls, so it is not the short page it should be`);
  expect(!report.pageOverflow, `${label}: page overflows horizontally`);
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
  await checkClosingStepLayout(page, text, `closing ${view.locale} ${view.theme} ${view.width}`);
  await shot('onboarding-3-discover');

  // The narrow window is where a footer with two text buttons plus a primary
  // runs out of room first, so the same page is measured and captured there.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await checkClosingStepLayout(page, text, `closing ${view.locale} ${view.theme} 390`);
  await shot('onboarding-3-discover-narrow');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // The one action hands over to the real hub: the route map, the resume state
  // and the model connection are all its own.
  await wizard.locator('[data-onboarding-discover-start]').click();
  await page.waitForURL(/\/discover/, { timeout: 15_000 });
  await page.waitForSelector('[data-discovery-page]', { timeout: 15_000 });
  expect(await wizard.count() === 0, 'the invitation hands over and the run ends');
  expect(await page.locator('[data-start-route]').count() >= 4, 'the invitation opens the real route map');
  await page.waitForTimeout(400);
  await shot('onboarding-4-discover-hub');
}

/**
 * Leaving the run from its last step. The step's own action is the invitation;
 * closing without taking it must dismiss without starting anything and without
 * routing anywhere.
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
  { name: 'discover-model-connection', fixture: 'first-run', matrix: ['width'], run: discoverModelConnection },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'onboarding-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
