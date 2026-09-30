/**
 * Visual proof for the settings big-list migration (wt/settings_list_k3):
 * every page that moved onto the shared settings list pattern, shot against
 * the `settings-lists` fixture (a dozen connections, forty models, twenty
 * permission rules, ten channels, eighty skills, fourteen plugins, twelve
 * MCP servers, thirty agent profiles, spaces, identities, prices).
 *
 * One job per page, theme matrix on top of the locale base. Shots are named
 * `list-<page>-<view>` so before/after runs pair up by filename.
 *
 *   node scripts/visual-proof-settings-lists.mjs --matrix=all
 *   node scripts/visual-proof-settings-lists.mjs --only=lists-spaces
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeWalker(path, ready, extra) {
  return async function walk({ page, shot, link }) {
    await page.goto(link(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready, { timeout: 30_000 });
    await page.waitForTimeout(600);
    await shot(`list-${extra.name}`);
    if (extra.after) await extra.after({ page, shot, name: extra.name });
  };
}

const scenarios = [
  { name: 'lists-spaces', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/spaces', '[data-space-row]', { name: 'spaces' }) },
  { name: 'lists-notifications', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/notifications', '[data-notify-channels]', { name: 'notifications' }) },
  { name: 'lists-permissions', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/permissions', '[data-permission-rules]', { name: 'permissions' }) },
  { name: 'lists-providers', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/ai?tab=providers', '[data-connection-list]', { name: 'providers' }) },
  { name: 'lists-identity', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/identity', '[data-identity-row]', { name: 'identity' }) },
  { name: 'lists-search', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/search?tab=providers', '#st-card-search-providers', { name: 'search-providers' }) },
  {
    name: 'lists-agents', fixture: 'settings-lists', matrix: ['theme'],
    run: makeWalker('/settings/agents', '[data-team-row]', { name: 'agents' }),
  },
  {
    name: 'lists-skills', fixture: 'settings-lists', matrix: ['theme'],
    run: makeWalker('/capabilities?tab=skills', '[data-skill-row]', { name: 'skills' }),
  },
  {
    name: 'lists-plugins', fixture: 'settings-lists', matrix: ['theme'],
    run: makeWalker('/capabilities?tab=plugins&view=installed', '[data-plugin-row]', { name: 'plugins' }),
  },
  { name: 'lists-mcp', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/capabilities?tab=mcp', '[data-mcp-server]', { name: 'mcp' }) },
  {
    name: 'lists-pricing', fixture: 'settings-lists', matrix: ['theme'],
    run: async ({ page, shot, link }) => {
      await page.goto(link('/usage'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-usage-pricing-open]', { timeout: 30_000 });
      await page.locator('[data-usage-pricing-open]').click();
      await page.waitForSelector('[data-usage-pricing-panel] [data-pricing-row]', { timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot('list-pricing');
    },
  },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'settings-lists-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
