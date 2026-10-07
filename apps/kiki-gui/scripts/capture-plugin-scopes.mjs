/**
 * Plugin scopes — the four-level answer, seen where a reader makes it.
 *
 * The chain this proves is the reader's, not the component's: the rail's
 * plugin list on a live conversation (which level decided each row, a local
 * `on` over an off global default, and the master switch denying one), the
 * ＋ menu's plugin list (a session override that changes no draft and sends
 * nothing), the installed list showing a global default apart from the master
 * switch, one workspace's own page, and the install sheet asking where the
 * plugin should land.
 *
 * Against the local fixture server, at 1440 and 390. Shots are named
 * `scope-<state>-<theme>-<width>`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'plugin-scopes-shots');

const SID = 'session_fixture_plugin_scopes';
const WSID = 'wd_plugin_scopes_0123456789ab';

const scenarios = [
  {
    name: 'plugin-scopes',
    fixture: 'plugin-scopes',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      await page.emulateMedia({ colorScheme: view.theme });
      const go = async (path, selector) => {
        await page.goto(link(path), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForSelector(selector, { timeout: 30_000 });
        await page.waitForTimeout(500);
      };

      // 1 · The rail on a live conversation. Folded by default; open it.
      await go(`/s/${SID}`, '[data-rail-plugins]');
      const head = page.locator('[data-rail-plugins] [aria-expanded]').first();
      if (await head.getAttribute('aria-expanded') === 'false') await head.click();
      await page.waitForSelector('[data-rail-plugin="kiki-notes"]', { timeout: 15_000 });
      await page.waitForTimeout(400);

      // Each row must name the level that decided it. A local `on` over an off
      // global default has to read as this conversation, not as global.
      const sourceOf = async (id) =>
        (await page.locator(`[data-rail-plugin="${id}"] [data-rail-plugin-source]`).textContent())?.trim();
      // Nothing overrode it, so the value is the home one: 'on everywhere'.
      if (await sourceOf('kiki-notes') !== 'on everywhere' && await sourceOf('kiki-notes') !== '全局开启') {
        throw new Error(`an unoverridden plugin must read as on everywhere, saw ${await sourceOf('kiki-notes')}`);
      }
      if (await sourceOf('research') !== 'this conversation' && await sourceOf('research') !== '当前对话') {
        throw new Error(`a session override must name this conversation, saw ${await sourceOf('research')}`);
      }
      // The master switch denies one: the row explains rather than lying.
      if (await page.locator('[data-rail-plugin="browser-bridge"] [data-rail-plugin-reason="home_disabled"]').count() === 0) {
        throw new Error('a master-disabled plugin must show its reason');
      }
      if (await page.locator('[data-rail-plugin="browser-bridge"] input[type=checkbox]:not([disabled])').count() !== 0) {
        throw new Error('a master-disabled plugin must not offer a working switch');
      }
      // Office is off because THIS WORKSPACE turned it off, and this
      // conversation only inherits it. The rail is the surface that gets this
      // right, so it is the reference the ＋ menu is checked against below.
      const officeRail = page.locator('[data-rail-plugin="office"]');
      if (await officeRail.getAttribute('data-effective') !== 'false') {
        throw new Error('office must start off for this conversation');
      }
      if (await sourceOf('office') !== 'this workspace' && await sourceOf('office') !== '本工作区') {
        throw new Error(`a workspace-disabled plugin must name the workspace, saw ${await sourceOf('office')}`);
      }
      // The delta's "before": the same row, fully on screen, so the after shot
      // can be compared with it rather than with a clipped edge.
      await officeRail.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await shot('scope-rail');

      // 2 · The ＋ menu's plugin list. A pick writes a session override and
      // produces no text and no message.
      const draftBefore = await page.locator('textarea[data-composer]').inputValue();
      await page.locator('[data-add-menu-trigger]').first().click();
      await page.waitForSelector('[data-add-menu-plugins]', { timeout: 15_000 });
      await page.locator('[data-add-menu-plugins]').click();
      await page.waitForSelector('[data-add-plugins-view]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      if (await page.locator('[data-add-plugin="research"]').count() === 0) {
        throw new Error('the ＋ menu must list this conversation’s plugins');
      }
      // Read the caption on its own line: the row also carries the switch's
      // screen-reader label, which names the conversation by construction.
      const captionOf = async (id) =>
        (await page.locator(`[data-add-plugin="${id}"]`).innerText()).split(String.fromCharCode(10))[1]?.trim() ?? '';
      // Before the pick, the ＋ menu must agree with the rail: office is off,
      // and the level that decided is the WORKSPACE. A menu with its own
      // narrower rule said "off for this conversation" here instead.
      const beforeCaption = await captionOf('office');
      if (!/^off for this workspace$/i.test(beforeCaption)) {
        throw new Error(`a workspace-disabled plugin must say so in the ＋ menu, saw: ${beforeCaption}`);
      }
      if (await page.locator('[data-add-plugin="office"] input[type=checkbox]').isChecked()) {
        throw new Error('office must start off in the ＋ menu, matching the rail');
      }
      await shot('scope-add-menu');

      // The checkbox is screen-reader only, so a pointer hits the label that
      // owns it — the same control a reader hits. Clicking the row wrapper
      // is not the interaction, which is exactly why this asserts the
      // resulting state instead of trusting the click to have worked.
      await page.locator('[data-add-plugin="office"] [role=switch]').click();
      await page.waitForTimeout(1500);
      const draftAfter = await page.locator('textarea[data-composer]').inputValue();
      if (draftAfter !== draftBefore) {
        throw new Error('enabling a plugin must not edit the draft');
      }
      // The panel stays open so the switch the reader flipped is still there.
      if (await page.locator('[data-add-plugins-view]').count() === 0) {
        throw new Error('a plugin pick must keep the panel open');
      }
      // The pick must really flip the plugin, not merely reword a caption.
      // Both surfaces read the same session, so both switches — the one in the
      // ＋ menu and the one in the rail — have to be checked for the same
      // plugin, and the server's own answer has to agree. Office starts off
      // (this workspace disabled it), so turning it on here is the flip.
      const menuChecked = await page.locator('[data-add-plugin="office"] input[type=checkbox]').isChecked();
      if (!menuChecked) throw new Error('the picked plugin must be checked in the ＋ menu');
      const menuCaption = await captionOf('office');
      if (!/^on for this conversation$/i.test(menuCaption)) {
        throw new Error(`an on plugin must read as on for this conversation, saw: ${menuCaption}`);
      }
      await shot('scope-add-toggled');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      // The other surface. The rail lives on the conversation, not in the
      // ＋ menu, so the same pick is checked there too — a second visit,
      // because agreeing between two surfaces is the point. The row is put on
      // screen before the shot, so the after image lines up with the before
      // one instead of showing a clipped edge.
      await go(`/s/${SID}`, '[data-rail-plugins]');
      const railHead = page.locator('[data-rail-plugins] [aria-expanded]').first();
      if (await railHead.getAttribute('aria-expanded') === 'false') await railHead.click();
      await page.waitForSelector('[data-rail-plugin="office"]', { timeout: 15_000 });
      const railOffice = page.locator('[data-rail-plugin="office"]');
      const railChecked = await railOffice.locator('input[type=checkbox]').isChecked();
      if (!railChecked) throw new Error('the rail must show the same plugin checked after the pick');
      if (await railOffice.getAttribute('data-effective') !== 'true') {
        throw new Error(`the rail must agree the picked plugin is on, saw ${await railOffice.getAttribute('data-effective')}`);
      }
      // The pick wrote the SESSION override, so the rail now names this
      // conversation — the level actually moved, not just the switch.
      if (await sourceOf('office') !== 'this conversation' && await sourceOf('office') !== '当前对话') {
        throw new Error(`the pick must move the row to this conversation, saw ${await sourceOf('office')}`);
      }
      await railOffice.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await shot('scope-add-toggled-rail');

      // 3 · The installed list: a global default is a fact apart from the
      // master switch, so a "decide later" plugin cannot read as on everywhere.
      await go('/settings/plugins', '#st-card-plugins [data-plugin-row]');
      const researchDefault = await page.locator('[data-plugin-row="research"] [data-plugin-global-default]').textContent();
      if (researchDefault?.trim() !== 'Off by default' && researchDefault?.trim() !== '默认关闭') {
        throw new Error(`a later-installed plugin must read as default off, saw ${researchDefault?.trim()}`);
      }
      // 'Decide later' leaves the master switch on but the global default
      // off. Turning the default on has to be one direct step from here,
      // not a two-step dance that first revokes the master switch.
      const enableEverywhere = page.locator('[data-plugin-enable-everywhere="research"]');
      if (await enableEverywhere.count() !== 1) {
        throw new Error('a later-installed plugin must offer a direct way to enable the global default');
      }
      if (await page.locator('[data-plugin-row="research"] input[type=checkbox]').isChecked() !== true) {
        throw new Error('the master switch must stay on; the default is a separate fact');
      }
      await enableEverywhere.click({ timeout: 5000 });
      // The default really flipped, and the action is gone because the state
      // it acted on is gone — not because the click missed.
      await page.waitForFunction(
        () => document.querySelector('[data-plugin-row="research"] [data-plugin-global-default]')?.getAttribute('data-plugin-global-default') === 'on',
        undefined, { timeout: 15_000 },
      );
      if (await page.locator('[data-plugin-row="research"] input[type=checkbox]').isChecked() !== true) {
        throw new Error('setting the global default must not disturb the master switch');
      }
      await page.waitForSelector('[data-plugin-enable-everywhere="research"]', { state: 'detached', timeout: 15_000 });
      await shot('scope-installed');

      // 4 · One workspace's own page: identity, plugins with their level,
      // trust, memory, and the resources that belong to it.
      await go(`/settings/workspaces?workspace=${WSID}`, `[data-workspace-detail="${WSID}"]`);
      if (await page.locator('[data-workspace-plugin="research"] [data-workspace-plugin-source]').count() === 0) {
        throw new Error('a workspace plugin row must name the level that decided it');
      }
      if (await page.locator('[data-workspace-plugins-link], [data-workspace-profiles-link]').count() === 0) {
        throw new Error('the workspace page must link the resources scoped to it');
      }
      // The breadcrumb names the object the page is, the way an open
      // plugin's page names its plugin.
      const crumb = await page.locator('[data-settings-page-title]').innerText().catch(() => '');
      if (!crumb.includes('Scopes workspace')) {
        throw new Error(`the workspace breadcrumb must name the workspace, saw: ${crumb}`);
      }
      await shot('scope-workspace');

      // Its own list row opens it, and the address says which workspace.

      await go('/settings/workspaces', '[data-workspace-open]');
      await page.locator('[data-workspace-open]').first().click();
      await page.waitForSelector('[data-workspace-detail]', { timeout: 15_000 });
      if (!page.url().includes('/settings/workspaces?workspace=')) {
        throw new Error(`a workspace row must open its own page, landed on ${page.url()}`);
      }
      await shot('scope-workspace-open');

      // 4b · The MCP leaf the page links to. The link names the workspace, so
      // the leaf has to read THAT workspace's root — the milestone is the
      // request, but a picture is what shows the page did not silently fall
      // back to the home configuration.
      await go(`/settings/mcp?workspace=${WSID}`, '[data-mcp-workspace-root]');
      if (!(await page.locator('[data-mcp-workspace-root]').innerText()).includes('C:/fixture/scopes')) {
        throw new Error('the MCP leaf must read the workspace the link named');
      }
      if ((await page.locator('[data-mcp-workspace-missing]').count()) !== 0) {
        throw new Error('the MCP leaf must not report a workspace it was given as missing');
      }
      // Read-only is the entry's own fact: the plugin's row says so and offers
      // no edit, while the entry this server owns does.
      if ((await page.locator('[data-mcp-server="from-plugin"] button[aria-label^="Edit"]').count()) !== 0) {
        throw new Error('a plugin’s MCP entry must not offer an edit');
      }
      if ((await page.locator('[data-mcp-server="files"] button[aria-label^="Edit"]').count()) !== 1) {
        throw new Error('an entry this server owns must offer its edit');
      }
      await page.waitForTimeout(600);
      await shot('scope-mcp-workspace');

      // 5 · The install sheet asks where the plugin should land. A workspace
      await go('/capabilities', '[data-capabilities-add]');
      await page.locator('[data-capabilities-add]').click();
      await page.locator('[data-capabilities-add-item="plugin"]').click();
      await page.waitForSelector('input[data-autofocus]', { timeout: 15_000 });
      await page.locator('input[data-autofocus]').fill('https://example.test/summarizer.git');
      await page.locator('[data-install-preview], button:has-text("Review plugin")').first().click();
      await page.waitForSelector('[data-install-scope]', { timeout: 15_000 });
      await page.waitForTimeout(400);

      // The choice is the point of the sheet: everywhere, decide later, and —
      // because this sheet was opened from the market with no workspace — only
      // the first two. An update never shows it at all.
      const options = await page.locator('[data-install-scope-option]').evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute('data-install-scope-option')));
      if (options.join(',') !== 'global,later') {
        throw new Error(`a market install must offer everywhere and decide-later, saw ${options.join(',')}`);
      }
      // Deferring really installs with the global default off, and says so.
      await page.locator('[data-install-scope-option="later"] input').click();
      await page.locator('[data-install-confirm]').click();
      await page.waitForSelector('[data-install-done="later"]', { timeout: 15_000 });
      await page.waitForTimeout(300);
      await shot('scope-install-later');
    },
  },
];

const result = await runProof({
  scenarios,
  root: ROOT,
  argv: process.argv.slice(2),
  label: 'plugin-scopes',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;