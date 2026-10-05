/**
 * Memory management screenshots — the states the timeline and the memory page
 * have to tell apart, walked through the real controls on a real build.
 *
 * One loop, in the order a reader meets it: an automatic write in the
 * transcript, its content and basis on /memory, the version walk behind it, an
 * Undo that replays the journal, and then a concurrent change that must refuse
 * to be undone rather than replace a newer version. Around it sit the states
 * that make the loop readable: a proposal waiting, a write that changed
 * nothing, a derived entry that needs checking, and one whose endpoint has
 * passed.
 *
 *   node scripts/visual-proof-memory-provenance.mjs
 *
 * Output: `.tmp/memory-proof/<run>` (override with KIKI_PROOF_OUTPUT_DIR).
 * Mock-only: the fixture server stands in for kap-server.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'memory-proof', String(Date.now()));

const APPLIED = 'm_20261005_111111';
const DERIVED = 'm_20261005_222222';
const EXPIRED = 'm_20261005_333333';
const MERGED = 'm_20261005_444444';

/** The detail pane's own scroll container, so a shot starts where the reader is. */
async function reveal(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
}

/**
 * Back to the list. Under the phone breakpoint the list is hidden while a
 * detail is open, so the walk returns the way a reader would instead of
 * clicking a row that is not on screen.
 */
async function backToList(page) {
  const back = page.locator('[data-memory-detail-back]');
  if (await back.isVisible().catch(() => false)) await back.click();
  // Under the phone breakpoint the list stays in the DOM and is only hidden,
  // so wait for a row that is actually on screen rather than for the container.
  const row = page.locator('[data-memory-row]').first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  // The detail pane's own scroll position does not reset; bring the row into
  // view so the next click lands on it.
  await row.scrollIntoViewIfNeeded();
}

const scenarios = [
  {
    name: 'memory-provenance',
    fixture: 'memory-provenance',
    matrix: ['width'],
    run: async ({ page, view, link, shot, fixtureUrl }) => {
      const phone = view.width <= 600;

      // The turn that produced the writes: applied, unchanged, pending, and a
      // persona-scoped one whose View must land in the persona's namespace.
      await page.goto(link(`/s/session_fixture_memory_provenance`), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-tool="MemoryWrite"]', { timeout: 30_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-memory-tool="MemoryWrite"]').length >= 4, null, { timeout: 15_000 });

      const outcomes = await page.evaluate(() => [...document.querySelectorAll('[data-memory-tool="MemoryWrite"]')]
        .map((row) => ({
          verb: row.querySelector('[data-memory-tool-toggle] span:nth-of-type(2)')?.textContent ?? '',
          scope: row.querySelector('[data-memory-tool-scope]')?.dataset.memoryScopeKind ?? '',
          undo: row.querySelector('[data-memory-tool-undo]') !== null,
        })));
      // Only a real operation can be undone: a proposal is journal-backed, a
      // no-op is not an operation at all.
      const applied = outcomes.find((row) => row.verb.includes('已更新') || row.verb.includes('Updated'));
      const unchanged = outcomes.find((row) => row.verb.includes('没有变化') || row.verb.includes('No change'));
      const pending = outcomes.find((row) => row.verb.includes('待处理') || row.verb.includes('inbox'));
      const persona = outcomes.find((row) => row.scope === 'persona');
      if (applied === undefined || applied.undo !== true) throw new Error(`applied row: ${JSON.stringify(outcomes)}`);
      if (unchanged === undefined || unchanged.undo !== false) throw new Error(`unchanged row offered Undo: ${JSON.stringify(outcomes)}`);
      if (pending === undefined || pending.undo !== true) throw new Error(`pending row: ${JSON.stringify(outcomes)}`);
      if (persona === undefined) throw new Error(`no persona-scoped row: ${JSON.stringify(outcomes)}`);
      if (pending.verb === applied.verb) throw new Error('pending and applied read identically');
      await shot('timeline-outcomes');

      if (!phone) {
        // The quiet line expands to why, not to a report. The proposal is the
        // row that has something extra to say: the entry it would change is
        // still in effect.
        const proposal = page.locator('[data-memory-tool="MemoryWrite"]', { hasText: '小批' });
        await proposal.locator('[data-memory-tool-toggle]').click();
        await page.waitForSelector('[data-memory-tool-pending]', { timeout: 5_000 });
        await shot('timeline-expanded');
        await proposal.locator('[data-memory-tool-toggle]').click();
      }

      // The entry console: the two states a reader must act on are on the row.
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-memory-row="${APPLIED}"]`, { timeout: 30_000 });
      const rowStates = await page.evaluate(() => [...document.querySelectorAll('[data-memory-row]')]
        .map((row) => ({ id: row.dataset.memoryRow, validity: row.dataset.memoryValidity })));
      const derivedRow = rowStates.find((row) => row.id === DERIVED);
      const expiredRow = rowStates.find((row) => row.id === EXPIRED);
      if (derivedRow?.validity !== 'recheck') throw new Error(`derived entry should need a check: ${JSON.stringify(rowStates)}`);
      if (expiredRow?.validity !== 'expired') throw new Error(`expired entry not marked: ${JSON.stringify(rowStates)}`);
      if (await page.locator('[data-memory-row] [data-memory-row-validity]').count() !== 2) {
        throw new Error(`expected two actionable rows: ${JSON.stringify(rowStates)}`);
      }
      await shot('memory-list');

      // Content, and the two provenance facts kept apart: what the content is
      // based on, and what has to be checked before using it.
      await backToList(page);
      await page.locator(`[data-memory-row="${DERIVED}"]`).click();
      await page.waitForSelector(`[data-memory-read="${DERIVED}"]`, { state: 'visible', timeout: 15_000 });
      // Scoped to the detail pane: the list rows carry the same attributes
      // and are hidden under the phone breakpoint.
      await page.waitForSelector(`[data-memory-read="${DERIVED}"] [data-memory-basis="derived"]`, { timeout: 10_000 });
      await page.waitForSelector(`[data-memory-read="${DERIVED}"] [data-memory-validity-state="recheck"]`, { timeout: 10_000 });
      await reveal(page, '[data-memory-provenance]');
      if (!phone) await shot('memory-detail-basis');
      else {
        await shot('memory-detail-basis-phone');
      }

      // The version walk: the real before and after, each with the metadata
      // that rode it. The entry it was merged into is retired, so archived
      // entries are opted into first.
      await backToList(page);
      // Archived entries are opt-in, and the toggle sits in the list toolbar.
      await page.locator('[data-memory-console] [role="switch"]').first().click();
      await page.locator(`[data-memory-row="${MERGED}"]`).waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator(`[data-memory-row="${MERGED}"]`).click();
      await page.waitForSelector(`[data-memory-read="${MERGED}"]`, { timeout: 15_000 });
      await page.waitForSelector('[data-memory-history]', { timeout: 15_000 });
      if (await page.locator('[data-memory-covered-by]').count() === 0) throw new Error('merged entry shows no target it was merged into');
      if (!phone) await shot('memory-detail-merged');
      await page.locator('[data-memory-history-record]').first().click();
      await page.waitForSelector('[data-memory-history-detail]', { timeout: 15_000 });
      await page.waitForSelector('[data-memory-revision-chain]', { timeout: 10_000 });
      if (!phone) await shot('memory-history-versions');
      await page.locator('[data-memory-history-close]').click();
      await page.waitForSelector('[data-memory-history-detail]', { state: 'detached', timeout: 10_000 });

      // Undo replays the journal's before-image, so the retirement is reversed
      // and the entry reads as the live rule it was.
      const undo = page.locator(`[data-memory-detail="${MERGED}"] [data-memory-undo]`).first();
      await undo.click();
      // The before-image had the entry live, so after the undo the row reads as
      // an active entry again rather than a retired one.
      await page.waitForFunction((id) => {
        const row = document.querySelector(`[data-memory-row="${id}"]`);
        if (row === null) return false;
        return !row.textContent?.includes('已归档') && !row.textContent?.includes('Archived');
      }, MERGED, { timeout: 15_000 });
      if (!phone) await shot('memory-undone');

      // A concurrent change: a second writer moves the entry on, so the first
      // operation can no longer be replayed over it. The newer version stays.
      const token = link('').match(/token=([^&]+)/)?.[1];
      const conflict = await page.evaluate(async ({ id, target, token }) => {
        const base = `/api/memory/global/${id}`;
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
        const current = await (await fetch(`${target}${base}`, { headers })).json();
        const entry = current.data;
        // A different session writes the same entry with its own revision.
        const written = await fetch(`${target}${base}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            action: 'update', type: entry.type, title: entry.title,
            body: `${entry.body}（另一会话补充的当前条件）`,
            reason: '另一个会话的并发更新', expected_revision: entry.revision,
          }),
        });
        return { writeStatus: (await written.json()).code };
      }, { id: APPLIED, target: fixtureUrl, token: FIXTURE_TOKEN });
      if (conflict.writeStatus !== 0) throw new Error(`concurrent write failed: ${JSON.stringify(conflict)}`);

      const undoRefused = await page.evaluate(async ({ id, target, token }) => {
        const journal = await (await fetch(`${target}/api/memory/global/journal?id=${id}`, {
          headers: { authorization: `Bearer ${token}` },
        })).json();
        const record = (journal.data ?? [])[0];
        if (record === undefined) return { reason: 'no journal record' };
        const response = await fetch(`${target}/api/memory/global/undo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ operation_id: record.operationId }),
        });
        const body = await response.json();
        return { code: body.code, revision: body.data?.revision };
      }, { id: APPLIED, target: fixtureUrl, token: FIXTURE_TOKEN });
      if (undoRefused.code !== 40944) throw new Error(`stale undo was not refused: ${JSON.stringify(undoRefused)}`);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-memory-row="${APPLIED}"]`, { timeout: 30_000 });
      if (phone) await backToList(page);
      await page.locator(`[data-memory-row="${APPLIED}"]`).click();
      await page.waitForSelector(`[data-memory-read="${APPLIED}"]`, { timeout: 15_000 });
      const body = await page.locator('[data-memory-read-body]').innerText();
      if (!body.includes('另一会话')) throw new Error(`concurrent version was overwritten: ${body}`);
      if (!phone) await shot('memory-conflict-kept');
    },
  },
];

await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'memory-provenance' });
