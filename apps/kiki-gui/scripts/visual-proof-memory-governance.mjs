/**
 * Governed-store memory screenshots, walked through the real controls on a
 * production build: sources and decisions, an earlier revision, the forget
 * preview with its stale-preview refusal and the completed forget, read-only
 * recovery and its resume, the unchanged file-store page, and the automatic
 * startup upgrade with its stopped-and-retried path.
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
    // Export a real file, edit it, import it back through the preview, and
    // confirm; then import the now-outdated file again and get the conflict.
    name: 'memory-markdown',
    fixture: 'memory-governance',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      const phone = view.width <= 600;
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-store="governed"]', { timeout: 30_000 });
      await openEntry(page, 'm_deploy_workers');
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.locator('[data-memory-export]').click()]);
      const name = download.suggestedFilename();
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const exported = Buffer.concat(chunks).toString('utf8');
      if (!exported.startsWith('---\n{') || !exported.includes('"format": "kiki-memory-v1"')) throw new Error(`export is not a memory file: ${exported.slice(0, 80)}`);
      const edited = exported.replace('Use 5 workers', 'Use 4 workers');

      const back = page.locator('[data-memory-detail-back]');
      if (await back.isVisible().catch(() => false)) await back.click();
      const importFile = async (text) => {
        await page.locator('[data-memory-import-open]').click();
        await page.locator('[data-memory-import] input[type="file"]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
        await page.waitForFunction((file) => document.querySelector('[data-memory-import-file]')?.getAttribute('data-memory-import-file') === file, name, { timeout: 10_000 });
        await page.locator('[data-memory-import-reason]').fill(view.locale === 'zh' ? '复盘后改为 4 个' : 'Lowered after the review');
        if (!phone && (text === edited || text === exported)) await shot(text === edited ? 'import-form' : 'import-conflict-form');
        await page.locator('[data-memory-import-preview]').click();
        await page.waitForSelector('[data-memory-import-preview-result]', { timeout: 15_000 });
      };
      // A file that only pins the entry: the change must be visible before confirming.
      await importFile(exported.replace('"pinned": false', '"pinned": true'));
      await page.waitForSelector('[data-memory-import-incoming] [data-memory-import-meta-changed="pinned"]', { timeout: 15_000 });
      await page.locator('[data-memory-import-incoming] [data-memory-import-meta]').scrollIntoViewIfNeeded();
      await shot('import-pin-only');
      await page.locator('[data-memory-import-cancel]').click();

      await importFile(edited);
      if (await page.locator('[data-memory-import-incoming]').innerText().then((text) => !text.includes('Use 4 workers'))) throw new Error('preview does not show the file');
      await shot('import-preview');
      await page.locator('[data-memory-import-confirm="update"]').click();
      await page.waitForSelector('[data-memory-import-applied="m_deploy_workers"]', { timeout: 15_000 });
      await shot('import-applied');
      await page.locator('[data-memory-import-open="m_deploy_workers"]').click();
      await page.waitForFunction(() => document.querySelector('[data-memory-read="m_deploy_workers"]')?.textContent?.includes('Use 4 workers'), null, { timeout: 15_000 });
      if (!phone) await shot('import-readback');

      // The original export still names the revision before this import.
      if (await back.isVisible().catch(() => false)) await back.click();
      await importFile(exported);
      await page.waitForSelector('[data-memory-import-issue="revision_conflict"]', { timeout: 15_000 });
      if (await page.locator('[data-memory-import-confirm]').count() !== 0) throw new Error('conflicting import offers confirm');
      await shot('import-conflict');
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
      if (await page.locator('[data-memory-export]').count() !== 1) throw new Error('Export missing in read-only recovery');
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
    // The startup upgrade, walked through the status reads that drive it: no
    // migration control, real scope counts, then the governed page.
    name: 'memory-upgrade',
    fixture: 'memory-upgrade',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-upgrade="importing"]', { timeout: 30_000 });
      for (const selector of ['[data-memory-upgrade-retry]', '[data-memory-row]', '[data-memory-recover]']) {
        if (await page.locator(selector).count() !== 0) throw new Error(`${selector} offered during the upgrade`);
      }
      if (/%/u.test(await page.locator('[data-memory-upgrade]').innerText())) throw new Error('upgrade invents a percentage');
      await shot('upgrade-running');
      await page.waitForSelector('[data-memory-store="governed"]', { timeout: 30_000 });
      await page.waitForSelector('[data-memory-row="m_deploy_workers"]', { timeout: 15_000 });
      if (view.width > 600) await shot('upgrade-done');
    },
  },
  {
    // A file store that is not migrating (a server without the automatic
    // upgrade) keeps the ordinary page: entries, edits, no upgrade status.
    name: 'memory-governance-legacy',
    fixture: 'memory',
    matrix: ['width'],
    run: async ({ page, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-store="legacy"]', { timeout: 30_000 });
      if (await page.locator('[data-memory-upgrade], [data-memory-write-hold]').count() !== 0) throw new Error('file store shows an upgrade');
      await openEntry(page, 'm_20260926_d4e5f6');
      await page.waitForSelector('[data-memory-governance="legacy"]', { timeout: 15_000 });
      if (await page.locator('[data-memory-forget-open]').count() !== 0) throw new Error('Forget offered on the file store');
      if (await page.locator('[data-memory-edit]').count() === 0) throw new Error('file store lost Edit');
      await shot('legacy-detail');
    },
  },
  {
    name: 'memory-upgrade-failed',
    fixture: 'memory-upgrade-failed',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      await page.goto(link('/memory'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-memory-upgrade="failed"]', { timeout: 30_000 });
      if (await page.locator('[data-memory-upgrade-issue]').count() !== 5) throw new Error('issue list is not capped at five');
      await shot('upgrade-failed');
      await page.locator('[data-memory-upgrade-retry]').click();
      await page.waitForSelector('[data-memory-store="governed"]', { timeout: 30_000 });
      await page.waitForSelector('[data-memory-row="m_deploy_workers"]', { timeout: 15_000 });
      if (view.width > 600) await shot('upgrade-retried');
    },
  },
];

await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'memory-governance' });
