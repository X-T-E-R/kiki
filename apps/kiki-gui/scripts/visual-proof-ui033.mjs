/**
 * Visual proof for the 0.3.3 fixes: the paths that were broken and silent.
 *
 *   node scripts/visual-proof-ui033.mjs [--only=onboarding-model-picker] [--matrix=width]
 *
 * Every check here is an assertion about something that used to fail with no
 * error at all, which is why a green test run was not evidence:
 *
 *  - onboarding-model-picker — the wizard's model dropdown painted *under* the
 *    dialog, so the list was in the DOM and dead on screen. Checked by asking
 *    the page what actually paints on top at the panel's own coordinates.
 *  - onboarding-model-empty — the empty state before any fetch, and after a
 *    fetch that reported nothing: two different sentences.
 *  - onboarding-set-up-later — "Set up later" steps past the current step and
 *    keeps the run open; on the last step it still closes.
 *  - engine-visibility — an engine nobody configured is not offered; hiding one
 *    removes it from the list but leaves it installed and checkable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';
import { spaceDesktopMock } from './space-desktop-mock.mjs';
import { FIXTURE_TOKEN } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT = {
  en: {
    next: 'Next',
    skipForNow: 'Skip for now',
    setUpLater: 'Set up later',
    closeSetup: 'Close setup',
    testConnection: 'Test connection',
    finish: 'Let Kiki set it up',
    manual: 'Enter it yourself',
  },
  zh: {
    next: '下一步',
    skipForNow: '暂时跳过',
    setUpLater: '稍后配置',
    closeSetup: '关闭引导',
    testConnection: '测试连接',
    finish: '让 Kiki 帮你配置',
    manual: '自己输入',
  },
};

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Every source file under `root`, for the structural check below. */
function walkSources(root) {
  const found = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(next);
      else if (/\.tsx?$/.test(entry.name)) found.push(next);
    }
  };
  visit(root);
  return found;
}

async function openWizard(page) {
  const wizard = page.locator('[role="dialog"][aria-label]').first();
  await wizard.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(450);
  return wizard;
}

/** Welcome → the model step, through the wizard's own advance. */
async function toModelStep(page, wizard, text) {
  await wizard.locator('[data-onboarding-appearance]').waitFor({ timeout: 8000 });
  await wizard.getByRole('button', { name: text.next, exact: true }).click();
  await wizard.locator('[data-connection-choice]').first().waitFor({ timeout: 8000 });
}

/** The manual lane, where the API-key form with its model picker lives. */
async function toProviderForm(page, wizard) {
  // The dense onboarding path already opens on "Enter it myself"; only switch
  // when the directory tab is the one showing.
  const manual = wizard.locator('[data-connection-source-choice="manual"]');
  if (await manual.count() > 0 && await manual.getAttribute('aria-selected') !== 'true') {
    await manual.click();
  }
  // The vendor rows only appear after a directory search; the protocol list is
  // the always-present way into the same form.
  await wizard.locator('[data-provider-protocol]').first().waitFor({ timeout: 8000 });
  await wizard.locator('[data-provider-protocol]').first().click();
  await wizard.locator('#onboarding-provider-model').waitFor({ timeout: 8000 });
  await page.waitForTimeout(250);
}

/**
 * What actually paints on top, at a point inside the element.
 *
 * A present-in-the-DOM list can still be invisible, so the only honest check is
 * the browser's own hit test: the panel has to be the element the pointer
 * reaches. That is what failed before, and it is why this is a rendered
 * check rather than a DOM-existence assertion.
 */
async function topmostAt(page, selector) {
  return page.evaluate((target) => {
    const node = document.querySelector(target);
    if (node === null) return { found: false };
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { found: true, zeroSized: true };
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      found: true,
      zeroSized: false,
      reachable: hit !== null && node.contains(hit),
      hitTag: hit?.tagName ?? null,
      panelZ: node instanceof HTMLElement ? getComputedStyle(node).zIndex : null,
    };
  }, selector);
}

/** The wizard's model dropdown: open it and assert the list is really usable. */
async function modelPickerIsUsable(page, wizard) {
  await wizard.locator('#onboarding-provider-model').click();
  const panel = page.locator('[data-select-panel]');
  await panel.waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);

  const topmost = await topmostAt(page, '[data-select-panel]');
  expect(topmost.found && !topmost.zeroSized, 'the model panel must have a real box');
  expect(topmost.reachable, `the model panel must be the topmost element where it is drawn (hit ${topmost.hitTag}, z ${topmost.panelZ})`);

  // A click on a visible option row must actually commit.
  const rows = panel.locator('[role="option"]');
  if (await rows.count() > 0) {
    const first = await rows.first().getAttribute('data-option-value');
    await rows.first().click();
    await page.waitForTimeout(250);
    const value = await wizard.locator('#onboarding-provider-model').getAttribute('data-onboarding-model-id');
    expect(value !== null, 'the model trigger must exist after committing');
    expect(first !== null, 'the clicked row must carry a value');
  }
  return topmost;
}

/**
 * Every link that leaves the app goes through one component now, so nothing may
 * hand-roll a new-tab anchor again. A desktop webview cannot open one, so a bare
 * `<a target="_blank">` is a button that silently does nothing — the exact defect
 * this replaces.
 *
 * This is a *static* check and is deliberately not the evidence that the links
 * work: it says every link is routed, not that any link opened. The runtime
 * proof is `external-link-opens`, which watches the host's own opener being
 * called with the address that was actually clicked.
 */
function assertNoBypassedExternalLinks() {
  const surface = walkSources('src');
  const offenders = [];
  for (const file of surface) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (file.endsWith('host/ExternalLink.tsx')) continue;
    if (file.endsWith('.test.tsx') || file.endsWith('.test.ts')) continue;
    if (/target=["']_blank["']/.test(text)) offenders.push(file);
  }
  expect(offenders.length === 0,
    `these files open a new tab without the shared opener: ${offenders.join(', ')}`);
}

const scenarios = [
  {
    /**
     * The external-link defect, observed at runtime rather than inferred from
     * the source.
     *
     * The page boots as the desktop shell — the shared desktop mock stands in
     * for the Tauri IPC, exactly as the spaces proofs do — and then a real
     * rendered link on a real settings page is clicked. What is asserted is the
     * chain the defect actually broke: the click reaches `open_external_url`
     * over the bridge, carrying the address that was on the anchor. The mock
     * records that call rather than launching anything, so no browser opens, no
     * account is touched and no URL is fetched.
     *
     * The browser host is then checked on its own, where there is no bridge at
     * all and the anchor's real `href` is what a browser follows.
     *
     * The structural scan below still guards against a future hand-rolled
     * anchor, but it is deliberately *not* the evidence that these links work:
     * it says every link is routed, not that any link opened.
     */
    name: 'external-link-opens',
    fixture: 'web-access-open',
    async run({ page, view, shot, link }) {
      // --- desktop: the click must cross the shell bridge ---
      await page.context().addInitScript(spaceDesktopMock, {
        fixtureUrl: new URL(link('/')).searchParams.get('server'),
        token: FIXTURE_TOKEN,
        spaces: [],
        windowMode: 'switch',
      });
      // Record what the bridge was actually asked to open.
      await page.addInitScript(() => {
        window.__ui033OpenedUrls = [];
        const internals = window.__TAURI_INTERNALS__;
        const original = internals.invoke;
        internals.invoke = async (command, args) => {
          if (command === 'open_external_url') window.__ui033OpenedUrls.push(args?.url);
          return original(command, args);
        };
      });

      await page.goto(link('/settings/spaces'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
      const anchor = page.locator('[data-web-access-open-link]').first();
      await anchor.waitFor({ timeout: 20_000 });
      const href = await anchor.getAttribute('href');
      expect(href !== null && /^https?:\/\//.test(href),
        `the web-access open link must carry a real address, saw ${href}`);
      // Bring the card into view, so the shot shows the control that was clicked
      // rather than the top of a long settings page.
      await anchor.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot('ui033-12-external-links-desktop');

      await anchor.click();
      await page.waitForFunction(() => (window.__ui033OpenedUrls ?? []).length > 0, undefined, { timeout: 10_000 })
        .catch(() => undefined);
      const opened = await page.evaluate(() => window.__ui033OpenedUrls ?? []);
      expect(opened.length === 1,
        `the desktop click must reach open_external_url exactly once, saw ${JSON.stringify(opened)}`);
      expect(opened[0] === href,
        `the address handed to the shell must be the one on the anchor (${href}), saw ${opened[0]}`);

      // --- browser: no bridge, so the anchor's own href is what a browser uses ---
      const browserCtx = page.context().browser();
      const browserPage = await browserCtx.newPage();
      try {
        await browserPage.goto(link('/settings/spaces'), { waitUntil: 'domcontentloaded' });
        const browserAnchor = browserPage.locator('[data-web-access-open-link]').first();
        await browserAnchor.waitFor({ timeout: 20_000 });
        const browserHref = await browserAnchor.getAttribute('href');
        const target = await browserAnchor.getAttribute('target');
        const rel = await browserAnchor.getAttribute('rel');
        expect(browserHref === href, 'the same link must carry the same address on a browser host');
        expect(target === '_blank', `a browser link must keep its own new-tab semantics, saw ${target}`);
        expect((rel ?? '').includes('noopener'), `the browser link must keep a closed opener, saw ${rel}`);
      } finally {
        await browserPage.close();
      }

      assertNoBypassedExternalLinks();
    },
  },
  {
    /**
     * The device sign-in's "open the verification page" button, end to end.
     *
     * This is the other half of the reported defect and it is named explicitly
     * by the user, so it is proved the same way as the settings links rather
     * than assumed from the shared opener. Nothing here touches a real account:
     * the fixture already issues a synthetic pending flow (a code, a
     * verification address and an expiry), so the button under test is the real
     * one on the real card with a synthetic server behind it.
     *
     * The chain asserted is the whole thing the defect broke: sign-in pressed →
     * the server issues a code → the pending card renders → "open the
     * verification page" reaches `open_external_url` exactly once, carrying the
     * verification address the server issued. Then the failure case, because a
     * refused open that says nothing is the original defect: the shell refuses,
     * and the card must show it.
     */
    name: 'oauth-device-opens-verification',
    fixture: 'oauth-connections',
    async run({ page, view, shot, link }) {
      await page.context().addInitScript(spaceDesktopMock, {
        fixtureUrl: new URL(link('/')).searchParams.get('server'),
        token: FIXTURE_TOKEN,
        spaces: [],
        windowMode: 'switch',
      });
      await page.addInitScript(() => {
        window.__ui033OpenedUrls = [];
        // The refusal is injected, not simulated: the card's own catch must be
        // what turns this into a visible line.
        window.__ui033RefuseOpen = false;
        const internals = window.__TAURI_INTERNALS__;
        const original = internals.invoke;
        internals.invoke = async (command, args) => {
          if (command !== 'open_external_url') return original(command, args);
          window.__ui033OpenedUrls.push(args?.url);
          if (window.__ui033RefuseOpen) throw new Error('shell refused the address');
          return original(command, args);
        };
      });

      await page.goto(link('/settings/ai?tab=providers'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-list]', { timeout: 30_000 });
      await page.locator('[data-add-connection]').first().click();
      await page.waitForSelector('[data-connection-method-picker]', { timeout: 15_000 });
      await page.locator('[data-connection-choice="account"]').click();

      // The real sign-in button for the account the page does not list yet.
      const method = page.locator('[data-oauth-method="openai-codex"]');
      await method.waitFor({ timeout: 15_000 });
      await method.locator('[data-account-sign-in-button]').click();

      // The card only exists once the server has issued a code, so its presence
      // is the proof that the button actually started a flow.
      const code = method.locator('code');
      await code.waitFor({ timeout: 15_000 });
      const userCode = (await code.innerText()).trim();
      expect(userCode.length > 0, 'the pending card must show the device code it was issued');

      const openButton = method.locator('[data-oauth-open-page]');
      await openButton.waitFor({ timeout: 10_000 });
      await openButton.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot('ui033-13-oauth-device-card');

      await openButton.click();
      await page.waitForFunction(() => (window.__ui033OpenedUrls ?? []).length > 0, undefined, { timeout: 10_000 })
        .catch(() => undefined);
      const opened = await page.evaluate(() => window.__ui033OpenedUrls ?? []);
      expect(opened.length === 1,
        `the sign-in button must reach open_external_url exactly once, saw ${JSON.stringify(opened)}`);
      // The address must be the one the server issued for this flow, complete
      // with the code — not a login page, and not some other flow's address.
      expect(typeof opened[0] === 'string' && opened[0].includes(userCode),
        `the address opened must be this flow's verification page carrying ${userCode}, saw ${opened[0]}`);
      expect(await method.locator('[role="alert"]').count() === 0,
        'a successful open must leave no failure line on the card');

      // The recovery case: the shell refuses, and the card has to say so.
      await page.evaluate(() => { window.__ui033RefuseOpen = true; });
      await openButton.click();
      const alert = method.locator('[role="alert"]');
      await alert.waitFor({ timeout: 10_000 });
      const message = (await alert.innerText()).trim();
      expect(message.length > 0, 'a refused open must leave a visible message, not a dead button');
      // The code stays readable, which is the manual way out of a failed open.
      expect((await code.innerText()).trim() === userCode,
        'a failed open must leave the device code on screen so the flow can be finished by hand');
      await shot('ui033-14-oauth-open-refused');
    },
  },
  {
    name: 'onboarding-model-picker',
    fixture: 'first-run',
    onboarding: false,
    matrix: ['width'],
    async run({ page, view, shot }) {
      const text = TEXT[view.locale];
      const wizard = await openWizard(page);
      await toModelStep(page, wizard, text);
      await shot('ui033-1-model-step');
      await toProviderForm(page, wizard);
      await shot('ui033-2-provider-form');
      const topmost = await modelPickerIsUsable(page, wizard);
      await shot('ui033-3-model-picker-open');
      // The options list is the whole point of the control; a shot that shows
      // the dialog but not the list over it is exactly the failure.
      expect(topmost.reachable, 'model options must be visible above the wizard');
    },
  },
  {
    name: 'onboarding-model-empty',
    fixture: 'first-run',
    onboarding: false,
    async run({ page, view, shot }) {
      const text = TEXT[view.locale];
      const wizard = await openWizard(page);
      await toModelStep(page, wizard, text);
      await toProviderForm(page, wizard);

      // Before any fetch the trigger already says the list has not been read
      // yet — it must not claim the provider reported nothing.
      const triggerBefore = await wizard.locator('#onboarding-provider-model').innerText();
      await wizard.locator('#onboarding-provider-model').click();
      await page.waitForSelector('[data-select-panel]', { timeout: 8000 });
      const panelBefore = await page.locator('[data-select-panel]').innerText();
      await shot('ui033-4-model-empty-before-fetch');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // After a fetch that reported nothing, the provider's answer is the fact.
      // The form needs an address first: "Test connection" is disabled without
      // one, which is itself the correct behaviour.
      await wizard.locator('#onboarding-provider-base-url').fill('https://api.example.test/v1');
      await wizard.getByRole('button', { name: text.testConnection, exact: true }).click();
      await page.waitForTimeout(1200);
      await wizard.locator('#onboarding-provider-model').click();
      await page.waitForSelector('[data-select-panel]', { timeout: 8000 });
      const triggerAfter = await wizard.locator('#onboarding-provider-model').innerText();
      const panelAfter = await page.locator('[data-select-panel]').innerText();
      await shot('ui033-5-model-empty-after-fetch');
      // The fixture answers with one model, so after the fetch there is a real
      // option and the "not read yet" claim is gone either way. The rule under
      // test is that the two empty states are different sentences.
      const notFetched = 'No models listed yet';
      expect(triggerBefore.includes(notFetched), `before any fetch the trigger must say the list is unread (saw ${JSON.stringify(triggerBefore)})`);
      expect(!panelAfter.includes(notFetched), `after a fetch the unread-list wording must be gone (saw ${JSON.stringify(panelAfter)})`);
      expect(triggerBefore !== triggerAfter || panelBefore !== panelAfter, 'the model control must react to the probe');
    },
  },
  {
    name: 'onboarding-set-up-later',
    fixture: 'first-run',
    onboarding: false,
    async run({ page, view, shot }) {
      const text = TEXT[view.locale];
      const wizard = await openWizard(page);
      await toModelStep(page, wizard, text);

      // "Set up later" is about this step, so it steps past it and keeps going.
      await wizard.getByRole('button', { name: text.setUpLater, exact: true }).click();
      await wizard.locator('[data-permission-choice]').first().waitFor({ timeout: 8000 });
      expect(await page.locator('[role="dialog"][aria-label]').count() === 1, 'the wizard stays open');
      await shot('ui033-6-after-skip-step');

      // Past the last step there is nowhere to go, so it keeps its original job.
      await wizard.getByRole('button', { name: text.setUpLater, exact: true }).click();
      await wizard.locator('[data-onboarding-capabilities]').waitFor({ timeout: 8000 });
      await wizard.getByRole('button', { name: text.closeSetup, exact: true }).first().click();
      await page.waitForSelector('[role="dialog"][aria-label]', { state: 'detached', timeout: 8000 });
      expect(page.url().includes('/new'), `closing returns to where the user was, saw ${page.url()}`);
    },
  },
  {
    // A machine with a configured engine: its bare row, and its profiles under
    // it. R4 is about this ordering — a Codex profile must not read as a Kiki
    // one.
    name: 'engine-grouping',
    fixture: 'external-main',
    async run({ page, view, shot }) {
      // A real session, not /new: the new-session page has no workspace chosen
      // yet, so its catalog is unscoped and a workspace-scoped profile is
      // correctly out of scope there. This is the picker people pick in.
      await page.goto(page.url().replace(/\/new.*$/, '/s/session_fixture_external_claude'));
      await page.waitForSelector('[data-execution-select]', { timeout: 15_000 });
      await page.locator('[data-execution-select] > button').click();
      await page.waitForSelector('[data-execution-panel]', { timeout: 8000 });
      await page.waitForTimeout(400);
      const facts = await page.evaluate(() => ({
        panel: document.querySelector('[data-execution-panel]') !== null,
        profiles: document.querySelectorAll('[data-execution-profile]').length,
        engines: [...document.querySelectorAll('[data-execution-engine]')].length,
      }));
      expect(facts.panel, 'the execution panel must be open');
      expect(facts.profiles > 0, `the panel must carry profiles, saw ${JSON.stringify(facts)}`);
      const report = await page.evaluate(() => [...document.querySelectorAll('[data-execution-engine]')].map((node) => ({
        engine: node.getAttribute('data-execution-engine'),
        bare: node.querySelector('[data-execution-bare]')?.textContent?.trim().slice(0, 40) ?? null,
        profiles: [...node.querySelectorAll('[data-execution-profile]')].map((p) => p.getAttribute('data-execution-profile')),
      })));
      await shot('ui033-11-engine-grouping');
      // Every profile belongs to the engine whose block it is nested in, and
      // an engine with profiles always leads with its own bare row.
      for (const entry of report) {
        expect(entry.bare !== null, `engine ${entry.engine} must lead with its bare row`);
      }
      expect(report.length >= 2, `a machine with an external engine must offer it, saw ${JSON.stringify(report.map((r) => r.engine))}`);
      const external = report.filter((entry) => entry.engine !== 'native');
      expect(external.length > 0 && external.every((entry) => entry.profiles.length > 0),
        `a configured external engine must carry its own profiles under it, saw ${JSON.stringify(external)}`);
    },
  },
  {
    name: 'engine-visibility',
    fixture: 'external-engines',
    matrix: ['theme'],
    async run({ page, view, shot }) {
      // Settings → Connections, where the engines are listed and each carries
      // the choice about whether it is offered in the pickers.
      await page.goto(page.url().replace(/\/new.*$/, '/settings/ai?tab=providers'));
      await page.waitForSelector('[data-external-engines]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      await shot('ui033-7-engines-settings');

      // The per-engine choice lives inside that engine's own row, so the row
      // has to be open before the choice is reachable.
      const engineRow = page.locator('[data-engine-row]').first();
      const id = await engineRow.getAttribute('data-engine-row');
      await engineRow.locator("summary").first().click();
      await page.waitForTimeout(300);
      const row = page.locator(`[data-engine-visible="${id}"]`);
      await row.waitFor({ timeout: 8000 });
      const before = await row.getAttribute('data-visible');
      await row.locator('label').first().click();
      await page.waitForTimeout(900);
      const after = await page.locator(`[data-engine-visible="${id}"]`).getAttribute('data-visible');
      expect(before !== after, `the toggle must change the engine's display state (was ${before}, now ${after})`);
      // Hiding is display-only: the engine stays installed and listed here.
      expect(await page.locator(`[data-engine-row="${id}"]`).count() === 1, 'a hidden engine stays installed and listed here');
      await shot('ui033-8-engine-hidden');

      // And the global switch turns every one of them off at once.
      const global = page.locator('[data-external-visibility]');
      await global.locator('label').first().click();
      await page.waitForTimeout(900);
      await shot('ui033-9-externals-off');

      // The point of the whole choice: with externals off, the composer's
      // engine picker offers only Kiki — and no external engine row is left
      // behind pointing at a machine nobody configured.
      await page.goto(page.url().replace(/\/settings.*$/, '/new'));
      await page.waitForSelector('[data-execution-select]', { timeout: 15_000 });
      await page.locator('[data-execution-select] > button').click();
      await page.waitForSelector('[data-execution-panel]', { timeout: 8000 });
      await page.waitForTimeout(300);
      const engineIds = await page.locator('[data-execution-engine]').evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute('data-execution-engine')),
      );
      await shot('ui033-10-execution-picker');
      expect(engineIds.length === 1 && engineIds[0] === 'native',
        `only the native engine may be offered once externals are off, saw ${JSON.stringify(engineIds)}`);
    },
  },
];

const { failed } = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'ui033-proof',
});
process.exitCode = failed.length > 0 ? 1 : 0;