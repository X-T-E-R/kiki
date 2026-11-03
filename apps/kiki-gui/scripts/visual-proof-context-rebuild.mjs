import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';
import { FIXTURE_TOKEN } from './fixture-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function rebuild({ page, link, fixtureUrl, shot }) {
  const sessions = await fetch(`${fixtureUrl}/api/sessions`, { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } }).then(response => response.json());
  const sid = sessions.data.items[0].id;
  const calls = [];
  let prompts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/prompts$/.test(new URL(request.url()).pathname)) prompts += 1;
  });
  await page.route('**/api/klient/call', async route => {
    const body = route.request().postDataJSON();
    if (body.procedure?.service !== 'agentContextRebuildService' || body.procedure?.method !== 'rebuild') return route.continue();
    calls.push(body);
    if (calls.length === 1) return route.fulfill({ json: { code: 50001, msg: 'Fixture source reload failed', data: null } });
    return route.continue();
  });
  await page.goto(link(`/s/${sid}`), { waitUntil: 'domcontentloaded' });
  const composer = page.locator('[data-composer-variant="main"] [data-composer-input]');
  await composer.waitFor({ timeout: 30_000 });
  await composer.fill('Keep this unsent draft through context rebuild.');
  const history = page.locator('[role="log"]').first();
  await history.waitFor();
  const before = await history.textContent();
  const open = async () => {
    await page.locator('[data-composer-variant="main"] [data-add-menu-trigger]').click();
    await page.locator('[data-add-menu-rebuild]').click();
    await page.locator('[role="alertdialog"]').waitFor();
  };
  await open();
  assert.equal(calls.length, 0);
  await shot('context-rebuild-confirm');
  await page.locator('[role="alertdialog"]').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(calls.length, 0);
  await open();
  await page.locator('[role="alertdialog"]').getByRole('button', { name: 'Rebuild context', exact: true }).click();
  await page.getByText('Context rebuild failed: Fixture source reload failed (code 50001)', { exact: true }).waitFor();
  await shot('context-rebuild-failed');
  await open();
  await page.locator('[role="alertdialog"]').getByRole('button', { name: 'Rebuild context', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('current sources')));
  assert.equal(calls.length, 2);
  for (const body of calls) assert.deepEqual(body.procedure, { scope: 'agent', sessionId: sid, agentId: 'main', service: 'agentContextRebuildService', method: 'rebuild' });
  assert.equal(await composer.textContent(), 'Keep this unsent draft through context rebuild.');
  assert.equal(await history.textContent(), before);
  assert.equal(new URL(page.url()).pathname, `/s/${sid}`);
  assert.equal(prompts, 0);
  await shot('context-rebuild-applied');
  console.log('[check] rebuild confirmation and cancel, visible failure and successful retry use the same main; history and unsent draft survive; no prompt submission');
}

const result = await runProof({ root, scenarios: [{ name: 'context-rebuild', fixture: 'history-paging', run: rebuild }], argv: process.argv.slice(2), label: 'context-rebuild', workers: 1 });
if (result.failed.length > 0) process.exitCode = 1;
