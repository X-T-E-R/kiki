import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

async function walk({ page, link, shot, view, control }) {
  const settings = '/settings/ai?tab=providers';
  const agyAccountRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/executors/agy-cli/account-sources' || url.pathname === '/api/executors/agy-cli/accounts') {
      agyAccountRequests.push({ pathname: url.pathname, source: url.searchParams.get('source') });
    }
  });
  await page.goto(link(settings), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-engine-row="agy-cli"]').waitFor();
  assert.equal(await page.locator('[data-engine-row="agy-cli"]').count(), 1);
  assert.equal(await page.locator('[data-engine-row^="instance-"]').count(), 0);
  assert.equal(agyAccountRequests.length, 0, 'AGY account routes stay idle before an instance form opens');
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

  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const resetTrigger = page.locator('[data-profile-trigger]').first();
  await resetTrigger.click();
  const nativeExecution = page.locator('[data-execution-bare="native"]');
  await nativeExecution.waitFor();
  await nativeExecution.click();
  await resetTrigger.filter({ hasText: 'Kiki' }).waitFor();
  assert.equal(await page.locator('[data-execution-restore]').count(), 0);

  await page.goto(link(`${settings}&engine=agy-cli`), { waitUntil: 'domcontentloaded' });
  const agyCreate = page.locator('[data-engine-instance-form="create"]');
  const agySourcesResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/executors/agy-cli/account-sources' && response.request().method() === 'GET';
  });
  await page.locator('[data-engine-add-instance]').click();
  await agyCreate.waitFor();
  const agySourcePayload = await (await agySourcesResponse).json();
  assert.deepEqual(agySourcePayload.data, {
    items: [{ id: 'plugin:fixture-accounts/accounts', label: 'Fixture OAuth' }],
  });
  assert.equal(agyAccountRequests.filter((request) => request.pathname.endsWith('/account-sources')).length, 1);
  assert.equal(agyAccountRequests.filter((request) => request.pathname.endsWith('/accounts')).length, 0);

  await agyCreate.locator('[data-instance-configuration] option[value="plugin_account"]').waitFor({ state: 'attached' });
  const agyAccountsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/executors/agy-cli/accounts'
      && url.searchParams.get('source') === 'plugin:fixture-accounts/accounts'
      && response.request().method() === 'GET';
  });
  await agyCreate.locator('[data-instance-configuration]').selectOption('plugin_account');
  const agyAccountsPayload = await (await agyAccountsResponse).json();
  assert.deepEqual(agyAccountsPayload.data, {
    items: [
      { id: 'work', label: 'Work account', status: 'ready' },
      { id: 'signed-out', label: 'Other account', status: 'signed_out' },
    ],
  });
  const account = agyCreate.locator('[data-instance-account]');
  await account.locator('option[value="work"]').waitFor({ state: 'attached' });
  await account.locator('option[value="signed-out"]').waitFor({ state: 'attached' });
  assert.equal(await account.inputValue(), '', 'a plugin account form starts without an account selection');
  assert.equal(await account.locator('option[value="signed-out"]').isDisabled(), true);
  assert.equal(agyAccountRequests.filter((request) => request.pathname.endsWith('/accounts')).length, 1);
  await account.selectOption('work');
  await agyCreate.locator('[data-instance-name]').fill('AGY Work account');
  await agyCreate.locator('[data-instance-proxy]').selectOption('url');
  await agyCreate.locator('[data-instance-proxy-value]').fill('http://127.0.0.1:8080');
  await agyCreate.locator('[data-instance-proxy-auth-edit]').click();
  const auth = { username: 'fixture-proxy-user', password: 'fixture-proxy-password' };
  const enterAuth = async (form, value) => {
    await form.locator('[data-instance-proxy-username]').fill(value.username);
    const password = form.locator('[data-instance-proxy-password]');
    assert.equal(await password.getAttribute('type'), 'password');
    await password.fill(value.password);
  };
  const saveInstance = async (form) => {
    const response = page.waitForResponse((result) => new URL(result.url()).pathname === '/api/config' && result.request().method() === 'POST');
    await form.locator('[data-instance-save]').click();
    const saved = await response;
    const payload = await saved.json();
    assert.equal(payload.code, 0);
    assert.doesNotMatch(JSON.stringify(payload.data), /fixture-proxy-(user|password)/);
    return Object.values(saved.request().postDataJSON().agent_executor_instances)[0].proxy;
  };
  await enterAuth(agyCreate, auth);
  await agyCreate.scrollIntoViewIfNeeded();
  await shot(`agy-account-create-${view.locale}-${view.width}`);
  assert.deepEqual((await saveInstance(agyCreate)).authorization, auth);

  const agyEdit = page.locator('[data-engine-instance-form="edit"]');
  await agyEdit.waitFor();
  const agyInstanceId = new URL(page.url()).searchParams.get('engine');
  assert.match(agyInstanceId, /^instance-/);
  assert.equal(await agyEdit.locator('[data-instance-configuration]').inputValue(), 'plugin_account');
  assert.equal(await agyEdit.locator('[data-instance-account-source]').inputValue(), 'plugin:fixture-accounts/accounts');
  assert.equal(await agyEdit.locator('[data-instance-account]').inputValue(), 'work');
  assert.equal(await agyEdit.locator('[data-instance-proxy-value]').inputValue(), 'http://127.0.0.1:8080');
  await agyEdit.scrollIntoViewIfNeeded();
  await shot(`agy-account-edit-${view.locale}-${view.width}`);
  assert.equal(await agyEdit.locator('[data-instance-proxy-password]').count(), 0);
  const proxyAddress = agyEdit.locator('[data-instance-proxy-value]');
  const addressChanged = agyEdit.locator('[data-instance-proxy-address-changed]');
  await proxyAddress.fill('http://127.0.0.1:8080/');
  assert.equal(await addressChanged.count(), 0);
  assert.equal(await agyEdit.locator('[data-instance-proxy-auth-clear]').count(), 1);
  await proxyAddress.fill('http://127.0.0.1:8081');
  await addressChanged.waitFor();
  assert.equal(await agyEdit.locator('[data-instance-proxy-auth-clear]').count(), 0);
  await proxyAddress.fill('http://127.0.0.1:8080');
  assert.equal(await addressChanged.count(), 0);
  await agyEdit.locator('[data-instance-proxy]').selectOption('direct');
  await agyEdit.locator('[data-instance-proxy]').selectOption('url');
  assert.equal(await agyEdit.locator('[data-instance-proxy-value]').inputValue(), 'http://127.0.0.1:8080');
  assert.equal(await agyEdit.locator('[data-instance-proxy-auth-clear]').count(), 1);
  assert.equal((await saveInstance(agyEdit)).authorization, undefined);
  await agyEdit.locator('[data-instance-proxy-auth-edit]').click();
  assert.equal(await agyEdit.locator('[data-instance-proxy-username]').inputValue(), '');
  assert.equal(await agyEdit.locator('[data-instance-proxy-password]').inputValue(), '');
  const replacement = { ...auth, password: 'fixture-proxy-password-replaced' };
  await enterAuth(agyEdit, replacement);
  assert.deepEqual((await saveInstance(agyEdit)).authorization, replacement);
  await agyEdit.locator('[data-instance-proxy-auth-clear]').click();
  await agyEdit.locator('[data-instance-proxy-undo]').click();
  assert.equal((await saveInstance(agyEdit)).authorization, undefined);
  await agyEdit.locator('[data-instance-proxy-auth-clear]').click();
  assert.equal((await saveInstance(agyEdit)).authorization, null);
  await agyEdit.locator('[data-instance-proxy-auth-edit]').click();
  await enterAuth(agyEdit, auth);
  assert.deepEqual((await saveInstance(agyEdit)).authorization, auth);

  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const profileTrigger = page.locator('[data-profile-trigger]').first();
  await profileTrigger.click();
  const globalAgy = page.locator('[data-execution-bare="agy-cli"]');
  const independentAgy = page.locator(`[data-execution-bare="${agyInstanceId}"]`);
  await globalAgy.waitFor();
  await independentAgy.waitFor();
  assert.equal(await page.locator('[data-execution-restore]').count(), 0, 'AGY picker starts from an existing global entry');
  assert.match(await globalAgy.innerText(), /AGY CLI/);
  assert.equal(await globalAgy.locator('[data-execution-account-source]').count(), 0);
  assert.match(await independentAgy.innerText(), /AGY Work account/);
  assert.equal(await independentAgy.locator('[data-execution-account-source]').innerText(), 'fixture-accounts/accounts');
  await shot(`agy-instance-picker-${view.locale}-${view.width}`);
  await independentAgy.click();
  await profileTrigger.filter({ hasText: 'AGY Work account' }).waitFor();
  await shot(`agy-instance-selected-${view.locale}-${view.width}`);
  await profileTrigger.click();
  await globalAgy.click();
  await profileTrigger.filter({ hasText: 'AGY CLI' }).waitFor();

  await control({ action: 'engine_account_source_unavailable', unavailable: true });
  const unavailableSourceResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/executors/agy-cli/account-sources' && response.request().method() === 'GET';
  });
  await page.goto(link(`${settings}&engine=${agyInstanceId}`), { waitUntil: 'domcontentloaded' });
  const unavailableEdit = page.locator('[data-engine-instance-form="edit"]');
  await unavailableEdit.waitFor();
  const unavailablePayload = await (await unavailableSourceResponse).json();
  assert.equal(unavailablePayload.code, 50301);
  const unavailableAlert = unavailableEdit.locator('[role="alert"]');
  await unavailableAlert.waitFor();
  const unavailableText = view.locale === 'zh'
    ? '无法连接此账号来源。请在「扩展与工具」中启用或重新连接对应插件。'
    : 'Cannot reach this account source. Enable or reconnect it in Extensions & tools.';
  assert.equal(await unavailableAlert.innerText(), unavailableText);
  assert.equal(agyAccountRequests.filter((request) => request.pathname.endsWith('/account-sources')).at(-1)?.pathname, '/api/executors/agy-cli/account-sources');
  await unavailableEdit.scrollIntoViewIfNeeded();
  await shot(`agy-account-source-unavailable-${view.locale}-${view.width}`);
}

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  scenarios: [{ name: 'engine-instances', fixture: 'engine-instances', matrix: ['width'], run: walk }],
  argv: process.argv.slice(2), label: 'engine-instances',
});
process.exitCode = result.failed.length ? 1 : 0;
