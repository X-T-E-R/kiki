/**
 * /memory scrolling — the ledger reads as two panes that scroll on their own,
 * and a list that runs to hundreds of entries must not carry the detail, the
 * filters or the reader's draft with it.
 *
 * One walk, measured rather than eyeballed: a long list (204 entries) is
 * scrolled while the open entry, the filter row and the document stay exactly
 * where they were; the entry's own pane scrolls to its actions and to the end
 * of its history; selecting another entry starts it at its own top and leaves
 * the list where the reader left it; an open draft survives all of it. A short
 * list is walked too, because the fix must not turn four entries into a page
 * with two scrollbars. At phone width the same list is covered by the detail
 * column and handed back — with its offset — on the way out.
 *
 *   node scripts/visual-proof-memory-scroll.mjs [--only=...] [--matrix=all]
 *
 * Output: `.tmp/memory-scroll-proof/<run>` (override with KIKI_PROOF_OUTPUT_DIR).
 * Mock-only: the list is answered by this script's own route, because the
 * fixture store pages by offset and the page continues by cursor; everything
 * else — settings, shell, journals for other entries — comes from the fixture.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'memory-scroll-proof', String(Date.now()));

/** More than the 200 the ask names, so "long list" is not one page of a list. */
const TOTAL = 204;
const LONG_ID = 'm_scroll_long';
const LONG_TITLE = 'Release cut: what has to be reread before the tag';
const LONG_BODY = [
  'The release cut is read from docs/release.md, not from the last conversation about it. That file carries the ordered steps, the owner of each step, and the checks that have to be repeated before the tag rather than trusted from the previous cut.',
  '',
  'Three checks decide whether the cut may proceed: the workspace builds from a clean tree with the pinned Node and pnpm versions, the proof suite that covers the touched surfaces is green on the same commit, and every memory entry this cut relies on has been reread after its recheck date rather than carried forward. A check that has run out is a lead, not a premise.',
  '',
  'What this entry is not: it is not the changelog, it is not the release note, and it does not name a version. Those are written from the cut, and writing them here would make the two disagree. When a step changes, the change lands in docs/release.md first, and this entry follows it in the same session.',
  '',
  'Provenance matters more here than elsewhere: the steps were agreed in the release retro, and each of them has a named owner rather than "the team". If a step loses its owner, the cut stops at that step instead of continuing on the assumption that someone is watching it.',
  '',
  'The list beside this entry is long on purpose. Reading one entry should not move the others, and coming back to the list should land where the reader left it, still on the same entry, still with an unsaved draft if one was open.',
].join('\n');

const TYPE_CYCLE = ['project', 'feedback', 'reference', 'user'];
const TOPICS = [
  'Deploy window', 'Release checklist', 'Invoice export', 'Retry budget', 'Schema migration',
  'Browser proof', 'Nightly smoke', 'Token rotation', 'Queue timeout', 'Fixture home',
  'Log retention', 'Draft autosave', 'Locale default', 'Backup cadence', 'Rate limit',
  'Changelog entry', 'Failure tone',
];
const NOTES = [
  'what the team agreed', 'the value from the last review', 'where the rule came from',
  'the current source of truth', 'the single exception', 'as confirmed in the retro',
  'the older wording', 'the check that still holds', 'the fallback path', 'the numbers in use',
  'the file that owns it', 'the hand-off step',
];

const stamp = (minutesAgo) => new Date(Date.UTC(2026, 9, 24, 9, 0, 0) - minutesAgo * 60_000).toISOString();

/** A long list of ordinary memories, so scrolling them is the only subject. */
function buildEntries() {
  const entries = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const note = NOTES[Math.floor(index / TOPICS.length) % NOTES.length];
    const id = index === 0 ? LONG_ID : `m_scroll_${String(index).padStart(3, '0')}`;
    entries.push({
      id,
      type: TYPE_CYCLE[index % TYPE_CYCLE.length],
      title: index === 0 ? LONG_TITLE : `${topic} — ${note}`,
      body: index === 0 ? LONG_BODY : `${topic} follows ${note}; the file that owns it is the source, not this line.`,
      status: 'active',
      pinned: false,
      created: stamp(4_000 + index),
      updated: stamp(60 + index),
      source: { writer: index % 3 === 0 ? 'agent' : 'user', session: 'session_fixture_memory', turn: index + 1 },
      reason: '',
      revision: `rev_scroll_${index}`,
    });
  }
  return entries;
}

/** A store-written before-image, which is what the version panel reads. */
const snapshot = (entry, body, revision) => `---\n${JSON.stringify({
  id: entry.id, title: entry.title, type: entry.type, status: entry.status, pinned: false,
  created: entry.created, updated: entry.updated, reason: entry.reason, source: entry.source,
})}\n---\n${body}`;

/** A journal long enough that its own list is past one screen. */
function buildJournal(entry) {
  return Array.from({ length: 36 }, (_, index) => ({
    operationId: `op_scroll_${String(index).padStart(3, '0')}`,
    id: entry.id,
    action: index === 0 ? 'create' : 'update',
    at: stamp(30 + index * 90),
    writer: index % 2 === 0 ? 'agent' : 'user',
    before: snapshot(entry, `${entry.body}\n\nRevision ${index}.`, `rev_scroll_history_${index}`),
    beforeRevision: `rev_scroll_history_${index}`,
    afterRevision: `rev_scroll_history_${index + 1}`,
  }));
}

const json = (data) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ code: 0, msg: 'success', data }),
});

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Two frames, so a scroll and the layout it causes have both landed. */
const settle = (page) => page.evaluate(() => new Promise((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => { done(undefined); }));
}));

/**
 * The list, its entries' detail, and one entry's journal. Only paths this walk
 * reads are answered; anything else (settings, the other scopes, writes) falls
 * through to the fixture server, which stays the source of the shell.
 */
async function routeMemoryList(page, entries, journal) {
  await page.route('**/api/memory/global**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname === '/api/memory/global') {
      const pageSize = Number(url.searchParams.get('page_size') ?? 20);
      const offset = Number((url.searchParams.get('cursor') ?? 'mock-offset-0').replace('mock-offset-', '')) || 0;
      const query = (url.searchParams.get('query') ?? '').trim().toLowerCase();
      const type = url.searchParams.get('type');
      const matching = entries.filter((entry) => (type === null || entry.type === type)
        && (query === '' || `${entry.title} ${entry.body}`.toLowerCase().includes(query)));
      const next = offset + pageSize < matching.length ? `mock-offset-${offset + pageSize}` : null;
      await route.fulfill(json({
        items: matching.slice(offset, offset + pageSize),
        mode: query === '' ? 'list' : 'search',
        next_cursor: next,
        coverage: {
          scopes: [{ kind: 'global' }],
          statuses: ['active'],
          exhausted: next === null,
          complete: true,
          warnings: [],
        },
      }));
      return;
    }
    if (url.pathname === '/api/memory/global/journal') {
      const id = url.searchParams.get('id');
      await route.fulfill(json(id === LONG_ID ? journal : []));
      return;
    }
    const id = url.pathname.slice('/api/memory/global/'.length);
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return route.fallback();
    await route.fulfill(json(entry));
  });
}

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
    fixture: 'memory',
    run: async ({ page, link, shot }) => {
      const entries = buildEntries();
      await routeMemoryList(page, entries, buildJournal(entries[0]));
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
    name: 'memory-scroll-phone',
    fixture: 'memory',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      if (view.width > 600) return;
      const entries = buildEntries();
      await routeMemoryList(page, entries, buildJournal(entries[0]));
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
