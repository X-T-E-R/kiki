/**
 * browser-control screenshots — the settings 浏览器控制 leaf, driven through
 * the real controls on the real build: the fixture seeds the connections and
 * the state each one is in, and the walk opens them, checks one, is refused at
 * connect by a gated server, refuses a driver the service refuses, edits and
 * saves, reads the connected daemon's targets and its backend catalogue, edits
 * a draft and releases the running browser under it, reveals a CDP endpoint and
 * disconnects a borrowed browser. Nothing is patched into the DOM after load, so
 * every image shows what the page does with the server's own answers.
 *
 *   node scripts/capture-browser-control.mjs              # en/light/1440
 *   node scripts/capture-browser-control.mjs --matrix=all # locale × theme × width
 *
 * Output: `.tmp/browser-control-shots` (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'browser-control-shots');

/** The settings page scrolls its own pane; a shot should start at the top. */
async function resetScroll(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
}

async function openConnection(page, id) {
  const back = page.locator('[data-browser-back]');
  if (await back.isVisible().catch(() => false)) {
    await back.click();
    await page.waitForSelector(`[data-browser-connection="${id}"]`, { timeout: 10_000 });
  }
  await page.locator(`[data-browser-connection="${id}"]`).click();
  await page.waitForSelector(`[data-browser-detail="${id}"]`, { timeout: 10_000 });
}

async function openSourcesFold(page) {
  const back = page.locator('[data-browser-back]');
  if (await back.isVisible().catch(() => false)) {
    await back.click();
    await page.waitForSelector('[data-browser-connections][data-browser-view="list"]', { timeout: 10_000 });
  }
  const fold = page.locator('[data-browser-sources]');
  await fold.waitFor({ state: 'visible', timeout: 10_000 });
  const isOpen = await fold.evaluate((el) => el instanceof HTMLDetailsElement && el.open);
  if (!isOpen) {
    await fold.locator('summary').click();
  }
}

/**
 * The native-flag trip has to land on the row that holds the switch, inside
 * the viewport — visible in the DOM is not enough, or the page is sending
 * people somewhere they still have to hunt.
 */
async function requireFlagRowInViewport(page, width, from) {
  const row = page.locator('[data-experimental-row="native_browser"]');
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  const height = width <= 600 ? 844 : 900;
  await page.waitForFunction(([selector, limit]) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box !== undefined && box.top >= 0 && box.bottom <= limit;
  }, ['[data-experimental-row="native_browser"]', height], { timeout: 5_000 })
    .catch(async () => {
      throw new Error(`${from}: the flag row is not in the viewport: ${JSON.stringify(await row.boundingBox())}`);
    });
  await resetScroll(page);
}

const scenarios = [
  {
    name: 'browser-control',
    fixture: 'browser-control',
    matrix: ['theme', 'width'],
    run: async ({ page, view, link, shot }) => {
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-browser-verdict="allowed"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-connection="research"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('connections-list');

      // The rows at the width they get with nothing open: the bridge has to read
      // as a type and a place without being opened first, so its own words are
      // measured rather than assumed.
      await page.locator('[data-browser-connections]').scrollIntoViewIfNeeded();
      const bridgeTypeAndPlace = page.locator('[data-browser-row="kimi-webbridge"] [data-browser-row-type="kimi-webbridge"]');
      await bridgeTypeAndPlace.waitFor({ state: 'visible', timeout: 10_000 });

      // The default is its own control on the list header, and "choose each time" is a real value.
      await page.locator('#browser-default').click();
      await page.waitForSelector('[role="option"][data-option-value="research"]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('default-open');
      await page.keyboard.press('Escape');

      // Browser sources fold under the list: four named sources, each saying what it still needs.
      await openSourcesFold(page);
      await page.waitForSelector('[data-browser-route="kimi-webbridge"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-route="independent-browser"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-route="codex-browser"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('wizard');

      // The managed route is the one a reader can finish without a person in
      // the loop, so it gets the primary action; once prepared, it offers the
      // primary Open action and advanced update / shortcut options.
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-prepare]').click();
      await page.waitForSelector('[data-confirm-action="confirm"]', { timeout: 10_000 });
      await shot('wizard-confirm');
      await page.locator('[data-confirm-action="confirm"]').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-browser-route-open]', { timeout: 30_000 });
      await shot('wizard-ready');

      // Advanced update / shortcut within the route
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-advanced] summary').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-browser-route-update]', { timeout: 10_000 });
      await shot('wizard-advanced-options');
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-update]').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-feedback-tone="info"]', { timeout: 10_000 });
      await shot('wizard-updated-disk');

      // Primary open action
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-open]').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-browser-route-connected]', { timeout: 30_000 });
      await shot('wizard-opened-connected');

      // Codex route: single save-and-allow path for discovered pipes.
      await page.locator('[data-browser-route="codex-browser"]').scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-browser-source-items="codex-browser"]', { timeout: 10_000 });
      await page.waitForSelector('[data-browser-route="codex-browser"] [data-browser-route-instructions]', { timeout: 10_000 });
      await page.locator('[data-browser-source-items="codex-browser"] [data-browser-allow-checkbox="codex-browser-use-pipe-1"]').click();
      await page.waitForSelector('[data-browser-row="codex-browser"]', { timeout: 10_000 });
      const connectedBadge = await page.locator('[data-browser-route="codex-browser"] [data-browser-route-connected]').count();
      if (connectedBadge !== 0) throw new Error('codex saved connection should not claim connected or approved');
      await resetScroll(page);
      await shot('wizard-codex');

      // The Kimi route: everything installed except the store approval, which
      // is a link to a page only a person can click through.
      await page.locator('[data-browser-route="kimi-webbridge"] [data-browser-route-extension]').first().scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-browser-route-blocker="extension"]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('wizard-kimi-extension');

      // A connection that was never started: normal, with the actions offered.
      await openConnection(page, 'work');
      await resetScroll(page);
      await shot('detail-idle');
      await page.locator('[data-browser-check]').click();
      await page.waitForSelector('[data-browser-outcome="check:idle"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('check-passed');

      // Starting a browser is gated on a development-candidate flag on this
      // server: checking was allowed, connecting is refused, and the page says
      // where that flag lives instead of turning green.
      await page.locator('[data-browser-connect]').click();
      await page.waitForSelector('[data-feedback-tone="error"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('connect-flag-off');

      // The managed build is a real gate: the unpatched official CLI is refused
      // with the service's own reason.
      await openConnection(page, 'qa');
      await page.locator('[data-browser-check]').click();
      await page.waitForSelector('[data-browser-outcome="check:failed"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('check-refused');
      await page.locator('[data-browser-advanced] summary').click();
      await page.locator('[data-browser-driver-input]').scrollIntoViewIfNeeded();
      await shot('advanced-driver-path');

      // A dirty draft: the running actions use the saved configuration, so they
      // are gated and the page says why.
      await page.fill('[data-browser-profile-input]', 'C:\\Users\\fixture\\kiki\\browsers\\qa-next');
      await page.waitForSelector('[data-settings-draft]:not([hidden])', { timeout: 10_000 });
      await resetScroll(page);
      await shot('draft-dirty');
      await page.locator('[data-settings-discard]').click();
      await page.waitForSelector('[data-settings-draft][hidden]', { state: 'attached', timeout: 10_000 });

      // An attached browser: connected state, the caller, the diagnostics fold.
      await openConnection(page, 'research');
      await resetScroll(page);
      await shot('detail-connected');
      await page.fill('[data-browser-name-input]', '资料整理（主）');
      await page.waitForSelector('[data-settings-draft]:not([hidden])', { timeout: 10_000 });
      await page.locator('[data-settings-draft] button').first().click();
      await page.waitForSelector('[data-saved-tick]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('saved');
      await page.locator('[data-browser-runtime-tree] summary').click();
      await page.waitForSelector('[data-browser-tabs]', { timeout: 30_000 });
      await page.locator('[data-browser-tabs]').scrollIntoViewIfNeeded();
      await shot('runtime-details');
      // The catalogue is a press of its own: opening the fold reads only the
      // daemon's targets. The press starts this connection's managed backend.
      await page.locator('[data-browser-catalog-read]').click();
      await page.waitForSelector('[data-browser-catalog]', { timeout: 30_000 });
      await page.locator('[data-browser-catalog-groups]').scrollIntoViewIfNeeded();
      await shot('runtime-catalog');
      await page.locator('[data-browser-catalog-search]').fill('page');
      await page.waitForSelector('[data-browser-catalog-hits]', { timeout: 10_000 });
      await page.locator('[data-browser-catalog-hits]').scrollIntoViewIfNeeded();
      await shot('runtime-catalog-search');
      // Schemas are a second opt-in, and they arrive on the rows the filter left.
      await page.locator('[data-browser-catalog-schema-option] [role="switch"]').click();
      await page.waitForSelector('[data-browser-catalog-schema]', { timeout: 30_000 });
      await page.locator('[data-browser-catalog-schema] summary').first().click();
      await page.locator('[data-browser-catalog-schema]').first().scrollIntoViewIfNeeded();
      await shot('runtime-catalog-schema');
      await page.locator('[data-browser-catalog-search]').fill('');
      await page.waitForSelector('[data-browser-catalog-groups]', { timeout: 10_000 });

      // A borrowed browser: endpoint masked, revealed only on request, and a
      // disconnect that keeps the browser.
      await openConnection(page, 'preview');
      await resetScroll(page);
      await shot('detail-cdp');
      await page.locator('[data-secret-reveal]').click();
      await resetScroll(page);
      await shot('cdp-revealed');
      await page.locator('[data-browser-disconnect]').click();
      await page.waitForSelector('[data-browser-outcome="disconnect:disconnected"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('disconnect-borrowed');

      // Disabled is a configuration fact, and the actions are not pretend ones.
      await openConnection(page, 'legacy');
      await resetScroll(page);
      await shot('detail-disabled');
      await page.locator('[data-browser-delete]').click();
      await page.waitForSelector('[data-confirm-action="confirm"]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('delete-confirm');
      await page.keyboard.press('Escape');

      // The Kimi bridge: a real local HTTP bridge, not an address to open. No
      // endpoint may be offered, the save has to come back as the bridge, and a
      // full reload has to read the saved name and type back from the server.
      await openConnection(page, 'kimi-webbridge');
      await page.locator('[data-browser-detail="kimi-webbridge"]').scrollIntoViewIfNeeded();
      await shot('detail-bridge');
      await page.locator('[data-browser-bridge]').scrollIntoViewIfNeeded();
      await shot('bridge-hint');
      if (await page.locator('[data-browser-detail="kimi-webbridge"] [data-secret-field]').count() !== 0) {
        throw new Error('the bridge form offered a CDP endpoint');
      }
      if (!await page.locator('[data-browser-bridge]').isVisible()) throw new Error('the bridge form never said which bridge it talks to');
      const bridgeCheck = await page.locator('[data-browser-check]').innerText();
      if (bridgeCheck.trim() !== 'Check bridge' && bridgeCheck.trim() !== '检查桥接') {
        throw new Error(`the bridge check reads ${JSON.stringify(bridgeCheck)}`);
      }
      await page.locator('[data-browser-check]').click();
      await page.waitForSelector('[data-browser-outcome="check:idle"]', { timeout: 30_000 });
      await page.locator('[data-browser-runtime]').scrollIntoViewIfNeeded();
      await shot('bridge-checked');

      // The bridge answers for its own tool list: three page tools, no backend
      // started. The fold may already be open from an earlier connection.
      if (await page.locator('[data-browser-catalog]').count() === 0) {
        await page.locator('[data-browser-runtime-tree] summary').click();
        await page.waitForSelector('[data-browser-catalog-read]', { timeout: 10_000 });
        await page.locator('[data-browser-catalog-read]').click();
      }
      await page.waitForSelector('[data-browser-catalog-count]', { timeout: 30_000 });
      const bridgeToolCount = await page.locator('[data-browser-catalog-count]').innerText();
      if (bridgeToolCount.trim() !== '3') throw new Error(`the bridge catalogue reports ${JSON.stringify(bridgeToolCount)} tools`);
      // The bridge's own isolation model, in words: the main frame of the
      // selected tab, never the managed driver's opaque window context.
      const bridgeIsolation = page.locator('[data-browser-catalog-isolation]');
      const isolationText = await bridgeIsolation.innerText();
      if (isolationText !== 'main frame only' && isolationText !== '仅主帧') {
        throw new Error(`the bridge isolation reads ${JSON.stringify(isolationText)}`);
      }
      if (await bridgeIsolation.getAttribute('title') !== 'main-frame-only') throw new Error('the bridge isolation lost its server token');
      await page.locator('[data-browser-catalog]').scrollIntoViewIfNeeded();
      await shot('bridge-catalog');
      await page.fill('[data-browser-name-input]', '日常 Edge（桥接）');
      await page.waitForSelector('[data-settings-draft]:not([hidden])', { timeout: 10_000 });
      await page.locator('[data-settings-draft] button').first().click();
      await page.waitForSelector('[data-saved-tick]', { timeout: 30_000 });
      await page.locator('[data-browser-detail="kimi-webbridge"]').scrollIntoViewIfNeeded();
      await shot('bridge-saved');
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-browser-connection="kimi-webbridge"]', { timeout: 30_000 });
      await openConnection(page, 'kimi-webbridge');
      if (await page.locator('[data-browser-name-input]').inputValue() !== '日常 Edge（桥接）') {
        throw new Error('the bridge name did not persist');
      }
      if (await page.locator('[data-browser-detail="kimi-webbridge"] [data-secret-field]').count() !== 0) {
        throw new Error('the reloaded bridge form offered an endpoint');
      }

      // Add browser view: setup wizard + manual connection form.
      await page.locator('[data-browser-back]').click();
      await page.waitForSelector('[data-browser-add]', { timeout: 10_000 });
      await page.locator('[data-browser-add]').click();
      await page.waitForSelector('[data-browser-add-view]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('add-browser-view');
      await page.locator('[data-browser-other]').scrollIntoViewIfNeeded();
      await shot('other-ecosystems');
      await page.locator('[data-browser-add-manual]').click();
      await page.waitForSelector('[data-browser-detail="new"]', { timeout: 10_000 });
      await page.fill('[data-browser-id-input]', 'staging');
      await page.fill('[data-browser-name-input]', '预发布检查');
      // The bridge is one of the styles a new record can be saved as: the Kimi
      // route only probes the local bridge and never saves a connection.
      await page.locator('#browser-type').click();
      await page.waitForSelector('[role="option"][data-option-value="kimi-webbridge"]', { timeout: 10_000 });
      await shot('create-style-options');
      await page.locator('[role="option"][data-option-value="agent-browser-cdp"]').click();
      await page.waitForSelector('[data-secret-field]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('create-cdp');

      // Releasing a running browser under an edited draft: the two actions that
      // write through the saved configuration are gated, this one is not, and
      // the draft has to survive the release. The new-connection draft above is
      // unsaved, so it is discarded first — the page asks before dropping it.
      await page.locator('[data-settings-discard]').click();
      await page.waitForSelector('[data-settings-discard]', { state: 'detached', timeout: 10_000 });
      await openConnection(page, 'research');
      await page.fill('[data-browser-profile-input]', 'C:\\Users\\fixture\\kiki\\browsers\\research-next');
      await page.waitForSelector('[data-settings-draft]:not([hidden])', { timeout: 10_000 });
      if (await page.locator('[data-browser-disconnect]').isDisabled()) throw new Error('disconnect is still gated by the draft');
      if (!await page.locator('[data-browser-connect]').isDisabled()) throw new Error('connect should be gated by the draft');
      await resetScroll(page);
      await shot('dirty-disconnect');
      await page.locator('[data-browser-disconnect]').click();
      await page.waitForSelector('[data-browser-outcome="disconnect:disconnected"]', { timeout: 30_000 });
      if (await page.locator('[data-browser-profile-input]').inputValue() !== 'C:\\Users\\fixture\\kiki\\browsers\\research-next') {
        throw new Error('the edited draft did not survive the disconnect');
      }
      if (await page.locator('[data-settings-draft]').isHidden()) throw new Error('the draft footer closed after a disconnect');
      await resetScroll(page);
      await shot('dirty-disconnect-released');

      // The trip the refusal offers: it has to land on the rows that hold the
      // flag, in the viewport, not just in the DOM — otherwise the page is
      // sending people somewhere that does not have the switch.
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-browser-connection="work"]', { timeout: 30_000 });
      await openConnection(page, 'work');
      await page.locator('[data-browser-connect]').click();
      await page.waitForSelector('[data-browser-open-flag]', { timeout: 30_000 });
      await page.locator('[data-browser-open-flag]').click();
      await requireFlagRowInViewport(page, view.width, "the connection card's flag trip");
      await shot('flag-home');
    },
  },
  {
    name: 'ego-lite',
    fixture: 'ego-lite',
    matrix: ['width'],
    run: async ({ page, link, shot }) => {
      const route = page.locator('[data-browser-route="ego-lite"]');
      const check = route.locator('[data-browser-route-connect]');
      const chosen = 'C:/Ego/0.6.0.15/ego-browser.exe';
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await openSourcesFold(page);
      await page.waitForSelector('[data-browser-route="kimi-webbridge"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-route="independent-browser"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-route="codex-browser"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-route="ego-lite"][data-browser-route-state="needs-action"]', { timeout: 30_000 });
      if (await route.locator('[data-browser-route-prepare]').count() !== 0) throw new Error('Ego Lite must not offer Set up');
      await page.waitForSelector('[data-browser-route="ego-lite"] [data-browser-route-ego-next]', { timeout: 15_000 });
      const installedNext = await route.locator('[data-browser-route-ego-next]').innerText();
      if (installedNext.includes('Download Ego Lite yourself') || installedNext.includes('请自行下载 Ego Lite')) {
        throw new Error(`installed next step still asks for a download: ${installedNext}`);
      }
      await route.scrollIntoViewIfNeeded();
      await shot('ego-installed');

      await check.click();
      await page.waitForSelector('[data-browser-route="ego-lite"] [data-browser-route-ego-next]', { timeout: 15_000 });
      if (await route.locator('[data-browser-route-error]').count() !== 0) throw new Error('onboarding is not an error');
      const onboardingNext = await route.locator('[data-browser-route-ego-next]').innerText();
      if (onboardingNext.includes('Please complete the onboarding process first')) throw new Error('onboarding next step is the raw diagnosis');
      await route.scrollIntoViewIfNeeded();
      await shot('ego-onboarding');

      await check.click();
      await page.waitForSelector('#ego-cli-select', { timeout: 15_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-browser-route="ego-lite"] [data-browser-route-connect]');
        return button instanceof HTMLButtonElement && button.disabled;
      });
      await route.scrollIntoViewIfNeeded();
      await shot('ego-choose');

      await page.locator('#ego-cli-select').click();
      const option = page.locator(`[role="option"][data-option-value="${chosen}"]`);
      await option.waitFor({ state: 'visible', timeout: 10_000 });
      await option.click();
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-browser-route="ego-lite"] [data-browser-route-connect]');
        return button instanceof HTMLButtonElement && !button.disabled;
      });
      await check.click();
      await page.waitForSelector('[data-browser-route="ego-lite"][data-browser-route-state="ready"]', { timeout: 15_000 });
      const readyNext = await route.locator('[data-browser-route-ego-next]').innerText();
      if (readyNext.includes('Download Ego Lite yourself') || readyNext.includes('请自行下载 Ego Lite')) {
        throw new Error(`ready next step still asks for a download: ${readyNext}`);
      }
      await route.scrollIntoViewIfNeeded();
      await shot('ego-ready');

      await page.waitForSelector('[data-browser-connection="ego-lite"]', { timeout: 10_000 });
      await page.locator('[data-browser-connection="ego-lite"]').click();
      await page.waitForSelector('[data-browser-detail="ego-lite"]', { timeout: 10_000 });
      await page.locator('[data-browser-detail="ego-lite"] [data-browser-advanced] summary').click();
      const cli = page.locator('[data-browser-cli-input]');
      await cli.waitFor({ state: 'visible', timeout: 10_000 });
      const value = await cli.inputValue();
      if (value !== chosen) throw new Error(`saved CLI path was ${JSON.stringify(value)}`);
      await cli.scrollIntoViewIfNeeded();
      await shot('ego-cli');
    },
  },
  {
    // The card that has to be located loads its own data. This run holds that
    // read for 2.5s — past the window the page used to wait out — and requires
    // the flag row to end up in the viewport anyway.
    name: 'browser-control-late-card',
    fixture: 'browser-control',
    matrix: [],
    run: async ({ page, view, link, shot }) => {
      const height = view.width <= 600 ? 844 : 900;
      await page.route((url) => url.pathname.endsWith('/meta'), async (route) => {
        await new Promise((resolve) => { setTimeout(resolve, 2500); });
        await route.continue();
      });
      // `link()` appends the fixture query, so the hash has to come after it.
      await page.goto(`${link('/settings/developer')}#st-card-exp-developer`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const row = page.locator('[data-experimental-row="native_browser"]');
      await row.waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForFunction(([selector, limit]) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box !== undefined && box.top >= 0 && box.bottom <= limit;
      }, ['[data-experimental-row="native_browser"]', height], { timeout: 5_000 })
        .catch(async () => {
          const box = await row.boundingBox();
          throw new Error(`the late card was not located in the viewport: ${JSON.stringify(box)}`);
        });
      await shot('late-card-located');
      if (view.width > 600) {
        // The same handshake in the phone layout, where the card sits much
        // further down: a fresh load, still with the held read.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${link('/settings/developer')}#st-card-exp-developer`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await row.waitFor({ state: 'visible', timeout: 60_000 });
        await page.waitForFunction(([selector, limit]) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return box !== undefined && box.top >= 0 && box.bottom <= limit;
        }, ['[data-experimental-row="native_browser"]', 844], { timeout: 5_000 })
          .catch(async () => {
            const box = await row.boundingBox();
            throw new Error(`the late card was not located in the phone viewport: ${JSON.stringify(box)}`);
          });
        await shot('late-card-located-390');
      }
    },
  },
];

const result = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'browser-control',
});
console.log(`browser-control shots in ${result.outputDir}`);
if (result.failed.length > 0) process.exitCode = 1;
