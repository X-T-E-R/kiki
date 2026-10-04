/**
 * Visual proof for the connections page as one managed object: a connection
 * list, and one add flow that reaches it three ways.
 *
 * It presses the buttons a person would, against the `oauth-connections`
 * fixture, so every screenshot is the real surface rather than a mock of it:
 *
 *   list      the page as it opens — a working account, one whose credential
 *             the provider will no longer accept, and a key connection beside
 *             them, all as rows of the same list
 *   add       the add flow: sign in, or a service by key from the directory
 *   signin    the sign-in lane, offering only the account the list lacks
 *   device    that sign-in running, with a real code and the open action
 *   recover   the spent credential's own row, where it is recovered in place
 *
 * Width is a declared dimension: the rows and their actions are where 390
 * breaks, so both widths run for every job.
 *
 *   node scripts/visual-proof-oauth-connections.mjs --matrix=all
 *   node scripts/visual-proof-oauth-connections.mjs --only=oauth-list
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAB = '/settings/ai?tab=providers';

const scenarios = [
  {
    name: 'oauth-list', fixture: 'oauth-connections', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-row]', { timeout: 30_000 });
      await page.waitForTimeout(500);
      await shot('oauth-list');
    },
  },
  {
    name: 'oauth-add', fixture: 'oauth-connections', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-list]', { timeout: 30_000 });
      await page.locator('[data-add-connection]').first().click();
      await page.waitForSelector('[data-connection-method-picker]', { timeout: 15_000 });
      await page.waitForTimeout(500);
      await shot('oauth-add');
    },
  },
  {
    name: 'oauth-signin', fixture: 'oauth-connections', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-list]', { timeout: 30_000 });
      await page.locator('[data-add-connection]').first().click();
      await page.waitForSelector('[data-connection-method-picker]', { timeout: 15_000 });
      await page.locator('[data-connection-choice="account"]').click();
      // Only the account the list does not have is offered.
      await page.waitForSelector('[data-oauth-method="openai-codex"]', { timeout: 15_000 });
      await page.waitForTimeout(500);
      await shot('oauth-signin');
    },
  },
  {
    name: 'oauth-device', fixture: 'oauth-connections', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-list]', { timeout: 30_000 });
      await page.locator('[data-add-connection]').first().click();
      await page.waitForSelector('[data-connection-method-picker]', { timeout: 15_000 });
      await page.locator('[data-connection-choice="account"]').click();
      await page.locator('[data-oauth-method="openai-codex"] [data-account-sign-in-button]').click();
      // The pending card only exists once the server has issued a code.
      await page.waitForSelector('[data-oauth-method="openai-codex"] code', { timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot('oauth-device');
    },
  },
  {
    name: 'oauth-recover', fixture: 'oauth-connections', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-row="managed:grok-build"]', { timeout: 30_000 });
      await page.locator('[data-connection-row="managed:grok-build"] summary').click();
      // The spent credential is recovered here, in the connection it already is.
      await page.waitForSelector('[data-connection-account-panel="grok-build"] [data-connection-sign-in]', { timeout: 15_000 });
      await page.waitForTimeout(500);
      await shot('oauth-recover');
    },
  },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'oauth-connections-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
