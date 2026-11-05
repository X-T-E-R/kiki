import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

async function walk({ page, link, shot, view }) {
  const settings = '/settings/ai?tab=providers';
  await page.goto(link(settings), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-engine-row="agy-cli"]').waitFor();
  assert.equal(await page.locator('[data-engine-row="agy-cli"]').count(), 1);
  assert.equal(await page.locator('[data-engine-row^="instance-"]').count(), 0);
  await page.locator('[data-engine-row="codex-app-server"] [data-engine-open]').click();
  await page.locator('[data-engine-add-instance]').click();
  const create = page.locator('[data-engine-instance-form="create"]');
  await create.locator('[data-instance-name]').fill('Work account');
  await create.locator('[data-instance-configuration]').selectOption('config_directory');
  await create.locator('[data-instance-configuration-value]').fill('C:/fixture/accounts/work');
  await create.locator('[data-instance-proxy]').selectOption('url');
  await create.locator('[data-instance-proxy-value]').fill('http://127.0.0.1:8080');
  await create.scrollIntoViewIfNeeded();
  await shot(`instance-create-${view.locale}-${view.width}`);
  await create.locator('[data-instance-save]').click();
  const edit = page.locator('[data-engine-instance-form="edit"]');
  await edit.waitFor();
  const workId = new URL(page.url()).searchParams.get('engine');
  assert.match(workId, /^instance-/);
  assert.equal(await edit.locator('[data-instance-name]').inputValue(), 'Work account');
  assert.equal(await edit.locator('[data-instance-proxy-value]').inputValue(), 'http://127.0.0.1:8080');
  await edit.locator('[data-instance-name]').fill('Work · direct');
  await edit.locator('[data-instance-proxy]').selectOption('direct');
  await edit.locator('[data-instance-save]').click();
  await page.waitForFunction(() => document.querySelector('[data-detail-heading]')?.textContent === 'Work · direct');
  await edit.scrollIntoViewIfNeeded();
  await shot(`instance-edit-${view.locale}-${view.width}`);

  await page.goto(link(`${settings}&engine=codex-app-server`), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-engine-add-instance]').click();
  await create.locator('[data-instance-name]').fill('Personal account');
  await create.locator('[data-instance-configuration]').selectOption('config_directory');
  await create.locator('[data-instance-configuration-value]').fill('C:/fixture/accounts/personal');
  await create.locator('[data-instance-proxy]').selectOption('env');
  await create.locator('[data-instance-proxy-value]').fill('PERSONAL_SOCKS_PROXY');
  await create.locator('[data-instance-save]').click();
  await edit.waitFor();
  const personalId = new URL(page.url()).searchParams.get('engine');
  assert.notEqual(personalId, workId);

  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-profile-trigger]').first().click();
  const work = page.locator(`[data-execution-bare="${workId}"]`);
  await work.waitFor();
  await page.locator(`[data-execution-bare="${personalId}"]`).waitFor();
  assert.match(await work.innerText(), /Codex/);
  assert.doesNotMatch(await work.innerText(), /instance-/);
  await shot(`instance-picker-${view.locale}-${view.width}`);
  await work.click();
  await page.locator('[data-profile-trigger]').filter({ hasText: 'Work · direct' }).waitFor();

  await page.goto(link(`${settings}&engine=${workId}`), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-engine-remove-registration]').click();
  await page.locator('[data-engine-row="agy-cli"]').waitFor();
  assert.equal(await page.locator(`[data-engine-row="${workId}"]`).count(), 0);
  assert.equal(await page.locator(`[data-engine-row="${personalId}"]`).count(), 1);
  assert.equal(await page.locator('[data-engine-row="agy-cli"]').count(), 1);
  await page.locator('#st-card-engines').scrollIntoViewIfNeeded();
  await shot(`instance-removed-${view.locale}-${view.width}`);
}

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  scenarios: [{ name: 'engine-instances', fixture: 'engine-instances', matrix: ['width'], run: walk }],
  argv: process.argv.slice(2), label: 'engine-instances',
});
process.exitCode = result.failed.length ? 1 : 0;
