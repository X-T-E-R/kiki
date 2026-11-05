import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runProof({
  root, label: 'plugin-settings', argv: process.argv.slice(2), jobTimeoutMs: 120_000,
  scenarios: [{
    name: 'plugin-settings', fixture: 'output-layer-settings', matrix: ['width'],
    run: async ({ page, link, shot, control }) => {
      const go = async (id) => {
        await page.goto(link(`/settings/plugins?plugin=${id}`));
        await page.locator(`[data-plugin-settings-page="${id}"]`).waitFor();
      };
      const panel = () => page.frameLocator('[data-plugin-settings-panel="kiki-output-layer"]');
      const ready = () => panel().locator('#editor:not([disabled])').waitFor();
      const save = async () => {
        await panel().locator('#save').click();
        await panel().locator('#save:disabled').waitFor();
        await ready();
      };
      const open = async (id) => {
        const details = panel().locator(`#${id}`);
        if (!await details.evaluate((node) => node.open)) await details.locator('summary').click();
      };
      const noOverflow = async () => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.ok(await panel().locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      };
      let failCatalog = true;
      let failConfig = true;
      await page.route('**/api/plugins/kiki-output-layer/panels/settings/bridge', async (route) => {
        const request = route.request().postDataJSON();
        if (request.method === 'plugin.models.list' && failCatalog || request.method === 'plugin.call' && failConfig) {
          const msg = request.method === 'plugin.call' ? 'Configuration temporarily unavailable' : 'Model catalog temporarily unavailable';
          return route.fulfill({ json: { code: 50001, msg, data: null, request_id: 'plugin-settings-proof' } });
        }
        await route.continue();
      });
      await go('kiki-output-layer');
      await panel().locator('#load-error:not([hidden])').waitFor();
      assert.equal(await panel().locator('#save').isVisible(), false);
      failConfig = false;
      await panel().locator('#retry').click();
      await ready();
      assert.equal(await panel().locator('#template option').count(), 6);
      assert.equal(await panel().locator('#connectionId').inputValue(), 'studio');
      assert.equal(await panel().locator('#customModelId').inputValue(), 'legacy-reader-v1');
      await open('preset-advanced');
      assert.equal(await panel().locator('#maxOutputTokens').inputValue(), '2048');
      assert.equal(await panel().locator('#contextWindow').inputValue(), '65536');
      await panel().locator('#preset-advanced summary').click();
      await panel().locator('#catalog-error:not([hidden])').waitFor();
      await shot('output-catalog-failed');
      failCatalog = false;
      await panel().locator('#retry-models').click();
      await panel().locator('#catalog-error[hidden]').waitFor({ state: 'attached' });
      await shot('output-open');
      await open('add-details');
      await panel().locator('#template').selectOption('translate-en');
      await panel().locator('#add').click();
      assert.equal(await panel().locator('#maxOutputTokens').inputValue(), '');
      assert.equal(await panel().locator('#customModelId').inputValue(), '');
      await panel().locator('#label').fill('Evening reading');
      await panel().locator('#instruction').fill('Preserve every fact and rewrite clearly.');
      await panel().locator('#prompt-details summary').click();
      await panel().locator('#model-picker').click();
      await panel().locator('#model-search').fill('reader small');
      await panel().locator('#model-search').press('Enter');
      assert.equal(await panel().locator('#model-name').textContent(), 'Reader Small');
      await noOverflow();
      await shot('output-model-selected');
      // A refused disable leaves the running editor and its dirty guard intact.
      await page.route('**/api/plugins/kiki-output-layer:disable', (route) => route.fulfill({ json: { code: 50001, msg: 'Could not disable this plugin. Try again.', data: null, request_id: 'plugin-settings-proof' } }), { times: 1 });
      await page.locator('[data-plugin-settings-switch] [role=switch]').click();
      await page.getByRole('alertdialog').getByRole('button').last().click();
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
      await page.locator('[data-toast="error"]').waitFor();
      assert.equal(await page.locator('[data-toast="error"]').count(), 1);
      assert.equal(await page.locator('[data-plugin-effective-scope] [role=alert]').count(), 0);
      await ready();
      assert.equal(await panel().locator('#label').inputValue(), 'Evening reading');
      await shot('output-disable-failed');
      // The iframe's dirty notification reaches the real app-wide route guard.
      await page.locator('[data-plugin-settings-back]').click();
      await page.getByRole('alertdialog').waitFor();
      await shot('output-unsaved-guard');
      await page.keyboard.press('Escape');
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
      await control({ action: 'plugin_settings_fail_next', plugin_id: 'kiki-output-layer' });
      await panel().locator('#save').click();
      await panel().locator('#status.error').waitFor();
      assert.equal(await panel().locator('#save').isEnabled(), true);
      assert.equal(await panel().locator('#label').inputValue(), 'Evening reading');
      await shot('output-save-failed');
      await save();
      await page.reload();
      await ready();
      assert.equal(await panel().locator('#preset option').count(), 2);
      await panel().locator('#preset').selectOption('1');
      assert.equal(await panel().locator('#label').inputValue(), 'Evening reading');
      assert.equal(await panel().locator('#instruction').inputValue(), 'Preserve every fact and rewrite clearly.');
      assert.equal(await panel().locator('#model-name').textContent(), 'Reader Small');
      assert.equal(await panel().locator('#maxOutputTokens').inputValue(), '');
      await panel().locator('#model-picker').click();
      await panel().locator('#model-search').fill('custom');
      // The custom item is localized; arrow navigation operates without a pointer.
      if (await panel().locator('#model-options [role=option]').count() === 0) await panel().locator('#model-search').fill('自定义');
      await panel().locator('#model-search').press('Enter');
      await panel().locator('#connectionId').selectOption('openai-main');
      await panel().locator('#customModelId').fill('custom-reader-v2');
      await save();
      await page.reload();
      await ready();
      await panel().locator('#preset').selectOption('1');
      assert.equal(await panel().locator('#connectionId').inputValue(), 'openai-main');
      assert.equal(await panel().locator('#customModelId').inputValue(), 'custom-reader-v2');
      await panel().locator('#remove').click();
      await panel().locator('#cancel-remove').press('Tab');
      assert.equal(await panel().locator('#confirm-remove').evaluate((node) => node === document.activeElement), true);
      await panel().locator('#confirm-remove').press('Enter');
      await save();
      await page.reload();
      await ready();
      assert.equal(await panel().locator('#preset option').count(), 1);
      assert.equal(await panel().locator('#customModelId').inputValue(), 'legacy-reader-v1');
      assert.equal(await panel().locator('#maxOutputTokens').inputValue(), '2048');
      await noOverflow();
      // A clean editor's disable failure belongs by the switch, not in a toast.
      await page.route('**/api/plugins/kiki-output-layer:disable', (route) => route.fulfill({ json: { code: 50001, msg: 'Could not disable this plugin. Try again.', data: null, request_id: 'plugin-settings-proof' } }), { times: 1 });
      const enableSwitch = page.locator('[data-plugin-settings-switch] [role=switch]');
      await enableSwitch.click();
      await page.locator('[data-plugin-effective-scope] [role=alert]').waitFor();
      assert.equal(await page.locator('[data-toast="error"]').count(), 0);
      // A disabled or failed dedicated panel never becomes the raw schema editor.
      await enableSwitch.click();
      await page.locator('[data-plugin-settings-panel-off]').waitFor();
      assert.equal(await page.locator('[data-plugin-settings="kiki-output-layer"]').count(), 0);
      assert.equal(await page.locator('[data-plugin-setting="presets"]').count(), 0);
      await shot('output-disabled');
      await page.locator('[data-plugin-settings-switch] [role=switch]').click();
      await ready();
      // The real Media manifest with its dedicated panel removed exercises the
      // shared form, using the same effective Host field declarations.
      let failSharedCatalog = true;
      await page.route('**/api/plugins/models', async (route) => {
        if (failSharedCatalog) return route.fulfill({ json: { code: 50001, msg: 'Model catalog temporarily unavailable', data: null, request_id: 'plugin-settings-proof' } });
        await route.continue();
      });
      await go('media-schema-fixture');
      await page.locator('[data-plugin-setting-group-open="agnes"]').click();
      const connection = page.locator('[data-plugin-setting-catalog="agnes__connectionId"]');
      await connection.getByRole('alert').waitFor();
      assert.ok((await connection.locator('button').first().textContent()).includes('studio'));
      await shot('media-catalog-failed');
      failSharedCatalog = false;
      await connection.locator('button').last().click();
      await connection.getByRole('alert').waitFor({ state: 'hidden' });
      await page.locator('[data-plugin-setting-group-switch="agnes"] [role=switch]').click();
      const formSave = () => page.locator('[data-settings-draft="plugin-settings-media-schema-fixture"] button').first().click();
      const formSaved = () => page.locator('[data-settings-draft-saved="plugin-settings-media-schema-fixture"]').waitFor();
      await formSave();
      await formSaved();
      await page.reload();
      await page.locator('[data-plugin-setting-group-open="agnes"]').click();
      assert.equal(await page.locator('[data-plugin-setting-group-switch="agnes"] [role=switch]').getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('[data-plugin-setting="agnes__baseUrl"] input').inputValue(), '');
      assert.equal(await page.locator('[data-plugin-setting="agnes__apiKey"] input').inputValue(), '');
      assert.equal(await page.locator('[data-plugin-setting="agnes__apiKey"] [data-secret-field]').getAttribute('data-secret-source'), 'kiki');
      await connection.locator('button').first().click();
      await page.locator('[role=option][data-option-value=""]').click();
      await formSave();
      await page.locator('[data-plugin-setting="agnes__baseUrl"] [role=alert]').waitFor();
      await shot('media-self-managed-required');
      await page.locator('[data-plugin-setting="agnes__baseUrl"] input').fill('https://example.test/media');
      await formSave();
      await formSaved();
      await page.reload();
      await page.locator('[data-plugin-setting-group-open="agnes"]').click();
      assert.equal(await page.locator('[data-plugin-setting="agnes__baseUrl"] input').inputValue(), 'https://example.test/media');
      assert.equal(await page.locator('[data-plugin-setting="agnes__apiKey"] [data-secret-field]').getAttribute('data-secret-source'), 'kiki');
      await page.locator('[data-plugin-setting-group-open="openai"]').click();
      assert.ok((await page.locator('[data-plugin-setting-catalog="openai__connectionId"] button').first().textContent()).includes('openai-main'));
      assert.equal(await page.locator('[data-plugin-setting="openai__apiKey"] [data-secret-field]').getAttribute('data-secret-source'), 'kiki');
      assert.equal(await page.locator('[data-plugin-setting="google__cleared"]').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await shot('media-schema');
      await go('kiki-media');
      await page.frameLocator('[data-plugin-settings-panel="kiki-media"]').locator('#content:not([hidden])').waitFor();
      assert.equal(await page.locator('[data-plugin-settings="kiki-media"]').count(), 0);
      // Real ordinary manifest, existing write-only credential surface and save/reopen.
      await go('kiki-extract');
      await page.locator('[data-plugin-setting="pythonPath"] input').fill('python-isolated');
      const extractSwitch = page.locator('[data-plugin-settings-switch] [role=switch]');
      await extractSwitch.click();
      await page.locator('[data-plugin-effective-scope][data-plugin-scope-global="off"]').waitFor();
      assert.equal(await page.locator('[data-plugin-setting="pythonPath"] input').inputValue(), 'python-isolated');
      await page.locator('[data-settings-draft="plugin-settings-kiki-extract"] button').first().click();
      await page.locator('[data-settings-draft-saved="plugin-settings-kiki-extract"]').waitFor();
      await page.reload();
      await page.locator('[data-plugin-setting="pythonPath"] input').waitFor();
      assert.equal(await page.locator('[data-plugin-setting="pythonPath"] input').inputValue(), 'python-isolated');
      await shot('extract-schema');
      await go('kiki-mail');
      const mailLink = page.locator('[data-plugin-workspace-settings="mail"]');
      await mailLink.waitFor();
      assert.equal(await page.locator('[data-plugin-setting="accounts"]').count(), 0);
      assert.equal(await page.locator('[data-plugin-setting="credentials"]').count(), 0);
      assert.equal(await page.locator('[data-plugin-setting="oauthDefaults"]').count(), 0);
      await mailLink.click();
      await page.locator('[data-plugin-panel-sheet="kiki-mail:mail"]').waitFor();
      await page.frameLocator('[data-plugin-panel="kiki-mail:mail"]').getByRole('heading', { name: 'Mail fixture' }).waitFor();
      await shot('mail-management-route');
    },
  }],
});
process.exitCode = result.failed.length ? 1 : 0;
