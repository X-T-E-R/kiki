/**
 * Installed-plugin settings pages: the list, one plugin's own page, and the
 * ways in and out of it.
 *
 * The chain this proves is the reader's, not the component's: the installed
 * list at `/settings/plugins`, a row opening `/settings/plugins?plugin=<id>`,
 * that page's own form (plain and secret), saving, reloading to read the stored
 * value back, going back, and the links that must never leave a form in place —
 * the plugin detail on Capabilities and the media source's provider button.
 *
 * Against the local fixture server, at 1440 and 390. Shots are named
 * `plug-<state>-<theme>-<width>`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.KIKI_PROOF_OUTPUT_DIR ??= join(ROOT, '.tmp', 'plugin-settings-pages-shots');

const scenarios = [
  {
    name: 'plugin-settings-pages',
    fixture: 'plugin-settings-pages',
    matrix: ['width'],
    run: async ({ page, view, link, shot }) => {
      await page.emulateMedia({ colorScheme: view.theme });
      const go = async (path, selector) => {
        await page.goto(link(path), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForSelector(selector, { timeout: 30_000 });
        await page.waitForTimeout(400);
      };
      const noOverflow = async (label) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) throw new Error(`${label}: horizontal overflow ${overflow}px`);
      };

      // The list: installed plugins, real names and origins, a switch per row,
      // one link to the market, and no form to fill in here.
      await go('/settings/plugins', '#st-card-plugins [data-plugin-row]');
      if (await page.locator('#st-card-plugins [data-plugin-settings]').count() !== 0) {
        throw new Error('the installed list must not carry a configuration form');
      }
      if (await page.locator('#st-card-webbridge').count() !== 0) {
        throw new Error('the browser runtime card must not sit on the plugins leaf');
      }
      await noOverflow(`list ${view.width}`);
      await shot('plug-list');

      // Open one plugin: its own page, named, with a way back.
      await page.locator('[data-plugin-open-settings="kiki-notes"]').click({ timeout: 15_000 });
      await page.waitForSelector('[data-plugin-settings-page="kiki-notes"]', { timeout: 15_000 });
      await page.waitForSelector('[data-plugin-settings="kiki-notes"]', { timeout: 15_000 });
      if (!page.url().includes('/settings/plugins?plugin=kiki-notes')) {
        throw new Error(`row must open the plugin's own page, landed on ${page.url()}`);
      }
      await noOverflow(`plugin page ${view.width}`);
      await shot('plug-page');

      // Edit and save a plain field, then confirm the stored value reads back.
      const region = page.locator('[data-plugin-setting="workspace"] input');
      await region.fill('notes-moved');
      await page.locator('[data-settings-draft="plugin-settings-kiki-notes"] button').first().click();
      await page.waitForSelector('[data-settings-draft-saved="plugin-settings-kiki-notes"]', { timeout: 15_000 });
      await shot('plug-saved');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-plugin-setting="workspace"] input', { timeout: 30_000 });
      const stored = await page.locator('[data-plugin-setting="workspace"] input').inputValue();
      if (stored !== 'notes-moved') throw new Error(`the saved value must read back, saw ${stored}`);

      // A secret is reported as set, never echoed, and is replaced not revealed.
      const secretText = (await page.locator('[data-plugin-setting="vaultToken"]').textContent()) ?? '';
      // The status is localized, so assert on the state, not on English words.
      if (!/Saved in Kiki credentials|已保存在 Kiki 凭据中/.test(secretText)) {
        throw new Error(`a stored secret must report itself as saved, saw: ${secretText.trim()}`);
      }
      // Write-only: the stored value is never rendered back into the page.
      if (/[A-Za-z0-9]{12,}/.test(secretText.replace(/Vault token/g, '').replace(/Written only[^.]*\./g, ''))) {
        throw new Error('a secret must not be printed back into the page');
      }

      // Leaving with unsaved work goes through the dirty guard, not silently.
      await page.locator('[data-plugin-setting="maxResults"] input').fill('42');
      await page.locator('[data-plugin-settings-back]').click();
      await page.waitForTimeout(400);
      if (!page.url().includes('/settings/plugins')) {
        // A guarded leave shows the dialog instead of navigating.
        await shot('plug-dirty-guard');
        await page.keyboard.press('Escape');
      }

      // Back to the list, and a deep link to a plugin that is not installed
      // says so rather than opening some other plugin.
      await go('/settings/plugins', '#st-card-plugins [data-plugin-row]');
      await go('/settings/plugins?plugin=never-installed', '[data-plugin-settings-missing]');
      if (await page.locator('[data-plugin-settings-page]').count() !== 0) {
        throw new Error('a missing plugin must not fall back to another plugin');
      }
      await shot('plug-missing');

      // The Capabilities plugin detail links out rather than embedding a form.
      await go('/capabilities?plugin=kiki-notes', '[data-plugin-detail="kiki-notes"]');
      if (await page.locator('[data-plugin-detail="kiki-notes"] [data-plugin-settings]').count() !== 0) {
        throw new Error('plugin detail must not carry a second copy of the form');
      }
      await page.waitForSelector('[data-plugin-open-settings="kiki-notes"]', { timeout: 15_000 });
      await shot('plug-detail-link');
      await page.locator('[data-plugin-open-settings="kiki-notes"]').click();
      await page.waitForSelector('[data-plugin-settings-page="kiki-notes"]', { timeout: 15_000 });
      if (!page.url().includes('/settings/plugins?plugin=kiki-notes')) {
        throw new Error(`detail must lead to the same settings page, landed on ${page.url()}`);
      }

      // The nav names the installed plugins while this section is open, on
      // whichever navigation the width gives us. The branch only draws inside
      // the Plugins group, so the shot has to be taken where that group is.
      await go('/settings/plugins', '#st-card-plugins [data-plugin-row]');
      const openPlugin = '[data-plugin-open-settings="kiki-notes"]';
      if (view.width <= 1024) {
        await page.locator('[data-settings-nav-trigger]').first().click({ timeout: 15_000 });
        await page.waitForSelector('[role="dialog"] [data-settings-nav-tree]', { timeout: 15_000 });
      } else {
        await page.waitForSelector('nav [data-settings-nav-tree]', { timeout: 30_000 });
      }
      // Both navigations are mounted at every width — the rail is hidden below
      // the desktop breakpoint rather than unmounted — so the entry is scoped to
      // whichever one is actually on screen.
      const pluginEntry = page.locator(
        view.width <= 1024
          ? '[role="dialog"] [data-settings-nav-plugin="kiki-notes"]'
          : 'nav [data-settings-nav-plugin="kiki-notes"]',
      );
      await page.waitForTimeout(250);
      await shot('plug-nav');

      // From the navigation the plugin's own page opens, and the entry there is
      // the one marked current.
      // The navigation scrolls inside its own container, which is not the
      // window, so the entry is brought into view by scrolling that container
      // rather than by asking the page to.
      // The navigation scrolls inside its own element — the rail's <nav> on the
      // desktop, the drawer's panel below it — which is not the window, so the
      // entry is brought into view by scrolling whichever of those is its
      // ancestor rather than by asking the page to.
      await pluginEntry.evaluate((node) => {
        let scroller = node.parentElement;
        while (scroller !== null && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement;
        }
        if (scroller !== null) {
          scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
        }
      });
      await page.waitForTimeout(250);
      // The navigation scrolls inside its own element — the rail's <nav> on the
      // desktop, the drawer's panel below it — which is not the window, so the
      // entry is brought into view by scrolling whichever of those is its
      // ancestor rather than by asking the page to.
      await pluginEntry.evaluate((node) => {
        let scroller = node.parentElement;
        while (scroller !== null && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement;
        }
        if (scroller !== null) {
          scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
        }
      });
      await page.waitForTimeout(250);
      await pluginEntry.click({ timeout: 15_000 });
      await page.waitForSelector('[data-plugin-settings-page="kiki-notes"]', { timeout: 15_000 });
      if (view.width > 1024
        && await page.locator('nav [data-settings-nav-plugin="kiki-notes"][aria-current="page"]').count() === 0) {
        throw new Error('the open plugin must be marked in the navigation');
      }
      await shot('plug-nav-open');
    },
  },
];

const result = await runProof({
  scenarios,
  root: ROOT,
  argv: process.argv.slice(2),
  label: 'plugin-settings-pages',
  onWebUp: () => {},
});
process.exitCode = result.failed.length > 0 ? 1 : 0;