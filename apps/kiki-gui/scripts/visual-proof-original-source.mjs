/**
 * Visual proof for choosing where a connection's sign-in comes from.
 *
 * This is a continuation of the connections page, not a separate surface: every
 * shot here is the same single list, with the source choice inside the row that
 * owns the connection. The three jobs are the three states a person meets and
 * has to act on, and nothing else is photographed:
 *
 *   attached    a connection already using the sign-in this machine holds —
 *               which is where it is kept, that Kiki renews it, and the one
 *               action, worded so it cannot be read as signing out Codex
 *   replaced    the machine's credential is a different account now, so the
 *               page says which and offers no way to attach it
 *   attach      a credential this machine holds that nobody is attached to,
 *               after the check and before the action: the account is named
 *               first, and only then can it be used
 *
 * Width is a declared dimension, because a refusal that is only a colour is a
 * refusal nobody reads at 390.
 *
 * Set KIKI_PROOF_OUTPUT_DIR to keep these beside the other runs; a disposable
 * run otherwise gets a timestamp directory that later proof runs may prune.
 *
 *   node scripts/visual-proof-original-source.mjs --matrix=all
 *   node scripts/visual-proof-original-source.mjs --only=source-replaced
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAB = '/settings/ai?tab=providers';

const scenarios = [
  {
    // The one state the first round had no picture of: a connection attached to
    // a credential the machine has since replaced. It must not be described as
    // working, and it must still offer a way back.
    name: 'source-spent', fixture: 'original-source-spent', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-row="managed:openai-codex"]', { timeout: 30_000 });
      await page.locator('[data-connection-row="managed:openai-codex"] summary').click();
      await page.waitForSelector('[data-original-source-unusable]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      await shot('source-spent');
    },
  },
  {
    name: 'source-attached', fixture: 'original-source', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-connection-row="managed:openai-codex"]', { timeout: 30_000 });
      await page.locator('[data-connection-row="managed:openai-codex"] summary').click();
      await page.waitForSelector('[data-original-source-state]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      await shot('source-attached');
    },
  },
  {
    name: 'source-replaced', fixture: 'original-source', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-add-connection]', { timeout: 30_000 });
      await page.locator('[data-add-connection]').first().click();
      await page.waitForSelector('[data-connection-method-picker]', { timeout: 30_000 });
      await page.locator('[data-connection-choice="account"]').click();
      const row = page.locator('[data-oauth-method="grok-build"]');
      await row.locator('[data-original-source-probe]').waitFor({ timeout: 15_000 });
      // The search is pointed at a directory on the server that holds a
      // credential for someone else's account. That is a different question
      // from the default one, so it is asked there.
      await row.locator('[data-original-source-advanced]').click();
      const input = row.locator('[data-original-source-home-dir]');
      await input.fill('/srv/agent-home/.grok');
      await row.locator('[data-original-source-probe]').click();
      // The machine is read before anything is offered, and the refusal is
      // reported as its own sentence rather than a colour on the row.
      await page.waitForSelector('[data-original-source-result="accountChanged"]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      await shot('source-replaced');
    },
  },
  {
    name: 'source-attach', fixture: 'original-source', matrix: ['width'],
    run: async ({ page, shot, link }) => {
      // Opened from the add flow, not a row: this is what a credential on the
      // machine looks like to someone deciding whether to use it, before any
      // connection exists for it.
      await page.goto(link(TAB), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-add-connection]', { timeout: 30_000 });
      await page.locator('[data-add-connection]').first().click();
      await page.waitForSelector('[data-connection-method-picker]', { timeout: 30_000 });
      await page.locator('[data-connection-choice="account"]').click();
      await page.waitForSelector('[data-oauth-method="grok-build"] [data-original-source-probe]', { timeout: 15_000 });
      await page.locator('[data-oauth-method="grok-build"] [data-original-source-probe]').click();
      await page.waitForSelector('[data-original-source-result="connectable"]', { timeout: 15_000 });
      // The account is named before the action, and pointing the search at a
      // different directory is a normal input rather than a support path.
      await page.locator('[data-oauth-method="grok-build"] [data-original-source-advanced]').click();
      await page.waitForTimeout(400);
      await shot('source-attach');
    },
  },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'original-source-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
