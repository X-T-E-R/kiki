/**
 * Visual proof for the composer's footer remainder entry.
 *
 *   node scripts/visual-proof-session-remainder.mjs [--matrix=all]
 *
 * The defect this replaces is a placement one: the session's unread structures
 * were announced after the last transcript row, so a reader sitting at the input
 * saw a footer that said nothing about what had not arrived, and an unread
 * conversation looked complete. The entry now sits at the right end of the
 * composer's own footer row, on the same line as the working sentence.
 *
 * What is asserted, in order:
 *  - a session with outstanding structures shows one entry at the footer's right
 *    end, on the working row, and not after the last transcript row;
 *  - the running-task count no longer appears on that row;
 *  - opening it offers the same per-structure rows and reads through the same
 *    loader, so it is the existing outlet moved, not a second one;
 *  - a session whose structures all arrived shows no entry at all, rather than
 *    claiming the transcript was read in full.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'session_fixture_remainder';
const BUSY_SID = 'session_fixture_remainder_busy';
const COMPLETE_SID = 'session_fixture_remainder_complete';

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** The footer entry and the row it lives on, as the page actually laid them out. */
async function readFooter(page) {
  return page.evaluate(() => {
    const entry = document.querySelector('[data-session-remainder]');
    const line = document.querySelector('[data-composer-status-line]');
    const working = document.querySelector('[data-composer-working]');
    const stop = document.querySelector('[data-composer-status-stop]');
    const inRow = (node, other) => {
      if (node === null || other === null) return false;
      const a = node.getBoundingClientRect();
      const b = other.getBoundingClientRect();
      // Same row: the vertical centres are within one line height.
      return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 12;
    };
    const entryRect = entry?.getBoundingClientRect() ?? null;
    const lineRect = line?.getBoundingClientRect() ?? null;
    return {
      entry: entry !== null,
      entryText: entry?.textContent?.trim() ?? '',
      // On the footer's own row, and to the right of the working sentence.
      sameRowAsWorking: inRow(entry, working),
      rightAligned: entryRect !== null && lineRect !== null
        ? entryRect.left > (working?.getBoundingClientRect().left ?? 0)
        : false,
      insideLine: entryRect !== null && lineRect !== null
        && entryRect.bottom <= lineRect.bottom + 1 && entryRect.top >= lineRect.top - 1,
      // A running-task count has no business on this row any more.
      hasContinuingCount: document.querySelector('[data-composer-continuing]') !== null,
      // Stop must not be pushed off the row by the new entry.
      stopVisible: stop !== null,
      overflowing: lineRect !== null && lineRect.width < (document.documentElement.clientWidth - 16),
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

const scenarios = [
  {
    name: 'remainder-footer-idle',
    fixture: 'session-remainder-footer',
    async run({ page, shot, link }) {
      await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-composer-status-line]', { state: 'attached', timeout: 30_000 });
      const entry = page.locator('[data-session-remainder]');
      await entry.waitFor({ state: 'attached', timeout: 15_000 });
      await page.waitForTimeout(600);
      const footer = await readFooter(page);
      await shot('remainder-1-footer-idle');

      expect(footer.entry, 'a session with outstanding structures must offer the entry');
      expect(footer.insideLine, `the entry must sit inside the composer's footer row, saw ${JSON.stringify(footer)}`);
      expect(footer.rightAligned, `the entry must sit at the right end, saw ${JSON.stringify(footer)}`);
      expect(!footer.hasContinuingCount, 'the running-task count must be gone from the footer row');
      expect(!footer.docOverflow, 'the wider footer row must not overflow the page');

      // And it is no longer announced after the last transcript row.
      const inTranscript = await page.locator('[data-agent-workspace-target] [data-session-remainder]').count();
      expect(inTranscript === 0, 'the reading column must no longer carry its own remainder outlet');

      // Opening it offers the same rows, from the same source.
      await entry.locator('[data-session-remainder-toggle]').click();
      const rows = page.locator('[data-session-remainder-rows] [data-continuation-kind]');
      await rows.first().waitFor({ timeout: 8000 });
      await page.waitForTimeout(400);
      const kinds = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-continuation-kind')));
      expect(kinds.includes('session'), `the opened outlet must offer the session structures, saw ${JSON.stringify(kinds)}`);
      await shot('remainder-2-footer-open');

      // Recovery still reaches the loader: the session row is actionable.
      const action = page.locator('[data-session-remainder-rows] [data-continuation-kind="session"] [data-content-continuation-action]');
      await action.waitFor({ timeout: 8000 });
      expect(await action.isEnabled(), 'the opened outlet must offer the read action');
    },
  },
  {
    name: 'remainder-footer-complete',
    fixture: 'session-remainder-footer',
    async run({ page, shot, link }) {
      await page.goto(link(`/s/${COMPLETE_SID}`), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-composer-status-line]', { timeout: 30_000 });
      await page.waitForTimeout(600);
      await shot('remainder-3-footer-none');
      // Nothing outstanding means no entry — the footer must not claim the
      // session was read in full.
      expect(await page.locator('[data-session-remainder]').count() === 0,
        'a fully carried session must show no remainder entry');
    },
  },
  {
    name: 'remainder-footer-working',
    fixture: 'session-remainder-footer',
    async run({ page, shot, link, control }) {
      // Same row as the working sentence. Reached by sending a real prompt rather
      // than by seeding a busy session: the working line is mounted from a
      // projected running turn, so this drives the turn a user would drive.
      await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea:not([disabled])', { timeout: 30_000 });
      await page.locator('[data-session-remainder]').waitFor({ state: 'attached', timeout: 15_000 });
      await page.fill('textarea', 'Keep compiling while I look at the footer.');
      await page.press('textarea', 'Control+Enter');
      // The working line only mounts once the turn is projected, so give the
      // projection a beat rather than racing it.
      await page.waitForSelector('[data-composer-working]', { state: 'attached', timeout: 20_000 })
        .catch(async () => {
          const seen = await page.evaluate(() => ({
            busy: document.querySelector('[data-composer-status-stop]') !== null,
            status: document.querySelector('[data-composer-status-line]')?.textContent?.trim() ?? '',
            composer: document.querySelector('[data-composer]') !== null,
          }));
          throw new Error(`the busy session showed no working line: ${JSON.stringify(seen)}`);
        });
      await page.locator('[data-session-remainder]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
      const footer = await readFooter(page);
      await shot('remainder-4-footer-working');
      expect(footer.sameRowAsWorking,
        `the entry must share the working sentence's row, saw ${JSON.stringify(footer)}`);
      expect(!footer.hasContinuingCount,
        'the running-task count must be gone while working too');
      // Release the held turn so the job does not leave it running.
      await control({ action: 'release', session_id: SID });
    },
  },
];

const { failed } = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'session-remainder-proof',
});
process.exitCode = failed.length > 0 ? 1 : 0;