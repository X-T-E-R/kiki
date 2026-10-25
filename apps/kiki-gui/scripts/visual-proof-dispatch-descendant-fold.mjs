/**
 * dispatch-descendant-fold proof (fixture `dispatch-descendant-fold`):
 *
 *   One dispatch card, and the two kinds of descendant under it. The card is a
 *   later run of an agent that already had children, so the record mixes a
 *   descendant born before this dispatch — currently running again after a
 *   resume — with one born during it. Only the latter lays out; the former is
 *   carried by a single fold line that states how many there are and whether
 *   any still run, and opens on click into exactly the same subtree.
 *
 * The fold line is proved in both states and at both widths, because its whole
 * job is to stay legible while closed and to hand back the same rows when open.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };

// Under a test guard the profile is an empty isolation directory, so
// Playwright's browser lookup has to be pointed at the installed one.
// The caller passes the location of an already-installed browser tree; the
// guard requires the isolation directories to be empty when it launches, so
// the link into it is made here rather than before the run starts.
if (process.env.KIKI_PROOF_BROWSER_ROOT !== undefined) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.KIKI_PROOF_BROWSER_ROOT;
}
const SID = 'session_fixture_dispatch_descendant_fold';
const OLD = 'agent-old';
const NEW = 'agent-new';
const LEAD = 'agent-lead';

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'dispatch-descendant-fold', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{
    name: 'dispatch-descendant-fold',
    fixture: 'dispatch-descendant-fold',
    run: async ({ page, shot, view, link }) => {
      const C = view.locale === 'zh'
        ? { group: '其他子智能体', running: '个运行中' }
        : { group: 'Other subagents', running: 'running' };

      const group = () => page.locator('[data-other-descendants]');
      const toggle = () => page.locator('[data-other-descendants] [data-activity-toggle]');
      const card = (id) => page.locator(`[data-subagent-id="${id}"]`);

      await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-other-descendants]', { timeout: 30_000 });
      await page.waitForTimeout(500);

      // Closed, the line states the count and that one of them still runs.
      const closed = group();
      assert((await closed.getAttribute('data-other-descendants')) === '1', 'the fold line did not carry exactly the one descendant that is not this dispatch’s');
      // The live mark is a spinner, which carries its state in the accessible
      // name rather than a data attribute; the line's own words say it too.
      assert(await closed.locator('[role="img"][aria-label]').count() > 0, 'a running descendant did not mark the fold line');
      const text = (await closed.innerText()).replace(/\s+/g, ' ');
      assert(text.includes(C.group), `the fold line is not named: ${text}`);
      assert(text.includes(C.running), `the fold line does not say one of them still runs: ${text}`);

      // The descendant this dispatch created lays out; the older one does not.
      assert(await card(NEW).count() === 1, 'the descendant born during this dispatch is not on the page');
      assert(await card(OLD).count() === 0, 'the descendant from an earlier dispatch is laid out before it is asked for');

      await page.waitForTimeout(400);
      await shot('other-group-closed');

      // Opening hands back the same row the closed line stood for.
      assert((await toggle().getAttribute('aria-expanded')) === 'false', 'the fold line is not marked collapsed to a screen reader');
      await toggle().click();
      await page.waitForSelector(`[data-subagent-id="${OLD}"]`, { timeout: 10_000 });
      assert(await card(NEW).count() === 1, 'opening the group lost the descendant that was already laid out');
      await page.waitForTimeout(400);
      await shot('other-group-open');

      // Closing again puts it away, and the reader's choice survives a repaint.
      await toggle().click();
      await page.waitForTimeout(400);
      assert(await card(OLD).count() === 0, 'the group did not close again');
      assert((await group().getAttribute('data-other-descendants')) === '1', 'the closed line lost its count');
      await shot('other-group-reclosed');
    },
  }],
});

if (!result.ok) {
  for (const failure of result.failures ?? []) console.error(`[${failure.label ?? failure.view ?? 'proof'}] ${failure.message ?? failure}`);
  process.exitCode = 1;
}