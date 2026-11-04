import { join } from 'node:path';

const check = (condition, message) => { if (!condition) throw new Error(message); };

export default {
  name: 'usage-auto-upload',
  scenario: 'usage-export',
  vite: true,
  routes: [{
    name: 'automatic-upload',
    path: '/usage?panel=export',
    waitFor: '[data-usage-export-add]',
    async setup({ page, view, outputDir }) {
      const suffix = `${view.locale}-${view.viewport}`;
      const shot = async (name) => page.screenshot({ path: join(outputDir, `${name}-${suffix}.png`) });
      const requests = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/usage-export/destinations') requests.push(request.postDataJSON());
      });
      await page.locator('[data-usage-export-add]').click();
      await page.locator('[data-usage-export-form="create"]').waitFor();
      const automatic = page.locator('[data-usage-export-form-auto-upload]');
      check(await automatic.getAttribute('aria-checked') === 'true', 'new form must default automatic upload on');
      check(await page.locator('[data-usage-export-form-schedule]').inputValue() === '120', 'new form must default to 120 minutes');
      check(requests.length === 0, 'opening a form must not save or authorize anything');
      await page.locator('[data-usage-export-vibe-login]').scrollIntoViewIfNeeded();
      await shot('default-vibe-consent');
      await page.context().route('https://vibecafe.ai/**', (route) => route.fulfill({ body: 'Synthetic sign-in fixture', contentType: 'text/plain' }));
      const deny = async (route) => {
        const response = await route.fetch(); const envelope = await response.json();
        await route.fulfill({ response, json: { ...envelope, data: { ...envelope.data, state: 'denied' } } });
      };
      await page.route('**/api/usage-export/destinations/*/auth/begin', deny);
      await page.locator('[data-usage-export-vibe-login]').click();
      await page.locator('[data-usage-export-vibe-connect="denied"]').waitFor();
      check(requests.every((request) => request.auto_upload === undefined), 'failed sign-in must not authorize a save');
      await shot('vibe-sign-in-denied');
      await page.unroute('**/api/usage-export/destinations/*/auth/begin', deny);
      await page.locator('[data-usage-export-vibe-login]').click();
      await page.locator('[data-usage-export-form]').waitFor({ state: 'detached' });
      await shot('vibe-enabled-after-sign-in');
      await page.locator('[data-usage-export-add]').click();
      requests.length = 0;
      await page.locator('[data-axis="export-kind"] [data-axis-value="webhook"]').click();
      await page.locator('[data-usage-export-form-name]').fill(`Example warehouse ${suffix}`);
      await page.locator('[data-usage-export-form-endpoint]').fill('https://warehouse.example.test/usage');
      await automatic.scrollIntoViewIfNeeded();
      await shot('webhook-consent');
      await page.locator('[data-usage-export-form-save]').click();
      await page.locator('[data-usage-export-form]').waitFor({ state: 'detached' });
      check(requests.length === 1 && requests[0].auto_upload === true, 'one save must authorize the supplied destination');
      check(requests[0].draft.schedule_minutes === 120, 'the saved schedule must stay 120 minutes');
      const row = page.locator('[data-usage-export-row]').filter({ hasText: `Example warehouse ${suffix}` });
      await row.waitFor(); await row.click();
      const destination = row.locator('..');
      check(await destination.locator('[data-usage-export-state="ready"]').count() > 0, 'save consent must read back as ready');
      await shot('saved-active');

      await destination.locator('[data-usage-export-edit]').click();
      await page.locator('[data-usage-export-form-schedule]').selectOption('60');
      check(await automatic.getAttribute('aria-checked') === 'true', 'interval editing must keep enabled choice');
      const saveText = await page.locator('[data-usage-export-form-save]').innerText();
      check(saveText.trim() === (view.locale === 'zh' ? '保存' : 'Save'), 'interval-only save must not ask for consent again');
      await automatic.click();
      await page.locator('[data-usage-export-form-save]').click();
      await page.locator('[data-usage-export-form]').waitFor({ state: 'detached' });
      check(requests.at(-1).auto_upload === false, 'unchecked save must explicitly disable');
      await shot('saved-disabled');

      if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
      await destination.locator('[data-usage-export-edit]').click();
      check(await automatic.getAttribute('aria-checked') === 'false', 'reopening a disabled destination must preserve off');
      await page.locator('[data-usage-export-form-schedule]').selectOption('120');
      await automatic.scrollIntoViewIfNeeded();
      await shot('disabled-edit');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 1, `usage form overflows viewport by ${overflow}px`);
    },
  }],
  matrix: { themes: ['light'], locales: ['en', 'zh'], viewports: ['wide', 'narrow'] },
};
