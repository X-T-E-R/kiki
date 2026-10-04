/**
 * media-sources screenshots — the media surface at the two widths that matter,
 * driven through the real controls on the real build. The fixture seeds the
 * providers, their settings and their jobs; the walk opens rows, searches,
 * filters, edits a draft, and reads the jobs back. Nothing is patched into the
 * DOM after load, so every image shows what the page does with the server's own
 * answers.
 *
 *   node scripts/capture-media-sources.mjs
 *   node scripts/capture-media-sources.mjs --fixture=media-sources-many
 *
 * Output: `.tmp/media-sources-shots` (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'media-sources-shots');


/**
 * Back to the list. A dirty form asks before it lets go, so accept the ask
 * rather than forcing the route — the point of the shot is that the guard is
 * there, not that it can be walked past.
 */
async function backToList(page) {
  if (await page.locator('[data-media-source-detail]').isVisible().catch(() => false) === false) return;
  await page.locator('[data-media-source-back]').click();
  // The dirty guard is a dialog with a confirm; accept it rather than forcing
  // the route, and say so when neither appears so a broken step is legible.
  const confirm = page.locator('[role="alertdialog"] button').last();
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
  await page.waitForSelector('[data-media-source-list]', { timeout: 15_000 }).catch(async () => {
    const seen = await page.locator('[data-plugins-view]').getAttribute('data-plugins-view').catch(() => 'none');
    const dialogs = await page.locator('[role="alertdialog"], [role="dialog"]').count();
    throw new Error(`back to list failed: view=${seen} dialogs=${dialogs} dirty=${await page.locator('[data-settings-draft][data-dirty]').count()}`);
  });
}

/** The capabilities page scrolls its own pane; a shot starts at the top. */
async function resetScroll(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
}

const fixture = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice('--fixture='.length) ?? 'media-sources';
const many = fixture.endsWith('-many');

const scenarios = [
  {
    name: 'media-sources',
    fixture,
    matrix: ['theme', 'width'],
    run: async ({ page, view, link, shot }) => {
      // Both widths come out of one run: the list has to survive a phone
      // column, and the states under it have to stay readable there.
      const phone = view.width <= 600;
      // The session is named explicitly: the job list is scoped to it, and a
      // fresh profile has no last-session to fall back on.
      await page.goto(link(`/capabilities?view=media&session=session_fixture_media`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-media-sources-view="list"]', { timeout: 30_000 });
      await page.waitForSelector('[data-media-source-list]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('list');

      if (many) {
        // The scale case: a search that finds a family, and a filter that
        // leaves only the rows that would actually fail.
        await page.locator('[data-media-sources] input[type="search"]').fill('atlas');
        await page.waitForFunction(() => {
          const rows = document.querySelectorAll('[data-media-source]');
          return rows.length > 0 && rows.length < 30;
        }, { timeout: 10_000 });
        await resetScroll(page);
        await shot('search');

        await page.locator('[data-media-sources] input[type="search"]').fill('');
        // A modality band, and a state band. Both counts are read off the list
        // the host sent, so a band that is empty is simply not offered.
        await page.locator('[data-media-filter="video"]').click();
        await page.waitForSelector('[data-media-source]', { timeout: 10_000 });
        await resetScroll(page);
        await shot('filter-video');
        await page.locator('[data-media-filter="error"]').click();
        await page.waitForSelector('[data-media-source-status="broken"]', { timeout: 10_000 });
        await resetScroll(page);
        await shot('filter-unavailable');
        await page.locator('[data-media-filter="all"]').click();
        await page.waitForSelector('[data-media-source]', { timeout: 10_000 });
      } else {
        // The states case: each row is a different situation, and the jobs
        // under them are the honesty cases.
        await page.locator('[data-media-source="kiki-media-xai/images"]').click();
        await page.waitForSelector('[data-media-source-detail="kiki-media-xai/images"]', { timeout: 30_000 });
        await page.waitForSelector('[data-media-source-settings]', { timeout: 30_000 });
        await resetScroll(page);
        await shot('detail-needs-key');

        // A dirty draft: the footer appears and the value is still the
        // reader's, not a saved one.
        await page.locator('[data-media-setting="apiKey"] input').fill('sk-not-a-real-key');
        await page.waitForSelector('[data-media-source-settings] [data-settings-draft]:not([hidden])', { timeout: 10_000 }).catch(() => {});
        await resetScroll(page);
        await shot('detail-draft');

        // Release the draft the way a reader would, then leave. The guard on
        // a dirty form is product behaviour, not an obstacle to route around.
        await page.locator('[data-media-source-settings] [data-settings-discard]').first().click();
        await backToList(page);

        // A provider that borrows a connection: the key field says so rather
        // than standing empty and unanswered.
        await page.locator('[data-media-source="kiki-media-openai/images"]').click();
        await page.waitForSelector('[data-media-source-detail="kiki-media-openai/images"]', { timeout: 30_000 });
        await page.waitForSelector('[data-media-connection-select]', { timeout: 30_000 });
        // The stored connection must be the one the picker opens on: a select
        // whose value is not among its options silently shows the first, which
        // would report "manages its own credentials" for a configured provider.
        const stored = await page.locator('[data-media-connection-select]').inputValue();
        if (stored !== 'openai') {
          throw new Error(`connection picker opened on "${stored}" instead of the stored "openai"; options=${await page.locator('[data-media-connection-select] option').allTextContents()}`);
        }
        await resetScroll(page);
        await shot('detail-connection');

        // Capabilities are asked for, never fired on open.
        await page.locator('[data-media-capabilities-ask]').click();
        await page.waitForSelector('[data-media-capabilities-loaded]', { timeout: 30_000 });
        await page.locator('[data-media-capabilities-loaded]').scrollIntoViewIfNeeded();
        await shot('capabilities');
        await backToList(page);

        // A provider that manages its own credentials is ready, not broken.
        await page.locator('[data-media-source="my-own-script/render"]').click();
        await page.waitForSelector('[data-media-source-detail="my-own-script/render"]', { timeout: 30_000 });
        await resetScroll(page);
        await shot('detail-self-managed');
        await backToList(page);
      }

      // The jobs, at the bottom of the same page. Each one is a state the view
      // has to tell apart honestly.
      if (many) {
        await page.locator('#media-jobs').scrollIntoViewIfNeeded();
        await shot('jobs');
      } else {
        // The job list is scoped to the session in the URL; if the section is
        // absent the walk says so rather than skipping a state silently.
        const jobs = page.locator('#media-jobs');
        if (await jobs.count() === 0) {
          const mediaView = await page.locator('[data-media-sources-view]').getAttribute('data-media-sources-view').catch(() => 'none');
          const detail = await page.locator('[data-media-source-detail]').count();
          const subs = await page.locator('[data-media-subscriptions]').count();
          throw new Error(`jobs missing; mediaView=${mediaView} detail=${detail} subs=${subs}`);
        }
        if (await jobs.isVisible().catch(() => false)) {
          await jobs.scrollIntoViewIfNeeded();
          await shot('jobs');
          // The unknown-submission job must not offer a retry.
          const unknown = page.locator('[data-media-job-unknown]');
          if (await unknown.isVisible().catch(() => false)) {
            await unknown.scrollIntoViewIfNeeded();
            await shot('job-unknown');
          }
          // The local stop must read as a local stop.
          const stopped = page.locator('[data-media-job-local-stop]');
          if (await stopped.isVisible().catch(() => false)) {
            await stopped.scrollIntoViewIfNeeded();
            await shot('job-stopped');
          }

          // The two owner-scoped actions, actually pressed. These are the
          // only calls in the whole view that leave the session, so a button
          // that renders but does nothing would be invisible to every other
          // assertion here.
          const stop = page.locator('[data-media-job-stop]').first();
          if (await stop.isVisible().catch(() => false)) {
            const id = await stop.getAttribute('data-media-job-stop');
            await stop.click();
            await page.waitForSelector(`[data-media-job="${id}"][data-media-job-state="stopped"]`, { timeout: 10_000 });
            await stop.scrollIntoViewIfNeeded();
            await shot('job-stopped-now');
          } else {
            throw new Error('no stop control on a running job; stop/resume is unreachable from the view');
          }

          const resume = page.locator('[data-media-job-resume]').first();
          if (await resume.isVisible().catch(() => false)) {
            const id = await resume.getAttribute('data-media-job-resume');
            await resume.click();
            await page.waitForSelector(`[data-media-job="${id}"][data-media-job-state="succeeded"]`, { timeout: 10_000 });
            await resume.scrollIntoViewIfNeeded();
            await shot('job-resumed');
          } else {
            throw new Error('no resume control on a stopped job with a remote handle');
          }
        }
        // The discovery roster is a different question from what is installed.
        const subs = page.locator('[data-media-subscriptions-toggle]');
        if (await subs.isVisible().catch(() => false)) {
          await subs.scrollIntoViewIfNeeded();
          await shot('subscriptions');
        }

        // Real bytes, actually decoded and actually played. A thumbnail stuck
        // on "Loading…" is what a fixture with no bytes behind the ids looks
        // like, and it is indistinguishable from a working surface unless
        // something checks that an <img> resolved to real pixels. The
        // thumbnail only mounts once it intersects the viewport, so the check
        // scrolls to it first rather than assuming it is already there.
        const firstImage = page.locator('[data-media-kind="image"]').first();
        await firstImage.scrollIntoViewIfNeeded();
        const decoded = page.locator('[data-media-kind="image"] img').first();
        await decoded.waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForFunction(
          () => {
            const img = document.querySelector('[data-media-kind="image"] img');
            return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
          },
          { timeout: 15_000 },
        );
        const natural = await decoded.evaluate((img) => (img instanceof HTMLImageElement ? { w: img.naturalWidth, h: img.naturalHeight } : null));
        await shot('preview-real');
        if (natural === null || natural.w === 0) throw new Error(`preview never decoded: ${JSON.stringify(natural)}`);

        const play = page.locator('[data-media-audio-state="idle"]').first();
        if (await play.isVisible().catch(() => false)) {
          await play.scrollIntoViewIfNeeded();
          await play.click();
          // The ready <audio> element itself carries the state attribute, so
          // the selector is the element and not a descendant of it.
          const readyAudio = page.locator('audio[data-media-audio-state="ready"]').first();
          try {
            await readyAudio.waitFor({ state: 'visible', timeout: 15_000 });
          } catch (timeoutFailure) {
            const state = await page.locator('[data-media-audio]').first().getAttribute('data-media-audio-state').catch(() => 'none');
            throw new Error(`audio never became ready; state=${state}`);
          }
          // A resolved element is not a playable one: ask the element whether
          // it actually decoded a duration and a source.
          const clip = await readyAudio.evaluate(async (el) => {
            if (!(el instanceof HTMLAudioElement)) return null;
            if (el.readyState < 1) {
              await new Promise((done) => { el.addEventListener('loadedmetadata', done, { once: true }); setTimeout(done, 5000); });
            }
            return { duration: el.duration, src: el.currentSrc.slice(0, 32), readyState: el.readyState };
          });
          await shot('audio-ready');
          if (clip === null || !(clip.duration > 0)) {
            throw new Error(`audio element has no playable duration: ${JSON.stringify(clip)}`);
          }
        }
      }
      if (!phone) await shot('list-after');
    },
  },
];

const result = await runProof({
  root: ROOT,
  scenarios,
  // The fixture selector is this script's own argument; the runner takes no such flag.
  argv: process.argv.slice(2).filter((arg) => !arg.startsWith('--fixture=')),
  label: 'media-sources',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;
