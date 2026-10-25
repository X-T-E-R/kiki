/**
 * /memory scrolling — the ledger reads as two panes that scroll on their own,
 * and a list that runs to hundreds of entries must not carry the detail, the
 * filters or the reader's draft with it.
 *
 * One walk, measured rather than eyeballed: the seeded long list (204 entries
 * in `fixtures/memory-scroll.scenario.mjs`, served 20 at a time and continued
 * by cursor) is scrolled while the open entry, the filter row and the document
 * stay exactly where they were; the entry's own pane scrolls to its actions and
 * to the end of its history; selecting another entry starts it at its own top
 * and leaves the list where the reader left it; an open draft survives all of
 * it. A short list is walked too, because the fix must not turn three entries
 * into a page with two scrollbars, and the review inbox is walked because it is
 * the one branch of this page that has to keep the console as its scroller. At
 * phone width the same list is covered by the detail column and handed back —
 * with its offset — on the way out.
 *
 *   node scripts/visual-proof-memory-scroll.mjs [--only=...] [--matrix=all]
 *
 * Output: `.tmp/memory-scroll-proof/<run>` (override with KIKI_PROOF_OUTPUT_DIR).
 * Nothing is mocked here: the list, its continuation pages, the long entry and
 * its journal all come from the fixture server.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'memory-scroll-proof', String(Date.now()));

const LONG_ID = 'm_scroll_long';
/** The seeded size of `fixtures/memory-scroll.scenario.mjs`. */
const TOTAL = 204;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Two frames, so a scroll and the layout it causes have both landed. */
const settle = (page) => page.evaluate(() => new Promise((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => { done(undefined); }));
}));

/** Everything the walk measures, in one read so two values cannot straddle a frame. */
function readGeometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return {
        top: Math.round(box.top), bottom: Math.round(box.bottom),
        left: Math.round(box.left), height: Math.round(box.height),
      };
    };
    const scroll = (selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : {
        top: Math.round(element.scrollTop),
        height: element.scrollHeight,
        client: element.clientHeight,
      };
    };
    return {
      rows: rect('[data-memory-rows]'),
      rowsScroll: scroll('[data-memory-rows]'),
      pane: rect('[data-memory-detail-pane]'),
      paneScroll: scroll('[data-memory-detail-pane]'),
      console: rect('[data-memory-console]'),
      consoleScroll: scroll('[data-memory-console]'),
      search: rect('[data-memory-search]'),
      detail: rect('[data-memory-detail]'),
      actions: rect('[data-memory-actions]'),
      lastHistory: (() => {
        const records = document.querySelectorAll('[data-memory-history-record]');
        const last = records[records.length - 1];
        if (last === undefined) return null;
        const box = last.getBoundingClientRect();
        return {
          top: Math.round(box.top), bottom: Math.round(box.bottom),
          left: Math.round(box.left), height: Math.round(box.height),
        };
      })(),
      count: document.querySelectorAll('[data-memory-row]').length,
      documentTop: Math.round(document.scrollingElement.scrollTop),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

/** The first row fully inside a scroll region, so a click lands where it looks. */
function markRowInside(page, regionSelector) {
  return page.evaluate((selector) => {
    const region = document.querySelector(selector);
    const box = region.getBoundingClientRect();
    const candidates = [...region.querySelectorAll('[data-memory-row]')].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= box.top + 4 && rect.bottom <= box.bottom - 4;
    });
    const row = candidates[Math.min(1, candidates.length - 1)];
    if (row === undefined) return null;
    row.setAttribute('data-proof-target', '');
    return row.getAttribute('data-memory-row');
  }, regionSelector);
}

const scenarios = [
  {
    name: 'memory-scroll-desktop',
    fixture: 'memory-scroll',
    run: async ({ page, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction((total) => document.querySelectorAll('[data-memory-row]').length >= total, TOTAL, { timeout: 30_000 });
      await settle(page);

      const loaded = await readGeometry(page);
      expect(loaded.count === TOTAL, `expected ${TOTAL} rows, saw ${loaded.count}`);
      // The ledger keeps the page's own width: the same axis as the header, a
      // 340px list, and a detail column that gets the rest.
      const columns = await page.evaluate(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const header = box('[data-page-header-inner="split"]');
        const grid = box('[data-memory-list-detail]');
        return {
          headerWidth: Math.round(header.width), headerLeft: Math.round(header.left),
          gridWidth: Math.round(grid.width), gridLeft: Math.round(grid.left),
          listWidth: Math.round(box('[data-memory-list]').width),
          paneWidth: Math.round(box('[data-memory-detail-pane]').width),
        };
      });
      expect(columns.gridWidth === columns.headerWidth,
        `the ledger is ${columns.gridWidth}px inside a ${columns.headerWidth}px page`);
      expect(columns.gridLeft === columns.headerLeft,
        `the ledger starts at ${columns.gridLeft} while the header starts at ${columns.headerLeft}`);
      expect(Math.abs(columns.listWidth - 340) <= 1, `the list column is ${columns.listWidth}px, not 340`);
      expect(columns.paneWidth > 400, `the detail column is only ${columns.paneWidth}px wide`);
      // No sideways slop: the row hover bleeds past the column by design, so
      // the pane clips that axis instead of offering a scrollbar. `hidden` is
      // read from the computed style because a hidden axis can still be moved
      // programmatically.
      const overflow = await page.evaluate(() => {
        const read = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return { x: style.overflowX, y: style.overflowY, scrollbar: style.scrollbarWidth };
        };
        return { rows: read('[data-memory-rows]'), detail: read('[data-memory-detail-pane]') };
      });
      expect(overflow.rows.x === 'hidden' && overflow.rows.y === 'auto',
        `the list pane scrolls sideways: ${JSON.stringify(overflow.rows)}`);
      expect(overflow.detail.x === 'hidden' && overflow.detail.y === 'auto',
        `the detail pane scrolls sideways: ${JSON.stringify(overflow.detail)}`);
      // The fix in one line: the console is no longer the scroller, so a
      // hundred rows cannot drag the detail column with them.
      expect(loaded.consoleScroll !== null && loaded.consoleScroll.height <= loaded.consoleScroll.client + 1,
        `the console still scrolls the whole ledger: ${JSON.stringify(loaded.consoleScroll)}`);
      expect(loaded.rowsScroll.height > loaded.rowsScroll.client + 200,
        `the list does not scroll inside its own pane: ${JSON.stringify(loaded.rowsScroll)}`);
      expect(loaded.pane !== null && loaded.pane.height > 300,
        `the detail column has no height of its own: ${JSON.stringify(loaded.pane)}`);
      expect(loaded.search !== null && loaded.search.top > 0 && loaded.search.top < loaded.viewport.height,
        `the filters are not visible: ${JSON.stringify(loaded.search)}`);
      expect(loaded.documentTop === 0, `the document itself scrolled to ${loaded.documentTop}`);
      await shot('1-long-list');

      // One long entry, read in its own pane.
      await page.locator(`[data-memory-row="${LONG_ID}"]`).click();
      await page.waitForSelector(`[data-memory-read="${LONG_ID}"]`, { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-memory-history-record]').length >= 30, null, { timeout: 15_000 });
      await settle(page);
      const opened = await readGeometry(page);
      expect(opened.paneScroll.height > opened.paneScroll.client + 400,
        `a long entry does not scroll in the detail pane: ${JSON.stringify(opened.paneScroll)}`);
      expect(opened.paneScroll.top === 0, `the entry did not open at its own top: ${opened.paneScroll.top}`);
      expect(opened.rowsScroll.top === 0, `opening an entry moved the list to ${opened.rowsScroll.top}`);
      const paneOverflow = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('[data-memory-detail-pane]'));
        return { x: style.overflowX, y: style.overflowY };
      });
      expect(paneOverflow.x === 'hidden' && paneOverflow.y === 'auto',
        `the detail pane scrolls sideways: ${JSON.stringify(paneOverflow)}`);

      // The action a reader comes back for is reachable at the end of the body.
      await page.locator('[data-memory-actions]').scrollIntoViewIfNeeded();
      await settle(page);
      const atActions = await readGeometry(page);
      expect(atActions.actions !== null && atActions.actions.bottom <= atActions.pane.bottom + 1
        && atActions.actions.top >= atActions.pane.top - 1,
        `the edit actions are not inside the pane: ${JSON.stringify(atActions.actions)} vs ${JSON.stringify(atActions.pane)}`);
      expect(atActions.actions.top < atActions.viewport.height, 'the edit actions sit below the viewport');
      await shot('2-long-entry-actions');

      // The load-bearing measurement: the list moves, the detail does not.
      const before = await readGeometry(page);
      await page.locator('[data-memory-rows]').evaluate((element) => { element.scrollTop = 1200; });
      await settle(page);
      const after = await readGeometry(page);
      expect(after.rowsScroll.top > 1000, `the list did not scroll: ${after.rowsScroll.top}`);
      expect(after.pane.top === before.pane.top, `the detail column moved with the list: ${before.pane.top} -> ${after.pane.top}`);
      expect(after.detail.top === before.detail.top, `the open entry moved with the list: ${before.detail.top} -> ${after.detail.top}`);
      expect(after.paneScroll.top === before.paneScroll.top, `the detail lost its own offset: ${before.paneScroll.top} -> ${after.paneScroll.top}`);
      expect(after.search.top === before.search.top, `the filters moved with the list: ${before.search.top} -> ${after.search.top}`);
      expect(after.consoleScroll.top === 0, `the console scrolled to ${after.consoleScroll.top}`);
      expect(after.documentTop === 0, `the document scrolled to ${after.documentTop}`);
      await shot('3-list-scrolled-detail-stays');

      // Choosing another entry starts it at its own top and leaves the list be.
      const target = await markRowInside(page, '[data-memory-rows]');
      expect(target !== null, 'no row was fully visible to click');
      await page.locator('[data-proof-target]').click();
      await page.waitForSelector(`[data-memory-detail="${target}"]`, { timeout: 15_000 });
      await settle(page);
      const selected = await readGeometry(page);
      expect(selected.rowsScroll.top === after.rowsScroll.top,
        `selecting an entry moved the list: ${after.rowsScroll.top} -> ${selected.rowsScroll.top}`);
      expect(selected.paneScroll.top === 0, `the next entry opened at ${selected.paneScroll.top} instead of its top`);
      expect(selected.pane.top === after.pane.top, 'the detail column moved while selecting');
      await shot('4-detail-after-list-scroll');

      // A draft is not part of anybody else's scroll position.
      await page.locator('[data-memory-edit]').click();
      await page.waitForSelector('[data-memory-editor]', { timeout: 10_000 });
      const draft = 'Draft line that has to survive a list scroll.';
      await page.locator('[data-memory-body]').fill(draft);
      await settle(page);
      const editing = await readGeometry(page);
      await page.locator('[data-memory-rows]').evaluate((element) => { element.scrollTop += 600; });
      await settle(page);
      const keptDraft = await page.locator('[data-memory-body]').inputValue();
      const afterDraft = await readGeometry(page);
      expect(keptDraft === draft, `the draft was replaced while the list scrolled: "${keptDraft}"`);
      expect(afterDraft.rowsScroll.top === editing.rowsScroll.top + 600,
        `the list did not scroll under the draft: ${editing.rowsScroll.top} -> ${afterDraft.rowsScroll.top}`);
      expect(afterDraft.detail.top === editing.detail.top, 'the open editor moved with the list');
      expect(afterDraft.consoleScroll.top === 0, `the console scrolled to ${afterDraft.consoleScroll.top}`);
      await shot('5-draft-kept');
    },
  },
  {
    name: 'memory-scroll-short',
    fixture: 'memory',
    run: async ({ page, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-memory-detail-empty]', { timeout: 30_000 });
      await settle(page);
      const geometry = await readGeometry(page);
      // A short list must not grow a second scrollbar or a page that scrolls.
      expect(geometry.rowsScroll.height <= geometry.rowsScroll.client + 1,
        `a four-entry list scrolls inside its pane: ${JSON.stringify(geometry.rowsScroll)}`);
      expect(geometry.consoleScroll.height <= geometry.consoleScroll.client + 1,
        `a four-entry list scrolls the console: ${JSON.stringify(geometry.consoleScroll)}`);
      expect(geometry.paneScroll.height <= geometry.paneScroll.client + 1,
        `the idle detail column scrolls: ${JSON.stringify(geometry.paneScroll)}`);
      // The fixture keeps three active global entries plus one archived, which
      // is off until asked for: a short list, not an empty one.
      expect(geometry.count >= 3, `the fixture lost its entries: ${geometry.count}`);
      expect(geometry.documentTop === 0, `the document scrolled to ${geometry.documentTop}`);
      await shot('short-list');
    },
  },
  {
    name: 'memory-scroll-inbox',
    fixture: 'memory-review',
    run: async ({ page, link, shot }) => {
      await page.goto(link('/memory?tab=inbox'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-memory-inbox-row]', { timeout: 30_000 });
      await settle(page);
      const inbox = await page.evaluate(() => {
        const consolePane = document.querySelector('[data-memory-console]');
        const style = getComputedStyle(consolePane);
        const rows = document.querySelectorAll('[data-memory-inbox-row]');
        const last = rows[rows.length - 1];
        const box = last.getBoundingClientRect();
        return {
          overflowY: style.overflowY,
          ledger: document.querySelector('[data-memory-rows]') !== null,
          rows: rows.length,
          lastBottom: Math.round(box.bottom),
          viewport: window.innerHeight,
          pageScrolls: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        };
      });
      // The inbox is one reading column, not the ledger: it keeps the console
      // as its scroller instead of being clipped by the two-pane frame.
      expect(inbox.rows >= 1, `the review fixture lost its proposals: ${inbox.rows}`);
      expect(inbox.ledger === false, 'the inbox rendered the ledger frame');
      expect(inbox.overflowY === 'auto', `the inbox console no longer scrolls: ${inbox.overflowY}`);
      expect(inbox.lastBottom <= inbox.viewport + 1, `the last proposal is out of reach: ${inbox.lastBottom}`);
      expect(inbox.pageScrolls <= 1, `the inbox page scrolls by ${inbox.pageScrolls}px`);
      await shot('inbox');
    },
  },
  {
    name: 'memory-scroll-phone',
    fixture: 'memory-scroll',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      if (view.width > 600) return;
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction((total) => document.querySelectorAll('[data-memory-row]').length >= total, TOTAL, { timeout: 30_000 });
      await settle(page);

      const list = await readGeometry(page);
      // One column, one scrollbar: the console scrolls the list, the rows pane
      // does not add a twin of its own.
      expect(list.consoleScroll.height > list.consoleScroll.client + 200,
        `the phone console does not scroll the list: ${JSON.stringify(list.consoleScroll)}`);
      expect(list.rowsScroll.height <= list.rowsScroll.client + 1,
        `the phone list grew an inner scrollbar: ${JSON.stringify(list.rowsScroll)}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow <= 1, `the phone layout overflows sideways by ${overflow}px`);
      await shot('1-phone-list');

      // A long entry first: the pane has to reach the end of a long history,
      // which is the part a short list never shows.
      await page.locator(`[data-memory-row="${LONG_ID}"]`).click();
      await page.waitForSelector(`[data-memory-read="${LONG_ID}"]`, { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-memory-history-record]').length >= 30, null, { timeout: 15_000 });
      await settle(page);
      const opened = await readGeometry(page);
      expect(await page.locator('[data-memory-list]').isVisible() === false, 'the list stayed on screen beside the detail');
      expect(await page.locator('[data-memory-detail]').isVisible(), 'the detail did not open');
      // The column starts at its own top, not wherever the list happened to be.
      expect(opened.consoleScroll.top === 0, `the detail opened at offset ${opened.consoleScroll.top}`);
      expect(opened.pane.top >= opened.console.top && opened.pane.top <= opened.console.top + 24,
        `the detail column starts at ${opened.pane.top}, console at ${opened.console.top}`);
      await shot('2-phone-detail');

      // The end of a long entry is reachable inside the same column.
      await page.locator('[data-memory-console]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await settle(page);
      const end = await readGeometry(page);
      expect(end.lastHistory !== null && end.lastHistory.bottom <= end.viewport.height + 1,
        `the last history row is not reachable: ${JSON.stringify(end.lastHistory)}`);
      await shot('3-phone-history-end');

      // Back to the list, then the same two moves over a scrolled one: the
      // entry opens at its own top, and the list is handed back where it was.
      await page.locator('[data-memory-detail-back]').click();
      await page.waitForSelector('[data-memory-detail]', { state: 'detached', timeout: 15_000 });
      await settle(page);
      expect(await page.locator('[data-memory-list]').isVisible(), 'the list did not come back');

      await page.locator('[data-memory-console]').evaluate((element) => { element.scrollTop = 1400; });
      await settle(page);
      const scrolled = await readGeometry(page);
      expect(scrolled.consoleScroll.top > 1000, `the phone list did not scroll: ${scrolled.consoleScroll.top}`);
      const target = await markRowInside(page, '[data-memory-console]');
      expect(target !== null, 'no phone row was fully visible to tap');
      await page.locator('[data-proof-target]').click();
      await page.waitForSelector(`[data-memory-detail="${target}"]`, { timeout: 15_000 });
      await settle(page);
      const openedEntry = await readGeometry(page);
      expect(openedEntry.consoleScroll.top === 0, `the next entry opened at offset ${openedEntry.consoleScroll.top}`);

      await page.locator('[data-memory-detail-back]').click();
      await page.waitForSelector('[data-memory-detail]', { state: 'detached', timeout: 15_000 });
      await settle(page);
      const back = await readGeometry(page);
      expect(await page.locator('[data-memory-list]').isVisible(), 'the list did not come back');
      expect(back.consoleScroll.top === scrolled.consoleScroll.top,
        `the list came back at ${back.consoleScroll.top} instead of ${scrolled.consoleScroll.top}`);
      await shot('4-phone-list-restored');
    },
  },
];

await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'memory-scroll' });
