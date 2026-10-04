import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'session_fixture_overlay_prompts';
const MODEL = 'fixture/model-a';
const open = async (locator) => {
  if (await locator.getAttribute('open') === null) await locator.locator(':scope > summary').click();
};
const noOverflow = async (page) => {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('[role="dialog"]')].some((node) => node.scrollWidth > node.clientWidth + 1)), false, 'Horizontal overflow');
};

const result = await runProof({
  root, argv: process.argv.slice(2), label: 'overlay-prompts', workers: 2,
  distDir: join(root, '.tmp', 'overlay-prompts-proof', 'dist'),
  scenarios: [{ name: 'overlay-prompts', fixture: 'overlay-prompts', matrix: ['theme', 'width'], run: async ({ page, link, shot, view }) => {
    const writes = [];
    const fileChecks = [
      { surface: 'model', branch: 'common', channel: 'cognition_overlay', path: 'C:/fixture/home/cognition/common.md', status: 'ok', model_alias: MODEL },
      { surface: 'model', branch: 'main', channel: 'cognition_overlay', path: 'C:/fixture/home/cognition/main.md', status: 'ok', model_alias: MODEL },
      { surface: 'model', branch: 'common', channel: 'cognition_steering', path: 'C:/fixture/home/cognition/reminder.md', status: 'error', reason: 'File not found', model_alias: MODEL },
    ];
    let auditRequests = 0;
    await page.route('**/api/klient/call', async (route) => {
      const body = route.request().postDataJSON();
      const query = body?.params?.[0];
      if (body?.procedure?.service !== 'agentPanelService' || body.procedure.method !== 'read' || query?.check_all_prompt_files !== true) return route.continue();
      assert.equal(query.session_id, SID);
      assert.equal(query.agent_id, 'main');
      auditRequests++;
      const response = await route.fetch();
      const envelope = await response.json();
      envelope.data.prompt.file_checks = fileChecks;
      return route.fulfill({ response, json: envelope });
    });
    page.on('request', (request) => {
      if (request.method() === 'PATCH') writes.push(request.postDataJSON());
    });
    await page.goto(link('/settings/agents'));
    await page.locator('[data-team-open="lead"]').first().click();
    const fields = page.locator('[data-profile-section="prompt-overrides"]');
    await open(fields);
    await open(fields.locator('[data-prompt-position="main"]'));
    await fields.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot('overlay-profile-fields');
    await fields.locator('[data-prompt-branch-main="off"]').click();
    const save = page.locator('[data-profile-editor] [data-settings-draft] button').filter({ hasText: view.locale === 'zh' ? /^保存$/ : /^Save$/ });
    await save.click();
    await page.locator('[data-saved-tick]').waitFor();
    assert.equal(writes.at(-1)?.prompt_overrides?.main, 'off');
    await page.reload();
    await page.locator('[data-team-open="lead"]').first().click();
    await open(fields);
    await open(fields.locator('[data-prompt-position="main"]'));
    assert.equal(await fields.locator('[data-prompt-branch-main="off"]').getAttribute('aria-pressed'), 'true');
    await fields.locator('[data-prompt-branch-main="same"]').click();
    await save.click();
    await page.locator('[data-saved-tick]').waitFor();
    assert.equal(writes.at(-1)?.prompt_overrides?.main, undefined);
    assert.equal(writes.at(-1)?.prompt_overrides?.fields?.['system.shared'], 'Verify the result before reporting it.');

    await page.goto(link('/settings/agents'));
    await page.locator('[data-team-open="shared"]').first().click();
    await open(fields);
    await open(fields.locator('[data-prompt-position="main"]'));
    await fields.locator('[data-prompt-common] [data-identity-field-row] button').click();
    await page.locator('#profile-description').fill('Updated shared instructions.');
    assert.equal(await save.isDisabled(), true);
    await fields.locator('[data-prompt-branch-main="same"]').click();
    assert.equal(await save.isDisabled(), true, 'Reselecting the active segment does not clear an explicit declaration');
    await fields.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot('overlay-explicit-sharing-error');
    await fields.locator('[data-prompt-clear-explicit="main"]').click();
    assert.equal(await save.isEnabled(), true);
    await noOverflow(page);
    await shot('overlay-explicit-sharing-restored');
    await save.click();
    await page.locator('[data-saved-tick]').waitFor();
    assert.deepEqual(writes.at(-1)?.prompt_overrides, { independent: 'off' });
    assert.equal(writes.at(-1)?.description, 'Updated shared instructions.');

    await page.goto(link('/settings/ai?tab=models'));
    await page.locator(`[data-model-row="${MODEL}"] button[aria-expanded]`).first().click();
    await page.locator(`[data-advanced="model-${MODEL}"] > button`).click();
    const modelEditor = page.locator('[data-model-cognition-editor]');
    await open(modelEditor);
    await open(modelEditor.locator('[data-prompt-position="main"]'));
    await modelEditor.scrollIntoViewIfNeeded();
    assert.equal(await modelEditor.locator('[data-prompt-custom="main"] textarea').first().inputValue(), 'cognition/main.md');
    assert.equal(await modelEditor.locator('[data-prompt-custom="main"] [data-cognition-timing] textarea').first().inputValue(), '');
    await noOverflow(page);
    await shot('overlay-model-main');

    await page.goto(link(`/s/${SID}`));
    await page.locator('[data-session-actions] > button').click();
    await page.locator('[data-prompt-details-open]').click();
    const details = page.locator('[data-profile-section="prompt"]');
    await details.locator('[data-prompt-identity]').waitFor();
    await details.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot('overlay-effective');
    await open(details.locator('[data-prompt-channel="system.shared"]'));
    await details.locator('[data-prompt-channel="system.shared"]').scrollIntoViewIfNeeded();
    await shot('overlay-sources');
    await details.locator('[data-prompt-request]').scrollIntoViewIfNeeded();
    assert.match(await details.locator('[data-prompt-request]').textContent(), /sha256:1ce952/);
    await noOverflow(page);
    await shot('overlay-request');
    assert.equal(auditRequests, 0, 'File audit is an explicit action');
    await details.locator('[data-prompt-file-check-run]').click();
    await details.locator('[data-prompt-file-check-results]').waitFor();
    assert.equal(auditRequests, 1);
    assert.equal(await details.locator('[data-prompt-file-status="ok"]').count(), 2);
    assert.match(await details.locator('[data-prompt-file-status="error"]').textContent(), /File not found/);
    await details.locator('[data-prompt-file-check]').scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot('overlay-file-check');
    if (view.width >= 768) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-prompt-drawer]').waitFor();
      assert.match(await details.locator('[data-prompt-request]').textContent(), /sha256:1ce952/);
      await details.locator('[data-prompt-identity]').scrollIntoViewIfNeeded();
      await noOverflow(page);
      await shot('overlay-open-then-narrow');
    }
    await page.keyboard.press('Escape');
    await page.locator('[data-prompt-drawer]').waitFor({ state: 'detached' });
  } }],
});
if (result.failed.length > 0) process.exitCode = 1;
