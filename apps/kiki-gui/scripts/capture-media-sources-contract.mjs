/**
 * media-sources-contract — the three states a reader only reaches on a real
 * server, captured against a host that refuses.
 *
 * This is deliberately NOT the 132-shot happy-path walk. It covers only the
 * states the narrow repair changed, and every one of them is a state a
 * screenshot of a working host can never produce:
 *
 *   1. a refused save, with the typed key still on screen and no "saved" tick
 *      — while the ordinary read keeps answering normally;
 *   2. the advanced fold opened, so a source's command, arguments and working
 *      directory are actually visible rather than inert behind a closed panel;
 *   3. a refused per-modality default, where the switch does not move and the
 *      previous holder keeps the badge.
 *
 * The happy path this shares a scenario with is unchanged and already proven;
 * re-shooting it would add images and no information.
 *
 *   node scripts/capture-media-sources-contract.mjs
 *
 * Output: `.tmp/media-contract-shots` (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'media-contract-shots');

const FIXTURE = 'media-sources-refused';

async function resetScroll(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
}

async function backToList(page) {
  if (await page.locator('[data-media-source-detail]').count() === 0) return;
  await page.locator('[data-media-source-back]').click();
  const confirm = page.locator('[role="alertdialog"] button').last();
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
  await page.waitForSelector('[data-media-source-list]', { timeout: 15_000 });
}

const scenarios = [
  {
    name: 'media-sources-contract',
    fixture: FIXTURE,
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      await page.goto(link('/capabilities?view=media&session=session_fixture_media'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-media-source-list]', { timeout: 30_000 });
      await resetScroll(page);

      // ---- 1. A refused save ------------------------------------------------
      // xAI Media's host refuses, and its write is also slow, so the two
      // failure modes are separated: mid-flight the form must still hold the
      // typed key, and after the refusal it must still hold it and say why.
      await page.locator('[data-media-source="kiki-media/xai"] button').click();
      await page.waitForSelector('[data-media-setting="apiKey"] [data-secret-field] input', { timeout: 30_000 });
      await page.locator('[data-media-setting="apiKey"] [data-secret-field] input').fill('sk-not-a-real-key');
      await page.waitForSelector('[data-media-source-settings] [data-settings-draft]:not([hidden])', { timeout: 10_000 });
      await resetScroll(page);
      await shot('refused-draft');

      // Watch the form's own state for the whole write, recording every
      // change with a timestamp. Sampling after the fact would race the write;
      // a MutationObserver installed BEFORE the click cannot miss a moment, so
      // "the saved tick appeared while the write was open" becomes a fact about
      // the timeline rather than a lucky poll.
      await page.evaluate(() => {
        const root = document.querySelector('[data-media-source-settings]');
        window.__saveTimeline = [];
        const start = performance.now();
        const record = (what) => { window.__saveTimeline.push({ what, at: Math.round(performance.now() - start) }); };
        record('observed');
        window.__saveObserver = new MutationObserver(() => {
          record([
            root?.querySelector('fieldset')?.disabled === true ? 'busy' : 'idle',
            root?.querySelector('[data-settings-draft-saved]') ? 'SAVED' : '',
            root?.querySelector('[data-settings-draft][data-dirty]') ? 'dirty' : '',
            root?.querySelector('[data-feedback-tone="error"]') ? 'error' : '',
          ].filter(Boolean).join('+') || 'idle');
        });
        if (root) window.__saveObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'data-dirty', 'hidden'] });
      });

      await page.locator('[data-media-source-settings] [data-settings-draft] button').first().click();
      await page.waitForSelector('[data-feedback-tone="error"]', { timeout: 20_000 });
      const timeline = await page.evaluate(() => {
        window.__saveObserver?.disconnect();
        return window.__saveTimeline;
      });
      // The write is open between the first "busy" and the first non-busy
      // sample. Nothing in that window may claim the save landed.
      const opened = timeline.findIndex((step) => step.what.includes('busy'));
      const settled = timeline.findIndex((step, index) => index > opened && !step.what.includes('busy'));
      if (opened < 0) throw new Error(`the form never showed the write as in progress: ${JSON.stringify(timeline)}`);
      if (settled < 0) throw new Error(`the write never finished: ${JSON.stringify(timeline)}`);
      const inFlight = timeline.slice(opened, settled);
      if (inFlight.some((step) => step.what.includes('SAVED'))) {
        throw new Error(`the form claimed a save while the write was still in flight: ${JSON.stringify(timeline)}`);
      }
      if (timeline.some((step) => step.what.includes('SAVED'))) {
        throw new Error(`a refused save still showed the saved tick: ${JSON.stringify(timeline)}`);
      }
      await resetScroll(page);
      await shot('refused-save');

      // The three things a refused save has to be true about, checked on the
      // page rather than trusted to the screenshot.
      const kept = await page.locator('[data-media-setting="apiKey"] [data-secret-field] input').inputValue();
      if (kept !== 'sk-not-a-real-key') throw new Error(`a refused save dropped the typed key: "${kept}"`);
      if (await page.locator('[data-settings-draft-saved]').count() > 0) throw new Error('a refused save still showed the saved tick');
      if (await page.locator('[data-settings-draft][data-dirty]').count() === 0) throw new Error('a refused save cleared the dirty draft');
      // The sibling check is made from the list, because the detail is open
      // here and a row cannot be read while it is not on screen.
      await backToList(page);
      const siblings = await page.locator('[data-media-source="kiki-media/ark"]').getAttribute('data-media-source-status');
      const own = await page.locator('[data-media-source="kiki-media/xai"]').getAttribute('data-media-source-status');
      if (siblings !== 'needs-config') throw new Error(`a sibling source moved when another one was written: ark is ${siblings}`);
      if (own !== 'needs-config') throw new Error(`a refused write changed the source's own state: xai is ${own}`);
      await page.locator('[data-media-source="kiki-media/xai"] button').click();
      await page.waitForSelector('[data-media-setting="apiKey"] [data-secret-field] input', { timeout: 30_000 });

      // ---- 2. The advanced fold --------------------------------------------
      // Open on a source whose command is the fact a reader cannot guess.
      await backToList(page);
      await page.locator('[data-media-source="kiki-media/local-renderer"] button').click();
      await page.waitForSelector('[data-media-source-detail="kiki-media/local-renderer"]', { timeout: 30_000 });
      const closed = page.locator('[data-media-source-advanced]');
      // A reader's own script opens folded-OUT on arrival: its command is the
      // one fact about it that cannot be guessed, and a source detail reached
      // to inspect a script should not hide it behind one more click.
      if (await closed.getAttribute('data-open') !== 'true') throw new Error('a script detail did not open its advanced fold');
      if (await closed.locator('[inert]').count() > 0) throw new Error('the open fold still marks its content inert');
      const expanded = await closed.locator('button').getAttribute('aria-expanded');
      if (expanded !== 'true') throw new Error(`the fold reports aria-expanded=${expanded}`);
      const advancedText = (await closed.innerText()).replace(/\s+/g, ' ');
      if (!advancedText.includes('python')) throw new Error(`the command is not in the opened fold: ${advancedText}`);
      // Frame the shot on the command. The assertion above proves the text is
      // in the DOM, but a picture of the top of the page would not show it.
      // Reset first, then scroll: the reset zeroes every scrollTop, so doing it
      // afterwards would put the page back where this started.
      await resetScroll(page);
      await closed.scrollIntoViewIfNeeded();
      await shot('advanced-open');

      // It still folds away on demand, and the content goes inert again, so
      // a reader who did not come for it is not left reading a wall.
      await closed.locator('button').click();
      await page.waitForFunction(() => document.querySelector('[data-media-source-advanced]')?.getAttribute('data-open') === 'false', { timeout: 5_000 });
      if (await closed.locator('[inert]').count() === 0) throw new Error('a closed fold left its content focusable');
      await resetScroll(page);
      await closed.scrollIntoViewIfNeeded();
      await shot('advanced-closed');
      await closed.locator('button').click();
      await page.waitForFunction(() => document.querySelector('[data-media-source-advanced]')?.getAttribute('data-open') === 'true', { timeout: 5_000 });

      // An ordinary source's fold starts closed and opens on demand: the
      // default is not a special case, only the entry point differs.
      await backToList(page);
      await page.locator('[data-media-source="kiki-media/openai"] button').click();
      await page.waitForSelector('[data-media-source-detail="kiki-media/openai"]', { timeout: 30_000 });
      const ordinary = page.locator('[data-media-source-advanced]');
      if (await ordinary.getAttribute('data-open') !== 'false') throw new Error('an ordinary source opens the advanced fold by itself');
      if (await ordinary.locator('[inert]').count() === 0) throw new Error('a closed fold left its content focusable');
      await ordinary.locator('button').click();
      await page.waitForFunction(() => document.querySelector('[data-media-source-advanced]')?.getAttribute('data-open') === 'true', { timeout: 5_000 });
      await resetScroll(page);
      await shot('advanced-open-ordinary');
      await backToList(page);

      // ---- 3. A refused default --------------------------------------------
      // The media package refuses its settings in this scenario, so pressing
      // "make default" must leave the switch alone and keep the old holder.
      await page.locator('[data-media-source="kiki-media/minimax"] button').click();
      await page.waitForSelector('[data-media-source-detail="kiki-media/minimax"]', { timeout: 30_000 });
      const before = await page.locator('[data-media-default="image"]').getAttribute('data-media-default-on');
      await page.locator('[data-media-default="image"]').click();
      await page.waitForSelector('[data-media-defaults-error]', { timeout: 20_000 });
      const after = await page.locator('[data-media-default="image"]').getAttribute('data-media-default-on');
      if (after !== before) throw new Error(`a refused default moved the switch: ${before} -> ${after}`);
      await resetScroll(page);
      await shot('default-refused');

      // Per modality, and read in the detail: a list row carries ONE status for
      // the whole source, and this source already holds the VIDEO default, so
      // the row cannot tell whether the IMAGE pointer moved. The switches can.
      const imageOff = await page.locator('[data-media-default="image"]').getAttribute('data-media-default-on');
      const videoOn = await page.locator('[data-media-default="video"]').getAttribute('data-media-default-on');
      if (imageOff !== 'false') throw new Error(`a refused image default still reads as set: image=${imageOff}`);
      // The modality that was NOT touched kept its own holder, which is the
      // failure a write that patched the wrong key would cause.
      if (videoOn !== 'true') throw new Error(`a refused image write disturbed the video default: video=${videoOn}`);

      await backToList(page);
      // And the list agrees, with no reload between the refused write and this
      // read: the source that held the image pointer still holds it.
      const imageHolder = await page.locator('[data-media-source="kiki-media/openai"]').getAttribute('data-media-source-status');
      if (imageHolder !== 'default') throw new Error(`the image default left its holder: openai is ${imageHolder}`);
      await resetScroll(page);
      await shot('default-unchanged');

      if (view.width > 600) {
        // One happy-path control, to show the refusal states are about the
        // source pressed and not about the page being broken: a source whose
        // host accepts writes still saves, on the same page.
        await page.locator('[data-media-source="kiki-media/comfyui"] button').click();
        await page.waitForSelector('[data-media-setting="workflow"] input', { timeout: 30_000 });
        await page.locator('[data-media-setting="workflow"] input').fill('portrait-v3');
        await page.locator('[data-media-source-settings] [data-settings-draft] button').first().click();
        await page.waitForSelector('[data-settings-draft-saved]', { timeout: 20_000 });
        await resetScroll(page);
        await shot('accepted-save');
      }

      // ---- 4. A refused script add -----------------------------------------
      // The narrow repair made the script add awaitable and rejectable like
      // every other write, so a host refusal now surfaces here instead of
      // vanishing. The id below is one the fixture already has, which is how a
      // real host refuses: adding would replace handles that jobs still use.
      // On 390 this is also where the dialog's own scroll is worth a look — the
      // form is taller than a phone, and a reader who cannot reach the buttons
      // at the bottom has no way to try at all.
      await backToList(page);
      await page.locator('[data-media-add-script]').click();
      await page.waitForSelector('[data-media-script-dialog]', { timeout: 15_000 });
      await page.locator('[data-media-script-field="id"]').fill('local-renderer');
      await page.locator('[data-media-script-field="label"]').fill('My Own Renderer');
      await page.locator('[data-media-script-field="command"]').fill('python');
      await page.locator('[data-media-script-field="args"]').fill('render.py --preview');
      await page.locator('[data-media-script-field="cwd"]').fill('C:/tools/render');
      // Scroll the dialog to its end, which is what a reader on a phone does,
      // and check the buttons are actually there rather than off-screen. The
      // hook sits on the fixed backdrop; the panel that scrolls is inside it.
      const panel = page.locator('[data-media-script-dialog] > div').last();
      await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const submit = page.locator('[data-media-script-submit]');
      if (await submit.count() === 0) throw new Error('the script dialog has no submit button at the end of its scroll');
      if (await submit.isVisible() === false) throw new Error('the script submit button is not reachable after scrolling to the end');
      const reach = await submit.boundingBox();
      const size = page.viewportSize();
      if (reach === null || reach.y + reach.height > size.height + 1) {
        throw new Error(`the script submit button sits outside the viewport: ${JSON.stringify(reach)} in ${JSON.stringify(size)}`);
      }
      await shot('script-dialog-bottom');

      await submit.click();
      // The host's answer lands on the feedback line, not in the pre-flight
      // issue list: the list is for what this form can tell before it tries.
      await page.waitForSelector('[data-media-script-dialog] [data-feedback-tone="error"]', { timeout: 20_000 });
      // And it is stated rather than swallowed, with everything the reader
      // typed still in place to fix and retry.
      const reason = (await page.locator('[data-media-script-dialog] [data-feedback-tone="error"]').innerText()).replace(/\s+/g, ' ');
      if (reason.trim() === '') throw new Error('a refused script add said nothing about why');
      for (const [field, expected] of [['id', 'local-renderer'], ['label', 'My Own Renderer'], ['command', 'python'], ['args', 'render.py --preview'], ['cwd', 'C:/tools/render']]) {
        const keptValue = await page.locator(`[data-media-script-field="${field}"]`).inputValue();
        if (keptValue !== expected) throw new Error(`a refused script add changed the ${field} the reader typed: "${keptValue}"`);
      }
      if (await page.locator('[data-media-script-dialog]').count() === 0) throw new Error('a refused script add closed the dialog');
      await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await shot('script-add-refused');
    },
  },
];

const result = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'media-sources-contract',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;