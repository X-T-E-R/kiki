/**
 * Visual proof for the first-run onboarding run and the tour its last step
 * starts, over the `first-run` fixture (nothing configured, so the wizard
 * auto-opens).
 *
 *   node scripts/visual-proof-onboarding.mjs [--matrix=all] [--only=onboarding-walk]
 *
 * `onboarding-short-scroll` follows the steps the wizard has now — agreement,
 * appearance, then depart — at 800×450, 390×360 and 1440×900. It wheels, moves
 * scrollTop, and focuses a control below the fold. The walks below this note
 * still describe an older welcome → approvals → routes order.
 *
 * The run has three steps: the welcome page (language + appearance), the
 * permission default, and a closing page that lists the five discovery routes
 * themselves, one quiet row each. A row starts that route through the shared
 * DiscoveryContext — the welcome invents no second flow, progress store or
 * resume state — and the run ends only once the guarded navigation commits.
 * The capability list and the model connection live on their own real pages,
 * not in the welcome. Connecting a model happens where it is needed: the hub's
 * row states the current connection from the server's own `auth` and provider
 * probes and opens the Connections card in Settings that actually owns sign-in
 * and the API-key form.
 *
 * Walks (asserted, not just captured):
 *  - onboarding-walk — welcome → approvals → the route rows; the closing page is
 *    one sentence plus the five catalog routes in order (no capability rows, no
 *    single call to action, no model row, nothing to scroll), the panel is
 *    shorter than its 85vh cap, and starting the overview route ends the run
 *    and pins the first station tag over the composer without leaving /new.
 *  - onboarding-skip — closing from the route rows starts nothing and routes
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
  en: { next: 'Next', back: 'Back', later: 'Set up later', closeSetup: 'Close setup' },
  zh: { next: '下一步', back: '上一步', later: '稍后配置', closeSetup: '关闭引导' },
};

/** Short, narrow-and-short, and the original desktop window. */
const SHORT_WINDOW_VIEWPORTS = [
  { name: '800x450', width: 800, height: 450 },
  { name: '390x360', width: 390, height: 360 },
  { name: '1440x900', width: 1440, height: 900 },
];

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

/** Welcome → approvals → the closing route rows, through the wizard's own advance. */
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
 * The closing page is one sentence and the five catalog routes as quiet rows,
 * and it must not pretend to be the hub: no capability rows, no leftover single
 * call to action, no model row of its own, and no reserved empty height — the
 * panel is a cap, so the page takes the height its rows need and no more. On a
 * desktop window that is still a short page that comes nowhere near the cap; on
 * a phone-sized window five labelled rows legitimately fill most of it, so the
 * narrow pass only requires the cap to hold. Either way the last row keeps real
 * air between itself and the footer's divider — measured against the body
 * wrapper's visible bottom, not the panel, because the wrapper clips overflow
 * and a screenshot alone can miss that. If a taller translation ever does
 * overflow, the step must say so with its "more below" fade and scroll, never
 * clip silently.
 */
async function checkClosingStepLayout(page, label) {
  const report = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    const body = document.querySelector('[role="dialog"] [data-onboarding-discover]');
    const rows = [...document.querySelectorAll('[role="dialog"] [data-onboarding-route]')];
    const box = panel === null ? null : panel.getBoundingClientRect();
    const bodyBox = body === null ? null : body.getBoundingClientRect();
    const scroller = document.querySelector('[role="dialog"] [data-onboarding-step-scroll]');
    const wrapper = scroller === null ? null : scroller.parentElement;
    const footer = panel === null ? null : panel.lastElementChild;
    const lastRow = rows.length === 0 ? null : rows[rows.length - 1];
    const inside = (inner) => inner !== null && box !== null
      && inner.top >= box.top - 1 && inner.bottom <= box.bottom + 1;
    return {
      panelHeight: box === null ? -1 : Math.round(box.height),
      viewport: window.innerHeight,
      viewportWidth: window.innerWidth,
      // 85vh is the cap; a page this short must come nowhere near it.
      reservedCap: box === null || box.height >= window.innerHeight * 0.84,
      bodyInside: inside(bodyBox),
      rows: rows.map((row) => row.getAttribute('data-onboarding-route')),
      rowsInside: rows.every((row) => inside(row.getBoundingClientRect())),
      // The real separation promise: the last row's bottom edge against the
      // footer's divider, and against the body wrapper's visible bottom — the
      // wrapper clips overflow, so a row past it is cut, not scrolled to.
      footerTop: footer === null ? -1 : Math.round(footer.getBoundingClientRect().top),
      lastRowBottom: lastRow === null ? -1 : Math.round(lastRow.getBoundingClientRect().bottom),
      clipBottom: wrapper === null ? -1 : Math.round(wrapper.getBoundingClientRect().bottom),
      fadeShown: document.querySelector('[role="dialog"] [data-onboarding-scroll-more]') !== null,
      scrollerBox: scroller === null ? null : {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: Math.round(scroller.scrollTop),
      },
      legacyCta: document.querySelectorAll('[data-onboarding-discover-start]').length,
      legacy: {
        caps: document.querySelectorAll('[data-onboarding-cap], [data-onboarding-capabilities]').length,
        routes: document.querySelectorAll('[data-discovery-onboarding-route], [data-discovery-onboarding-overview]').length,
        model: document.querySelectorAll('[data-onboarding-model-connection] [data-model-connection]').length,
      },
      scrolls: scroller === null ? false : scroller.scrollHeight > scroller.clientHeight + 1,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  expect(report.rows.join(',') === 'overview,do-first,understand,sustain,extend',
    `${label}: expected the five catalog routes in order, saw ${JSON.stringify(report.rows)}`);
  expect(report.legacyCta === 0, `${label}: the old single call to action is still there`);
  expect(report.legacy.caps === 0 && report.legacy.routes === 0 && report.legacy.model === 0,
    `${label}: the closing page repeats what the hub owns ${JSON.stringify(report.legacy)}`);
  // Narrow viewports (the 390 pass, or a job born narrow) may fill most of the
  // window: the cap is the whole promise there — approach it, never cross it.
  const compact = report.viewportWidth <= 600;
  if (compact) {
    expect(report.panelHeight <= Math.round(report.viewport * 0.85) + 2,
      `${label}: panel is ${report.panelHeight}px, past the 85vh cap of a ${report.viewport}px viewport`);
  } else {
    expect(report.reservedCap !== true, `${label}: panel reserved ${report.panelHeight}px of a ${report.viewport}px viewport`);
  }
  if (!report.scrolls) {
    expect(report.bodyInside && report.rowsInside, `${label}: the invitation or a route row falls outside the panel`);
  }
  // The real separation promise: a short page leaves visible air before the
  // footer; a long page may scroll, but its last row must be reachable without
  // being clipped by the body wrapper.
  if (report.scrolls) {
    expect(report.fadeShown, `${label}: the closing page scrolls but nothing says there is more below`);
    const settled = await page.evaluate(() => {
      const scroller = document.querySelector('[role="dialog"] [data-onboarding-step-scroll]');
      const wrapper = scroller?.parentElement;
      const row = [...document.querySelectorAll('[role="dialog"] [data-onboarding-route]')].at(-1);
      const footer = document.querySelector('[role="dialog"]')?.lastElementChild;
      if (scroller == null || wrapper == null || row == null || footer == null) return null;
      const priorScrollTop = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      const rowBox = row.getBoundingClientRect();
      const wrapperBox = wrapper.getBoundingClientRect();
      const footerTop = footer.getBoundingClientRect().top;
      const result = { rowTop: rowBox.top, rowBottom: rowBox.bottom, wrapperTop: wrapperBox.top, wrapperBottom: wrapperBox.bottom, footerTop };
      scroller.scrollTop = priorScrollTop;
      return result;
    });
    expect(settled !== null && settled.rowTop >= settled.wrapperTop - 1 && settled.rowBottom <= Math.min(settled.wrapperBottom, settled.footerTop) + 1,
      `${label}: the last route row is not fully visible at the bottom of the scrollable body (${JSON.stringify(settled)})`);
  } else {
    expect(report.lastRowBottom <= report.clipBottom + 1,
      `${label}: the last route row is clipped by the body (row bottom ${report.lastRowBottom}, visible bottom ${report.clipBottom})`);
    const separation = report.footerTop - report.lastRowBottom;
    expect(separation >= 8, `${label}: the last route row sits ${separation}px from the footer divider`);
  }
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
  await checkClosingStepLayout(page, `closing ${view.locale} ${view.theme} ${view.width}`);
  await shot('onboarding-3-discover');

  // The narrow window is where five rows plus a footer with two text buttons
  // run out of room first, so the same page is measured and captured there.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await checkClosingStepLayout(page, `closing ${view.locale} ${view.theme} 390`);
  await shot('onboarding-3-discover-narrow');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // A route row starts the tour right there: the overview route's first stop
  // is this very page, so the wizard closes and the station tag pins itself
  // over the composer without any navigation at all.
  await wizard.locator('[data-onboarding-route="overview"]').click();
  await page.waitForSelector('[role="dialog"][aria-label]', { state: 'detached', timeout: 10_000 });
  expect(page.url().includes('/new'), `the overview route starts in place on /new, saw ${page.url()}`);
  await page.waitForSelector('[data-discovery-tour-tag]', { timeout: 15_000 });
  await checkTagClears(page, `first stop ${view.locale} ${view.theme} ${view.width}`, '[data-discovery-tour-tag]', ['textarea[data-composer]', '[data-send-ready]']);
  await page.waitForTimeout(300);
  await shot('onboarding-4-first-stop');
}

/**
 * Leaving the run from its last step. The step's own actions are the route
 * rows; closing without taking one must dismiss without starting anything and
 * without routing anywhere.
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

function footerOf(wizard) {
  return wizard.locator(':scope > div').last();
}

async function settleFrame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/**
 * The step body is the only scrollport. Header and footer stay on screen, the
 * page behind the dialog does not grow a second scroller, and a step that
 * fits is not stretched up to the 85vh cap.
 */
async function readScrollLayout(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    const scroller = document.querySelector('[role="dialog"] [data-onboarding-step-scroll]');
    const footer = panel?.lastElementChild ?? null;
    const header = panel?.firstElementChild ?? null;
    const box = (element) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
      };
    };
    const buttons = (element) => [...(element?.querySelectorAll('button') ?? [])].map((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        name: button.getAttribute('aria-label') || button.textContent,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        hit: hit === button || (hit !== null && button.contains(hit)),
      };
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: box(panel),
      scroller: box(scroller),
      scrollHeight: scroller?.scrollHeight ?? -1,
      clientHeight: scroller?.clientHeight ?? -1,
      scrollTop: scroller?.scrollTop ?? -1,
      scrollWidth: scroller?.scrollWidth ?? -1,
      clientWidth: scroller?.clientWidth ?? -1,
      panelScrollGap: panel === null ? -1 : panel.scrollHeight - panel.clientHeight,
      pageOverflowY: document.documentElement.scrollHeight > window.innerHeight + 1
        || document.body.scrollHeight > window.innerHeight + 1,
      pageOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      cap: Math.round(window.innerHeight * 0.85),
      headerButtons: buttons(header),
      footerButtons: buttons(footer),
    };
  });
}

async function assertChromeReachable(page, wizard, text, { last, back }) {
  const footer = footerOf(wizard);
  await footer.getByRole('button', { name: last ? text.closeSetup : text.later, exact: true }).click({ trial: true });
  if (!last) await footer.getByRole('button', { name: text.next, exact: true }).click({ trial: true });
  if (back) await footer.getByRole('button', { name: text.back, exact: true }).click({ trial: true });
  await wizard.getByRole('button', { name: text.closeSetup, exact: true }).first().click({ trial: true });
  const layout = await readScrollLayout(page);
  expect(layout.panel !== null && layout.panel.top >= -1 && layout.panel.bottom <= layout.viewport.height + 1,
    `panel outside the viewport ${JSON.stringify(layout.panel)} of ${layout.viewport.height}`);
  expect(layout.panel.height <= layout.cap + 2,
    `panel ${layout.panel.height}px is past the 85vh cap ${layout.cap}px`);
  expect(layout.panelScrollGap <= 1, `the panel itself scrolls (${layout.panelScrollGap}px)`);
  expect(!layout.pageOverflowY, 'the page behind the dialog also scrolls');
  expect(!layout.pageOverflowX, 'the page overflows horizontally');
  expect(layout.scrollWidth <= layout.clientWidth + 1,
    `the step overflows horizontally (${layout.scrollWidth} > ${layout.clientWidth})`);
  expect(layout.headerButtons.every((button) => button.hit),
    `header control is not hittable ${JSON.stringify(layout.headerButtons)}`);
  expect(layout.footerButtons.length > 0 && layout.footerButtons.every((button) => button.hit),
    `footer control is not hittable ${JSON.stringify(layout.footerButtons)}`);
  return layout;
}

/**
 * Wheel, then keyboard focus, then scrollTop. Each one has to move the step
 * scroller, and the end of the step has to come into that scroller.
 */
async function assertStepScrolls(page, label) {
  const scroller = page.locator('[role="dialog"] [data-onboarding-step-scroll]');
  const box = await scroller.boundingBox();
  expect(box !== null && box.height >= 48, `${label}: scrollport is ${box?.height ?? 0}px`);
  await scroller.evaluate((node) => { node.scrollTop = 0; });
  const before = await scroller.evaluate((node) => node.scrollTop);
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(36, box.height / 2));
  await page.mouse.wheel(0, 240);
  await settleFrame(page);
  const afterWheel = await scroller.evaluate((node) => node.scrollTop);
  expect(afterWheel > before, `${label}: wheel left scrollTop at ${afterWheel}`);

  const focused = await scroller.evaluate((node) => {
    node.scrollTop = 0;
    const edge = node.getBoundingClientRect().bottom;
    const controls = [...node.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled])')];
    // The last control that actually hangs out of the scrollport. A control
    // whose top is near the edge can still be fully inside it.
    const target = controls.findLast((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > edge + 4;
    });
    if (target === undefined) return { found: false, count: controls.length };
    target.focus();
    const next = target.getBoundingClientRect();
    const visible = node.getBoundingClientRect();
    const fits = next.height <= visible.height + 1;
    return {
      found: true,
      scrollTop: node.scrollTop,
      visible: fits
        ? next.top >= visible.top - 1 && next.bottom <= visible.bottom + 1
        : next.top >= visible.top - 1 && next.top < visible.bottom,
    };
  });
  expect(focused.found === true, `${label}: nothing focusable sits below the fold (${JSON.stringify(focused)})`);
  expect(focused.scrollTop > 0, `${label}: focusing a control below the fold left scrollTop at ${focused.scrollTop}`);
  expect(focused.visible === true, `${label}: focused control is still outside the scrollport ${JSON.stringify(focused)}`);

  const ended = await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    const visible = node.getBoundingClientRect();
    const last = node.lastElementChild?.getBoundingClientRect() ?? null;
    return {
      scrollTop: node.scrollTop,
      atEnd: node.scrollHeight - node.scrollTop - node.clientHeight <= 2,
      lastBottom: last === null ? -1 : Math.round(last.bottom),
      visibleBottom: Math.round(visible.bottom),
      visibleTop: Math.round(visible.top),
    };
  });
  expect(ended.scrollTop > 0 && ended.atEnd, `${label}: scrollTop did not reach the end ${JSON.stringify(ended)}`);
  expect(ended.lastBottom <= ended.visibleBottom + 1 && ended.lastBottom > ended.visibleTop,
    `${label}: the end of the step is outside the scrollport ${JSON.stringify(ended)}`);
  return ended;
}

async function openAgreementDisclosures(wizard) {
  const more = wizard.locator('[data-onboarding-permission-more]');
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
  const paragraph = wizard.locator('[data-onboarding-paragraph-open]');
  if (await paragraph.getAttribute('aria-expanded') !== 'true') await paragraph.click();
  await wizard.locator('#onboarding-reply-paragraph').waitFor();
}

/**
 * Agreement (with the folded rows open), appearance (with the picture row
 * open), and depart. Short windows must scroll; the desktop window must not
 * grow an empty 85vh panel when the step already fits.
 */
async function shortWindow({ page, view, shot }) {
  const text = TEXT[view.locale];
  const wizard = await openWizard(page);

  for (const viewport of SHORT_WINDOW_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleFrame(page);
    const tag = `${view.locale} ${viewport.name}`;

    await wizard.locator('[data-onboarding-agreement]').waitFor();
    await openAgreementDisclosures(wizard);
    await settleFrame(page);
    let layout = await assertChromeReachable(page, wizard, text, { last: false, back: false });
    const agreementOverflows = layout.scrollHeight > layout.clientHeight + 8;
    if (viewport.height <= 450) {
      expect(agreementOverflows, `${tag} agreement fits (${layout.scrollHeight} in ${layout.clientHeight}) and cannot prove scrolling`);
    }
    if (agreementOverflows) {
      await shot(`onboarding-short-agreement-${viewport.name}-top`);
      await assertStepScrolls(page, `${tag} agreement`);
      await shot(`onboarding-short-agreement-${viewport.name}-end`);
    } else {
      expect(layout.panel.height < layout.viewport.height * 0.84,
        `${tag} agreement reserved ${layout.panel.height}px of ${layout.viewport.height}px`);
      await shot(`onboarding-short-agreement-${viewport.name}`);
    }
    console.log(`[scroll] ${tag} agreement ${JSON.stringify({ scrollHeight: layout.scrollHeight, clientHeight: layout.clientHeight, panel: layout.panel.height, cap: layout.cap })}`);
    await page.locator('[data-onboarding-step-scroll]').evaluate((node) => { node.scrollTop = 0; });

    await footerOf(wizard).getByRole('button', { name: text.next, exact: true }).click();
    await wizard.locator('[data-onboarding-appearance]').first().waitFor();
    const picture = wizard.locator('[data-onboarding-bg-open]');
    if (await picture.count()) await picture.click();
    await wizard.locator('[data-bg-settings="compact"]').waitFor();
    await settleFrame(page);
    layout = await assertChromeReachable(page, wizard, text, { last: false, back: true });
    const appearanceOverflows = layout.scrollHeight > layout.clientHeight + 8;
    if (viewport.height <= 360) {
      expect(appearanceOverflows, `${tag} appearance fits (${layout.scrollHeight} in ${layout.clientHeight}) and cannot prove scrolling`);
    }
    if (appearanceOverflows) {
      await shot(`onboarding-short-appearance-${viewport.name}-top`);
      await assertStepScrolls(page, `${tag} appearance`);
      await shot(`onboarding-short-appearance-${viewport.name}-end`);
    } else {
      expect(layout.panel.height < layout.viewport.height * 0.84,
        `${tag} appearance reserved ${layout.panel.height}px of ${layout.viewport.height}px`);
      await shot(`onboarding-short-appearance-${viewport.name}`);
    }
    console.log(`[scroll] ${tag} appearance ${JSON.stringify({ scrollHeight: layout.scrollHeight, clientHeight: layout.clientHeight, panel: layout.panel.height, cap: layout.cap })}`);
    await page.locator('[data-onboarding-step-scroll]').evaluate((node) => { node.scrollTop = 0; });

    await footerOf(wizard).getByRole('button', { name: text.next, exact: true }).click();
    await wizard.locator('[data-onboarding-depart]').waitFor();
    await wizard.locator('[data-onboarding-route="extend"]').waitFor();
    await settleFrame(page);
    layout = await assertChromeReachable(page, wizard, text, { last: true, back: true });
    const departOverflows = layout.scrollHeight > layout.clientHeight + 8;
    if (viewport.height <= 450) {
      expect(departOverflows, `${tag} depart fits (${layout.scrollHeight} in ${layout.clientHeight}) and cannot prove scrolling`);
    }
    if (departOverflows) {
      await shot(`onboarding-short-depart-${viewport.name}-top`);
      await assertStepScrolls(page, `${tag} depart`);
      await shot(`onboarding-short-depart-${viewport.name}-end`);
    } else {
      expect(layout.panel.height < layout.viewport.height * 0.84,
        `${tag} depart reserved ${layout.panel.height}px of ${layout.viewport.height}px`);
      await shot(`onboarding-short-depart-${viewport.name}`);
    }
    console.log(`[scroll] ${tag} depart ${JSON.stringify({ scrollHeight: layout.scrollHeight, clientHeight: layout.clientHeight, panel: layout.panel.height, cap: layout.cap })}`);

    await footerOf(wizard).getByRole('button', { name: text.back, exact: true }).click();
    await wizard.locator('[data-onboarding-appearance]').first().waitFor();
    await footerOf(wizard).getByRole('button', { name: text.back, exact: true }).click();
    await wizard.locator('[data-onboarding-agreement]').waitFor();
  }
}

const scenarios = [
  { name: 'onboarding-short-scroll', fixture: 'first-run', onboarding: false, run: shortWindow },
  { name: 'onboarding-walk', fixture: 'first-run', onboarding: false, matrix: ['theme', 'width'], run: walk },
  { name: 'onboarding-skip', fixture: 'first-run', onboarding: false, run: skip },
  { name: 'discover-model-connection', fixture: 'first-run', matrix: ['width'], run: discoverModelConnection },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'onboarding-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
