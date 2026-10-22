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
 *   node scripts/capture-browser-control.mjs --only=webbridge-command --matrix=all
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
      // A wide job takes the phone-width twin of the states that have to survive
      // the narrow layout, so both widths come out of one run.
      const phoneWidth = view.width > 600;
      const phoneShot = async (name) => {
        if (!phoneWidth) return;
        await page.setViewportSize({ width: 390, height: 844 });
        await shot(name);
        await page.setViewportSize({ width: view.width, height: 900 });
      };
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // The wizard is the opening state: three named routes, each saying what
      // it still needs. Nothing below it has to be opened to see this.
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
      await phoneShot('wizard-ready-390');

      // Advanced update / shortcut within the route
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-advanced] summary').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-browser-route-update]', { timeout: 10_000 });
      await shot('wizard-advanced-options');
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-update]').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-feedback-tone="info"]', { timeout: 10_000 });
      await shot('wizard-updated-disk');
      await phoneShot('wizard-updated-disk-390');

      // Primary open action
      await page.locator('[data-browser-route="independent-browser"] [data-browser-route-open]').click();
      await page.waitForSelector('[data-browser-route="independent-browser"] [data-browser-route-connected]', { timeout: 30_000 });
      await shot('wizard-opened-connected');
      await phoneShot('wizard-opened-connected-390');

      // Codex route: candidate connection selector and save flow.
      await page.locator('[data-browser-route="codex-browser"]').scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-browser-route="codex-browser"] [data-browser-candidates-region]', { timeout: 10_000 });
      await page.waitForSelector('[data-browser-route="codex-browser"] [data-browser-route-instructions]', { timeout: 10_000 });
      const connectBtn = page.locator('[data-browser-route="codex-browser"] [data-browser-route-connect]');
      if (!await connectBtn.isDisabled()) throw new Error('codex connect button should be disabled before selection');

      // Explicit selection of candidate pipe 1
      await page.locator('#candidate-select-codex-browser').click();
      await page.waitForSelector('[role="option"][data-option-value="codex-browser-use-pipe-1"]', { timeout: 10_000 });
      await page.locator('[role="option"][data-option-value="codex-browser-use-pipe-1"]').click();

      // Save connection
      await connectBtn.click();
      await page.waitForSelector('[data-browser-route="codex-browser"][data-browser-route-state="ready"]', { timeout: 10_000 });
      const connectedBadge = await page.locator('[data-browser-route="codex-browser"] [data-browser-route-connected]').count();
      if (connectedBadge !== 0) throw new Error('codex saved connection should not claim connected or approved');
      await resetScroll(page);
      await shot('wizard-codex');
      await phoneShot('wizard-codex-390');

      // The Kimi route: everything installed except the store approval, which
      // is a link to a page only a person can click through.
      await page.locator('[data-browser-route="kimi-webbridge"] [data-browser-route-extension]').first().scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-browser-route-blocker="extension"]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('wizard-kimi-extension');
      await phoneShot('wizard-kimi-extension-390');

      // The connections and the default live below the routes, in the advanced
      // region — the things a person fills in, not picks.
      await page.locator('[data-browser-advanced-region] summary').click();
      await page.waitForSelector('[data-browser-connection="research"]', { timeout: 10_000 });
      await page.waitForSelector('[data-browser-state="ready"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('advanced-connections');

      // The default is its own control, and "choose each time" is a real value.
      await page.locator('#browser-default').click();
      await page.waitForSelector('[role="option"][data-option-value="research"]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('default-open');
      await page.keyboard.press('Escape');

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
      if (phoneWidth) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('[data-browser-tabs-section]').scrollIntoViewIfNeeded();
        await shot('runtime-catalog-390');
        await page.setViewportSize({ width: view.width, height: 900 });
      }

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

      // A new connection: the id and the style decide everything. The
      // hand-written routes the wizard does not cover are named here rather
      // than as a wall of inert conditions.
      await page.locator('[data-browser-add]').click();
      await page.waitForSelector('[data-browser-detail="new"]', { timeout: 10_000 });
      await page.fill('[data-browser-id-input]', 'staging');
      await page.fill('[data-browser-name-input]', '预发布检查');
      await page.locator('#browser-type').click();
      await page.locator('[role="option"][data-option-value="agent-browser-cdp"]').click();
      await page.waitForSelector('[data-secret-field]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('create-cdp');
      await page.locator('[data-browser-other]').scrollIntoViewIfNeeded();
      await shot('other-ecosystems');

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
      if (phoneWidth) {
        // The narrow twin of the state that has the two gated actions and the
        // one that is not.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('[data-browser-runtime]').scrollIntoViewIfNeeded();
        await shot('dirty-disconnect-390');
        await page.setViewportSize({ width: view.width, height: 900 });
      }
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
      await page.waitForSelector('[data-browser-route="independent-browser"]', { timeout: 30_000 });
      await page.locator('[data-browser-advanced-region] summary').click();
      await page.waitForSelector('[data-browser-connection="work"]', { timeout: 30_000 });
      await openConnection(page, 'work');
      await page.locator('[data-browser-connect]').click();
      await page.waitForSelector('[data-browser-open-flag]', { timeout: 30_000 });
      await page.locator('[data-browser-open-flag]').click();
      await requireFlagRowInViewport(page, view.width, "the connection card's flag trip");
      await shot('flag-home');

      // Affected UI in Chinese (zh) - wide and narrow views
      await page.evaluate(() => {
        try { localStorage.setItem('kiki.locale', 'zh'); } catch { /* ignore */ }
      });
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-browser-route="kimi-webbridge"]', { timeout: 30_000 });
      await page.waitForSelector('[data-browser-route="independent-browser"]', { timeout: 30_000 });
      await resetScroll(page);
      await shot('wizard-zh');
      await phoneShot('wizard-zh-390');

      // Chinese independent browser route: ready and advanced
      const advZh = page.locator('[data-browser-route="independent-browser"] [data-browser-route-advanced] summary');
      if (await advZh.isVisible().catch(() => false)) {
        await advZh.click();
        await page.waitForSelector('[data-browser-route="independent-browser"] [data-browser-route-update]', { timeout: 10_000 });
        await shot('wizard-advanced-options-zh');
        await page.locator('[data-browser-route="independent-browser"] [data-browser-route-update]').click();
        await page.waitForSelector('[data-browser-route="independent-browser"] [data-feedback-tone="info"]', { timeout: 10_000 });
        await shot('wizard-updated-disk-zh');
        await phoneShot('wizard-updated-disk-zh-390');
      }

      // Chinese Codex route
      await page.locator('[data-browser-route="codex-browser"]').scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-browser-route="codex-browser"] [data-browser-candidates-region]', { timeout: 10_000 });
      await resetScroll(page);
      await shot('wizard-codex-zh');
      await phoneShot('wizard-codex-zh-390');
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

      await page.locator('[data-browser-advanced-region] summary').click();
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
    name: 'webbridge-command',
    fixture: 'browser-control',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      const hint = view.locale === 'zh'
        ? '通过固定的本地 command 桥驱动 Kimi 扩展。不附着 CDP，也没有 endpoint。'
        : 'Drives the Kimi extension through the fixed local command bridge. It does not attach CDP and has no endpoint.';
      const checkHint = view.locale === 'zh'
        ? '检查本地 WebBridge 状态。不会打开页面，也不会再发一次页面命令。'
        : 'Checks the local WebBridge status. It does not open a page or repeat a page command.';
      const savedName = view.locale === 'zh' ? 'Kimi 命令桥' : 'Kimi command';
      await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-browser-route="kimi-webbridge"]', { timeout: 30_000 });
      await page.locator('[data-browser-advanced-region] summary').click();
      const row = page.locator('[data-browser-connection="webbridge-command"]');
      await row.waitFor({ state: 'visible', timeout: 30_000 });
      await row.scrollIntoViewIfNeeded();
      await shot('command-list');

      await openConnection(page, 'webbridge-command');
      const detail = page.locator('[data-browser-detail="webbridge-command"]');
      await page.getByText(hint, { exact: true }).first().waitFor({ timeout: 10_000 });
      await page.getByText(checkHint, { exact: true }).first().waitFor({ timeout: 10_000 });
      if (await page.locator('[data-secret-field]').count() !== 0) throw new Error('webbridge detail shows an endpoint field');
      if (await page.locator('[data-browser-driver-input]').count() !== 0) throw new Error('webbridge detail shows a driver path');
      if (await detail.locator('[data-browser-driver-line]').count() !== 0) throw new Error('webbridge detail shows a driver version');
      const check = detail.locator('[data-browser-check]');
      const connect = detail.locator('[data-browser-connect]');
      if (await check.isDisabled()) throw new Error('check is not reachable on a clean WebBridge draft');
      if (await connect.isDisabled()) throw new Error('connect is not reachable on a clean WebBridge draft');
      await detail.locator('[data-browser-detail-name]').scrollIntoViewIfNeeded();
      await shot('command-detail');
      await page.getByText(hint, { exact: true }).first().scrollIntoViewIfNeeded();
      await shot('command-hint');

      const checkResponse = page.waitForResponse((response) =>
        response.url().includes('/browser/connections/webbridge-command:check') && response.request().method() === 'POST');
      await check.click();
      const checked = await (await checkResponse).json();
      if (checked.code !== 0 || checked.data?.state !== 'idle') throw new Error(`check did not keep the fixture idle state: ${JSON.stringify(checked)}`);
      await page.waitForSelector('[data-browser-outcome="check:idle"]', { timeout: 10_000 });

      const connectResponse = page.waitForResponse((response) =>
        response.url().includes('/browser/connections/webbridge-command:connect') && response.request().method() === 'POST');
      await connect.click();
      const connected = await (await connectResponse).json();
      if (connected.code !== 0 || connected.data?.state !== 'ready') throw new Error(`connect did not adopt the fixture ready state: ${JSON.stringify(connected)}`);
      if (connected.data?.driverVersion !== undefined) throw new Error('connect echo carries a driver version');
      await page.waitForSelector('[data-browser-outcome="connect:ready"]', { timeout: 10_000 });
      await detail.locator('[data-browser-outcome="connect:ready"]').scrollIntoViewIfNeeded();
      await shot('command-connected');

      await page.fill('[data-browser-name-input]', savedName);
      await page.waitForSelector('[data-settings-draft]:not([hidden])', { timeout: 10_000 });
      const saveResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/browser/connections/webbridge-command') && response.request().method() === 'PUT';
      });
      await page.locator('[data-settings-draft] button').first().click();
      const saved = await (await saveResponse).json();
      const connection = saved.data?.connection;
      if (saved.code !== 0 || connection?.type !== 'webbridge-command' || connection?.name !== savedName) {
        throw new Error(`save did not echo the renamed WebBridge connection: ${JSON.stringify(saved)}`);
      }
      for (const key of ['endpoint', 'endpointDisplay', 'endpointConfigured', 'driverPath', 'profilePath', 'executablePath', 'cliPath']) {
        if (connection[key] !== undefined) throw new Error(`save echo carries ${key}`);
      }
      await page.waitForSelector('[data-saved-tick]', { timeout: 30_000 });
      await page.waitForFunction((name) => document.querySelector('[data-browser-detail-name]')?.textContent?.includes(name) === true, savedName);
      await detail.locator('[data-browser-detail-name]').scrollIntoViewIfNeeded();
      await shot('command-saved');

      if (view.width <= 600) {
        const back = page.locator('[data-browser-back]');
        if (!await back.isVisible()) throw new Error('narrow detail has no way back to the list');
        await back.click();
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        if (await page.locator('[data-browser-detail="webbridge-command"]').count() !== 0) throw new Error('narrow back left the detail open');
        await row.scrollIntoViewIfNeeded();
        await shot('command-back-list');
      } else {
        if (!await row.isVisible()) throw new Error('wide layout hid the connection list beside the detail');
        await row.scrollIntoViewIfNeeded();
        await shot('command-list-beside-detail');
      }
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
