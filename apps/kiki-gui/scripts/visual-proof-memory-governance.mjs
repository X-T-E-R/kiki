/**
 * Governed-store memory screenshots, walked through the real controls on a
 * production build: sources and decisions, an earlier revision, the forget
 * preview with its stale-preview refusal and the completed forget, read-only
 * recovery and its resume, and the unchanged file-store page.
 *
 *   node scripts/visual-proof-memory-governance.mjs [--matrix=all]
 *
 * Output: `.tmp/memory-governance-proof/<run>` (override with KIKI_PROOF_OUTPUT_DIR).
 * Mock-only: the fixture server stands in for kap-server.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'memory-governance-proof', String(Date.now()));

async function openEntry(page, id) {
  const back = page.locator('[data-memory-detail-back]');
  if (await back.isVisible().catch(() => false)) await back.click();
  const row = page.locator(`[data-memory-row="${id}"]`);
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
  await page.waitForSelector(`[data-memory-read="${id}"]`, { state: 'visible', timeout: 15_000 });
}

const scenarios = [
  {
    name: 'memory-governance',
    fixture: 'memory-governance',
    matrix: ['width'],
    run: async ({ page, view, link, shot, fixtureUrl }) => {
      const phone = view.width <= 600;
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-store="governed"]', { timeout: 30_000 });
      if (!phone) await shot('governed-list');

      await openEntry(page, 'm_deploy_workers');
      await page.waitForSelector('[data-memory-decision-current="true"]', { timeout: 15_000 });
      await page.locator('[data-memory-governance="governed"]').scrollIntoViewIfNeeded();
      await shot('detail-decisions');

      await page.locator('[data-memory-open-revision]').first().click();
      await page.waitForFunction(() => document.querySelector('[data-memory-revision-detail]')?.textContent?.includes('9 workers'), null, { timeout: 15_000 });
      await shot('revision-earlier');
      await page.locator('[data-memory-revision-close]').click();

      await openEntry(page, 'm_release_freeze');
      await page.waitForSelector('[data-memory-shared-source]', { timeout: 15_000 });
      await page.locator('[data-memory-forget-open]').click();
      await page.waitForSelector('[data-memory-forget-scope="2"]', { timeout: 15_000 });
      await shot('forget-preview');

      // Another writer moves one member on after the preview: the whole set refuses.
      const moved = await page.evaluate(async ({ target, token }) => {
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
        const entry = (await (await fetch(`${target}/api/memory/global/m_release_owner`, { headers })).json()).data;
        const put = await fetch(`${target}/api/memory/global/m_release_owner`, { method: 'PUT', headers, body: JSON.stringify({ action: 'update', type: entry.type, title: entry.title, body: `${entry.body} Weekend launches need a second approver.`, reason: 'Concurrent edit', expected_revision: entry.revision }) });
        return (await put.json()).code;
      }, { target: fixtureUrl, token: FIXTURE_TOKEN });
      if (moved !== 0) throw new Error(`concurrent write failed: ${moved}`);
      await page.locator('[data-memory-forget-ack]').check();
      await page.locator('[data-memory-forget-confirm]').click();
      await page.waitForSelector('[data-memory-forget-stale]', { timeout: 15_000 });
      await shot('forget-stale');
      if (await page.locator('[data-memory-row="m_release_owner"]').count() === 0) throw new Error('stale forget removed an entry');

      await page.locator('[data-memory-forget-repreview]').click();
      await page.waitForSelector('[data-memory-forget-ack]', { timeout: 15_000 });
      await page.locator('[data-memory-forget-ack]').check();
      await page.locator('[data-memory-forget-confirm]').click();
      await page.waitForSelector('[data-memory-forget]', { state: 'detached', timeout: 15_000 });
      await page.waitForFunction(() => document.querySelector('[data-memory-row="m_release_freeze"]') === null && document.querySelector('[data-memory-row="m_release_owner"]') === null, null, { timeout: 15_000 });
      await shot('forget-done');
    },
  },
  {
    name: 'memory-governance-readonly',
    fixture: 'memory-governance-readonly',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-write-hold="readonly"]', { timeout: 30_000 });
      if (await page.locator('[data-memory-new]').isEnabled()) throw new Error('New is enabled in read-only recovery');
      await shot('readonly-list');
      await openEntry(page, 'm_deploy_workers');
      for (const selector of ['[data-memory-edit]', '[data-memory-delete]', '[data-memory-forget-open]', '[data-memory-detail] [data-memory-undo]']) {
        if (await page.locator(selector).count() !== 0) throw new Error(`${selector} offered in read-only recovery`);
      }
      await page.waitForSelector('[data-memory-decision-current="true"]', { timeout: 15_000 });
      await shot('readonly-detail');
      if (view.width > 600) {
        await page.locator('[data-memory-resume]').click();
        await page.waitForSelector('[data-memory-write-hold]', { state: 'detached', timeout: 15_000 });
        await page.waitForSelector('[data-memory-edit]', { timeout: 15_000 });
        await shot('resumed');
        // A draft opened while editable, then the store turns read-only again:
        // the draft stays and its save waits.
        await page.locator('[data-memory-edit]').click();
        await page.locator('[data-memory-title]').fill('Deployment procedure (draft kept)');
        await page.locator('[data-memory-recover]').click();
        await page.locator('[data-confirm-action="confirm"]').click();
        await page.waitForSelector('[data-memory-write-hold="readonly"]', { timeout: 15_000 });
        if (await page.locator('[data-memory-title]').inputValue() !== 'Deployment procedure (draft kept)') throw new Error('draft lost on read-only switch');
        if (await page.locator('[data-memory-save]').isEnabled()) throw new Error('Save enabled in read-only recovery');
        await shot('readonly-draft-held');
      }
    },
  },
  {
    name: 'memory-governance-legacy',
    fixture: 'memory',
    matrix: ['width'],
    run: async ({ page, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-store="legacy"]', { timeout: 30_000 });
      await openEntry(page, 'm_20260926_d4e5f6');
      await page.waitForSelector('[data-memory-governance="legacy"]', { timeout: 15_000 });
      if (await page.locator('[data-memory-forget-open]').count() !== 0) throw new Error('Forget offered on the file store');
      if (await page.locator('[data-memory-edit]').count() === 0) throw new Error('file store lost Edit');
      await shot('legacy-detail');
    },
  },
];

await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'memory-governance' });
