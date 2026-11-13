/**
 * Visual proof for the settings big-list migration (wt/settings_list_k3):
 * every page that moved onto the shared settings list pattern, shot against
 * the `settings-lists` fixture (a dozen connections, forty models, twenty
 * permission rules, ten channels, eighty skills, fourteen plugins, twelve
 * MCP servers, thirty agent profiles, spaces, identities, prices).
 *
 * One job per page in its declared theme or viewport matrix, on top of the
 * locale base. Shots are named `list-<page>-<view>` so views pair by filename.
 * Notifications also walks IM coalescing and ASR controls at desktop and touch
 * widths.
 *
 *   node scripts/visual-proof-settings-lists.mjs --matrix=all
 *   node scripts/visual-proof-settings-lists.mjs --only=lists-notifications --matrix=all
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeWalker(path, ready, extra) {
  return async function walk({ page, shot, link, view }) {
    await page.goto(link(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready, { timeout: 30_000 });
    await page.waitForTimeout(600);
    await shot(`list-${extra.name}`);
    if (extra.after) await extra.after({ page, shot, name: extra.name, view });
  };
}

const scenarios = [
  { name: 'lists-spaces', fixture: 'settings-lists', matrix: ['theme'], run: makeWalker('/settings/spaces', '[data-space-row]', { name: 'spaces' }) },
  {
    name: 'lists-notifications', fixture: 'settings-lists', matrix: ['width'],
    run: async (context) => {
      await context.page.addInitScript(() => {
        Object.defineProperty(window, 'Notification', {
          configurable: true,
          value: class {
            static permission = 'denied';
            static requestPermission() { throw new Error('Notification permission must not be requested in visual proof'); }
            constructor() { throw new Error('System notifications must not be sent in visual proof'); }
          },
        });
      });
      await makeWalker('/settings/notifications', '[data-notify-channels]', {
        name: 'notifications',
        after: async ({ page, shot, view }) => {
          const activate = async (locator) => {
            if (view.width <= 639) await locator.tap();
            else await locator.click();
          };
          const assertNoOverflow = async () => {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (overflow > 1) throw new Error(`Notifications page overflows the ${view.width}px viewport by ${overflow}px`);
          };
          const select = async (selector) => {
            await activate(page.locator(selector));
            await page.waitForFunction((target) => document.querySelector(target)?.getAttribute('aria-pressed') === 'true', selector, { timeout: 10_000 });
          };
          const rulesSummary = page.locator('[data-im-rules] > summary');
          if (await rulesSummary.count() > 0) {
            await activate(rulesSummary);
            await page.waitForSelector('[data-im-tts-rules]', { timeout: 10_000 });
            const moreSummary = page.locator('[data-im-tts-more] > summary');
            if (await moreSummary.count() > 0) await activate(moreSummary);
            await page.locator('[data-im-tts-rules]').scrollIntoViewIfNeeded();
            await page.waitForTimeout(250);
            await assertNoOverflow();
            await shot('list-notifications-tts');

            const mediaRules = page.locator('[data-im-media-rules]');
            await mediaRules.scrollIntoViewIfNeeded();
            const labels = view.locale === 'zh'
              ? ['消息合并', '语音转文字']
              : ['Combine rapid messages', 'Voice transcription'];
            for (const label of labels) {
              await page.waitForSelector(`[data-im-media-rules] [role="group"][aria-label="${label}"]`, { timeout: 10_000 });
            }
            await page.waitForSelector('[data-im-asr-provider-option="plugin-calendar-0/whisper-cpu"]', { timeout: 10_000 });
            await select('[data-im-coalesce-global="2000"]');
            const untouchedPolicy = await page.evaluate(() => ({
              allowed: document.querySelector('#im-allowed')?.checked,
              defaultEnabled: document.querySelector('#im-default')?.checked,
            }));
            if (untouchedPolicy.allowed !== true || untouchedPolicy.defaultEnabled !== true) {
              throw new Error(`IM policy PATCH replaced untouched fields: ${JSON.stringify(untouchedPolicy)}`);
            }
            await select('[data-im-coalesce-global="3000"]');
            await select('[data-im-asr-mode="off"]');
            await select('[data-im-asr-mode="auto"]');
            await select('[data-im-asr-provider-option=""]');
            await select('[data-im-asr-provider-option="plugin-calendar-0/whisper-cpu"]');
            await assertNoOverflow();
            await shot('list-notifications-im-controls');

            await activate(page.locator('[data-im-account="account-im"] > div > button[aria-controls]'));
            await activate(page.locator('[data-im-binding-options-toggle="binding-im-voice"]'));
            await page.locator('[data-im-binding-coalesce="default"]').scrollIntoViewIfNeeded();
            await select('[data-im-binding-coalesce="2000"]');
            await select('[data-im-binding-coalesce="5000"]');
            await assertNoOverflow();
            await shot('list-notifications-binding-coalesce');

            const discovery = page.locator('[data-im-discovery="discovery-asr"]');
            await activate(discovery.locator('[data-im-advanced-toggle]'));
            await page.locator('[data-im-discovery-coalesce="default"]').scrollIntoViewIfNeeded();
            await select('[data-im-discovery-coalesce="3000"]');
            await select('[data-im-discovery-coalesce="5000"]');
            await assertNoOverflow();
            await shot('list-notifications-confirm-coalesce');
          }
          const away = page.locator('#st-card-notify-away');
          if (await away.isVisible()) await away.scrollIntoViewIfNeeded();
          await assertNoOverflow();
          await shot('list-notifications-overview');
        },
      })(context);
    },
  },
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
