/**
 * Visual proof for the 0.3.3 fixes: the paths that were broken and silent.
 *
 *   node scripts/visual-proof-ui033.mjs [--only=engine-visibility] [--matrix=width]
 *
 * Every check here is an assertion about something that used to fail with no
 * error at all, which is why a green test run was not evidence:
 *
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
    setUpLater: 'Set up later',
    closeSetup: 'Close setup',
  },
  zh: {
    setUpLater: '稍后配置',
    closeSetup: '关闭引导',
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
    name: 'onboarding-set-up-later',
    fixture: 'first-run',
    onboarding: false,
    async run({ page, view, shot }) {
      const text = TEXT[view.locale];
      const wizard = await openWizard(page);
      await wizard.locator('[data-onboarding-appearance]').waitFor({ timeout: 8000 });

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