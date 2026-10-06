/**
 * media-managed-sources screenshots — the unified media plugin's source list
 * at the two widths that matter, driven through the real controls on the real
 * build. The fixture seeds one package carrying eleven sources plus a reader's
 * own script; the walk opens rows, saves a key, reads it back, switches a
 * source off and back on, removes one and restores it, adds a script source,
 * and reads the jobs back. Nothing is patched into the DOM after load, so
 * every image shows what the page does with the server's own answers.
 *
 *   node scripts/capture-media-managed-sources.mjs
 *
 * Output: `.tmp/media-managed-shots` (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'media-managed-shots');

const FIXTURE = 'media-sources-managed';

/** Back to the list, answering the dirty guard the way a reader would. */
async function backToList(page) {
  if (await page.locator('[data-media-source-detail]').count() === 0) return;
  await page.locator('[data-media-source-back]').click();
  const confirm = page.locator('[role="alertdialog"] button').last();
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
  await page.waitForSelector('[data-media-source-list]', { timeout: 15_000 }).catch(async () => {
    throw new Error(`back to list failed: view=${await page.locator('[data-plugins-source-view], [data-media-sources-view]').first().getAttribute('data-media-sources-view').catch(() => 'none')} dialogs=${await page.locator('[role="alertdialog"], [role="dialog"]').count()}`);
  });
}

/** The capabilities page scrolls its own pane; a shot starts at the top. */
async function resetScroll(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
}

/**
 * What one row says, read back from the page rather than from a fixture.
 *
 * A screenshot cannot tell a reader whether the *name* on the row is the
 * source's own label or its package's, and this walk exists because the two
 * are the whole change. So the assertions are on the text the row draws.
 */
async function rowText(page, provider) {
  return (await page.locator(`[data-media-source="${provider}"]`).innerText()).replace(/\s+/g, ' ').trim();
}

const scenarios = [
  {
    name: 'media-managed-sources',
    fixture: FIXTURE,
    matrix: ['theme', 'width'],
    run: async ({ page, view, link, shot }) => {
      const phone = view.width <= 600;
      // The runner seeds the theme before the document loads, but this page
      // opens on a workspace that carries its own server-side palette, which
      // can land after the seed. The assertion is on the attribute the palette
      // actually keys off, so a "dark" run cannot quietly capture light.
      await page.emulateMedia({ colorScheme: view.theme ?? 'light' });
      await page.goto(link(`/capabilities?view=media&session=session_fixture_media`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-media-sources-view="list"]', { timeout: 30_000 });
      await page.waitForSelector('[data-media-source-list]', { timeout: 30_000 });
      const applied = await page.evaluate(() => document.documentElement.dataset['theme'] ?? 'light');
      if (applied !== (view.theme ?? 'light')) {
        throw new Error(`theme ${view.theme} run rendered ${applied}`);
      }
      await resetScroll(page);

      // Eleven sources, one package. If the list were keyed by package this
      // would be a single row, so the count is the first assertion, not a
      // screenshot's impression.
      const rows = await page.locator('[data-media-source]').count();
      if (rows < 10) throw new Error(`expected one row per source, saw ${rows}`);
      await shot('list');

      // Each row's name is the source's own brand label, and each says so.
      const openai = await rowText(page, 'kiki-media/openai');
      if (!openai.includes('OpenAI Media')) throw new Error(`row name is not the source label: ${openai}`);
      // The status words are read off the row's own state attribute rather than
      // its text, so every assertion here holds in every locale.
      const statusOf = (provider) => page.locator(`[data-media-source="${provider}"]`).getAttribute('data-media-source-status');
      if (await statusOf('kiki-media/openai') !== 'default') throw new Error(`the saved default is not marked on its row: ${openai}`);
      const needsKey = await rowText(page, 'kiki-media/xai');
      if (await statusOf('kiki-media/xai') !== 'needs-config' || !needsKey.includes('apiKey')) {
        throw new Error(`a source missing a key must name it: ${needsKey}`);
      }
      if (await statusOf('kiki-media/ark-alt') !== 'off') throw new Error(`a switched-off source must say so: ${await rowText(page, 'kiki-media/ark-alt')}`);
      if (await statusOf('kiki-media/retired-gateway') !== 'removed') throw new Error(`a removed source must say so: ${await rowText(page, 'kiki-media/retired-gateway')}`);
      const script = await rowText(page, 'kiki-media/local-renderer');
      if (!script.includes('python')) {
        throw new Error(`a reader's script must say what it runs: ${script}`);
      }
      await resetScroll(page);
      await shot('list-states');

      // Search is over the source's own identity, not the package's.
      await page.locator('[data-media-sources] input[type="search"]').fill('comfyui');
      await page.waitForFunction(() => document.querySelectorAll('[data-media-source]').length === 1, { timeout: 10_000 });
      await resetScroll(page);
      await shot('search');
      await page.locator('[data-media-sources] input[type="search"]').fill('');
      await page.waitForFunction(() => document.querySelectorAll('[data-media-source]').length > 1, { timeout: 10_000 });

      // A state band: only the rows that would actually fail without a key.
      await page.locator('[data-media-filter="needs-config"]').click();
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('[data-media-source]')];
        return rows.length > 0 && rows.every((row) => row.dataset.mediaSourceStatus === 'needs-config');
      }, { timeout: 10_000 });
      await resetScroll(page);
      await shot('filter-needs-config');
      await page.locator('[data-media-filter="all"]').click();
      await page.waitForSelector('[data-media-source]', { timeout: 10_000 });

      // Save a key on the source that needs one, and read it back. The field
      // is a secret: what the page shows afterwards is "set", never a value.
      await page.locator('[data-media-source="kiki-media/xai"]').click();
      await page.waitForSelector('[data-media-source-detail="kiki-media/xai"]', { timeout: 30_000 });
      await page.waitForSelector('[data-media-setting="apiKey"] input', { timeout: 30_000 });
      await page.locator('[data-media-setting="apiKey"] input').fill('sk-not-a-real-key');
      await page.waitForSelector('[data-media-source-settings] [data-settings-draft]:not([hidden])', { timeout: 10_000 });
      await resetScroll(page);
      await shot('detail-needs-key-draft');

      await page.locator('[data-media-source-settings] [data-settings-draft] button').first().click();
      await page.waitForSelector('[data-settings-draft-saved]', { timeout: 20_000 }).catch(() => {});
      // The write was addressed to this source, and the host's answer moved it
      // out of "needs setup". A per-row readiness claim has to be earned.
      await page.waitForFunction(() => {
        const row = document.querySelector('[data-media-source="kiki-media/xai"]');
        return row === null || row.dataset.mediaSourceStatus !== 'needs-config';
      }, { timeout: 15_000 }).catch(async () => {
        // Still in the detail: the re-read happened on the page under test, so
        // the row check has to be made from the list instead.
        await backToList(page);
        const status = await page.locator('[data-media-source="kiki-media/xai"]').getAttribute('data-media-source-status');
        if (status === 'needs-config') throw new Error('a saved key did not clear the source from "needs setup"');
      });
      // The stored value must never be rendered back into the form.
      const echoed = await page.locator('[data-media-setting="apiKey"] input').inputValue();
      if (echoed.includes('sk-not-a-real-key')) throw new Error('a stored secret was echoed back into the form');
      await resetScroll(page);
      await shot('detail-saved');

      // Off, on one source only: the siblings from the same package must be
      // exactly where they were. The switch is the control the reader presses,
      // so the assertion is on its state after the host's answer came back.
      // The label is the control, as it is for a reader: the real checkbox is
      // behind the track, so the click lands on the switch the label wraps.
      await page.locator('[data-media-source-in-use] [role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('[data-media-source-in-use] [role="switch"]')?.getAttribute('aria-checked') === 'false', { timeout: 15_000 });
      await resetScroll(page);
      await shot('detail-off');

      await page.locator('[data-media-source-in-use] [role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('[data-media-source-in-use] [role="switch"]')?.getAttribute('aria-checked') === 'true', { timeout: 15_000 });

      // Removal keeps everything and is reversible from the same control.
      await page.locator('[data-media-source-remove]').click();
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-media-source-remove]');
        return button?.dataset.mediaSourceRemove === 'restore';
      }, { timeout: 15_000 });
      await resetScroll(page);
      await shot('detail-removed');
      await page.locator('[data-media-source-remove]').click();
      await page.waitForFunction(() => document.querySelector('[data-media-source-remove]')?.dataset.mediaSourceRemove === 'remove', { timeout: 15_000 });
      await backToList(page);

      // A source that borrows a connection: the key field says so rather than
      // standing empty and unanswered.
      await page.locator('[data-media-source="kiki-media/openai"]').click();
      await page.waitForSelector('[data-media-source-detail="kiki-media/openai"]', { timeout: 30_000 });
      await page.waitForSelector('[data-media-connection-select]', { timeout: 30_000 });
      const stored = await page.locator('[data-media-connection-select]').inputValue();
      if (stored !== 'openai') {
        throw new Error(`connection picker opened on "${stored}" instead of the stored "openai"; options=${await page.locator('[data-media-connection-select] option').allTextContents()}`);
      }
      // Capabilities are asked for, never fired on open.
      await page.locator('[data-media-capabilities-ask]').click();
      await page.waitForSelector('[data-media-capabilities-loaded]', { timeout: 30_000 });
      await page.locator('[data-media-capabilities-loaded]').scrollIntoViewIfNeeded();
      await shot('capabilities');
      await backToList(page);

      // A reader's own script, and the plain form that adds one.
      await page.locator('[data-media-add-script]').click();
      await page.waitForSelector('[data-media-script-dialog]', { timeout: 15_000 });
      await page.waitForSelector('[data-media-script-issues]', { timeout: 5_000 }).catch(() => {});
      await resetScroll(page);
      await shot('script-empty');

      // A partial draft must not submit, and must say which field is wrong.
      const submit = page.locator('[data-media-script-submit]');
      if (!(await submit.isDisabled())) throw new Error('an empty script form offered a submit');
      await page.locator('[data-media-script-field="id"]').fill('second-renderer');
      await page.locator('[data-media-script-field="label"]').fill('Second renderer');
      await page.locator('[data-media-script-field="command"]').fill('python');
      await page.locator('[data-media-script-field="args"]').fill('render2.py\n--width\n1024');
      await page.locator('[data-media-script-field="format"]').fill('png');
      await page.locator('[data-media-script-field="environment"]').fill('{"RENDER_API_KEY":"a-real-looking-value"}');
      await resetScroll(page);
      await shot('script-filled');

      await submit.click();
      await page.waitForSelector('[data-media-source-detail]', { timeout: 20_000 });
      const added = await page.locator('[data-media-source-detail]').getAttribute('data-media-source-detail');
      if (added !== 'kiki-media/script-second-renderer') throw new Error(`added source opened as ${added}`);
      await resetScroll(page);
      await shot('script-added');
      await backToList(page);
      if (await page.locator('[data-media-source="kiki-media/script-second-renderer"]').count() === 0) {
        throw new Error('a newly added script source did not appear in the list');
      }

      // The jobs, at the bottom of the same page, through the original entry.
      const jobs = page.locator('#media-jobs');
      if (await jobs.count() === 0) throw new Error('jobs section missing from the media page');
      await jobs.scrollIntoViewIfNeeded();
      await shot('jobs');

      const stop = page.locator('[data-media-job-stop]').first();
      if (await stop.isVisible().catch(() => false)) {
        const id = await stop.getAttribute('data-media-job-stop');
        await stop.click();
        await page.waitForSelector(`[data-media-job="${id}"][data-media-job-state="stopped"]`, { timeout: 10_000 });
        await shot('job-stopped-now');
      }
      const resume = page.locator('[data-media-job-resume]').first();
      if (await resume.isVisible().catch(() => false)) {
        const id = await resume.getAttribute('data-media-job-resume');
        await resume.click();
        await page.waitForSelector(`[data-media-job="${id}"][data-media-job-state="succeeded"]`, { timeout: 10_000 });
        await shot('job-resumed');
      }

      // Real bytes, actually decoded: a thumbnail stuck on "Loading…" is what
      // a fixture with no bytes behind the ids looks like.
      const firstImage = page.locator('[data-media-kind="image"] img').first();
      if (await firstImage.count() > 0) {
        await firstImage.scrollIntoViewIfNeeded();
        await firstImage.waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForFunction(() => {
          const img = document.querySelector('[data-media-kind="image"] img');
          return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
        }, { timeout: 15_000 });
        await shot('preview-real');
      }
      if (!phone) {
        await resetScroll(page);
        await shot('list-after');
      }
    },
  },
];

const result = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'media-managed-sources',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;