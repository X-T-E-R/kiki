/**
 * Visual-proof walker for Settings › Models & providers (fixtures
 * `models-page` and `models-page-empty`): the empty state, three connections
 * of three kinds with one in error, the model list and its search, a model
 * detail with Advanced closed and open, and the new-connection flow (API key
 * lane → protocol form, account lane). Both themes at 1440 and 390. Shots are
 * prefixed with the proof locale so an en and a zh run can share a folder.
 */

export function createModelsPageWalker({ page, shot, resizeViewport, setProofTheme, view, webUrl, fixtureUrl, fixtureToken, locale }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base, theme, width) => `models-${base}-${theme}-${width}-${locale}`;
  const open = async (path, selector) => {
    await page.evaluate(() => {
      try { localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: new Date().toISOString() })); } catch { /* ignore */ }
    });
    await page.goto(url(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { timeout: 20_000 });
    await page.waitForTimeout(500);
  };
  const scrollTo = async (selector) => {
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  };

  async function empty() {
    // Theme and width come from the job (registry `matrix`); the fixture keeps
    // a fresh connection state again, so one pass per context is enough.
    const { theme, width } = view;
    await open('/settings/ai?tab=providers', '[data-connections-empty]');
    await shot(name('empty-connections', theme, width));
    await open('/settings/ai?tab=models', '[data-models-empty]');
    await shot(name('empty-models', theme, width));
  }

  async function populated() {
    const { theme, width } = view;
    // Theme and width come from the job (registry `matrix`): one pass per context.
    // Model list (default tab) — one default line, grouped by connection.
    await open('/settings/ai', '[data-model-row]');
    const defaults = await page.locator('[data-model-row][data-default="true"]').count();
    if (defaults !== 1) throw new Error(`expected one default row, saw ${defaults}`);
    await shot(name('list', theme, width));
    // Search narrows across connections.
    const search = '#st-card-models input[type="search"]';
    await page.fill(search, 'gpt');
    await page.waitForTimeout(200);
    await shot(name('search', theme, width));
    await page.fill(search, '');
    // Detail: common fields first, Advanced collapsed.
    await page.click('[data-model-row="managed:github-copilot/claude-sonnet-4.5"] button[aria-expanded]');
    await page.waitForSelector('[data-model-row-editor="managed:github-copilot/claude-sonnet-4.5"] [data-model-context-fields]', { timeout: 10_000 });
    await scrollTo('[data-model-row="managed:github-copilot/claude-sonnet-4.5"]');
    await shot(name('detail', theme, width));
    await page.click('[data-advanced="model-managed:github-copilot/claude-sonnet-4.5"] > button');
    await scrollTo('[data-advanced="model-managed:github-copilot/claude-sonnet-4.5"]');
    await shot(name('detail-advanced', theme, width));

    // Connections: four kinds, DeepSeek in error from its last test.
    await open('/settings/ai?tab=providers', '[data-connection-row]');
    const health = await page.locator('[data-connection-row="deepseek"]').getAttribute('data-connection-health');
    if (health !== 'error') throw new Error(`expected deepseek in error, saw ${health}`);
    // Account rows: percent + count quotas shown; an unknown quota shows nothing (never 0).
    if (await page.locator('[data-connection-row="managed:kimi-code"] [data-connection-quota="percent"]').count() !== 1) throw new Error('percent quota missing');
    if (await page.locator('[data-connection-row="managed:github-copilot"] [data-connection-quota="count"]').count() !== 1) throw new Error('count quota missing');
    if (await page.locator('[data-connection-row="managed:openai-codex"] [data-connection-quota]').count() !== 0) throw new Error('unknown quota must not render');
    await shot(name('connections', theme, width));
    await page.click('[data-connection-row="deepseek"] > summary');
    await page.waitForSelector('[data-connection-error]', { timeout: 5000 });
    await scrollTo('[data-connection-row="deepseek"]');
    await shot(name('connection-error', theme, width));
    // Test again: in-flight state, then the failed result with its fix.
    const deepseekTest = page.locator('[data-connection-row="deepseek"] [data-connection-test-button]');
    await deepseekTest.click();
    if (!(await deepseekTest.isDisabled())) throw new Error('test button must be disabled while testing');
    await shot(name('connection-testing', theme, width));
    await page.waitForSelector('[data-connection-row="deepseek"] [data-connection-last-test="error"]', { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('[data-connection-row="deepseek"] [data-connection-test-button]')?.hasAttribute('disabled'));
    await page.click('[data-connection-row="deepseek"] > summary');
    // Copilot: never tested → passes.
    await page.click('[data-connection-row="managed:github-copilot"] > summary');
    // "none" on the first pass; later passes see the result persisted by the fixture.
    await page.locator('[data-connection-row="managed:github-copilot"] [data-connection-last-test]').waitFor({ timeout: 5000 });
    await page.locator('[data-connection-row="managed:github-copilot"] [data-connection-test-button]').click();
    await page.waitForSelector('[data-connection-row="managed:github-copilot"] [data-connection-last-test="ok"]', { timeout: 10_000 });
    // A persisted "ok" from an earlier pass is already present; wait for this test to settle.
    await page.waitForFunction(() => !document.querySelector('[data-connection-row="managed:github-copilot"] [data-connection-test-button]')?.hasAttribute('disabled'), null, { timeout: 10_000 });
    await scrollTo('[data-connection-row="managed:github-copilot"]');
    await shot(name('connection-test-ok', theme, width));
    await page.click('[data-connection-row="managed:github-copilot"] > summary');

    // New connection: API lane, then a protocol form, then the account lane.
    await page.click('[data-add-connection]');
    await page.waitForSelector('[data-connection-method-picker]', { timeout: 5000 });
    await scrollTo('#st-card-providers-add');
    await shot(name('add-api', theme, width));
    await page.click('[data-provider-protocol="openai"]');
    await page.waitForSelector('#provider-field-base-url', { timeout: 5000 });
    await scrollTo('#st-card-providers-add');
    await shot(name('add-form', theme, width));
    await page.click('#st-card-providers-add button:has(svg[data-icon="arrowLeft"])');
    await page.click('[data-connection-choice="account"]');
    await page.waitForSelector('[data-oauth-method]', { timeout: 5000 });
    await scrollTo('#st-card-providers-add');
    await shot(name('add-account', theme, width));

    // Defaults tab: every "which model for what" in one card.
    await open('/settings/ai?tab=defaults', '[data-default-row]');
    for (const row of ['fast', 'subagent']) {
      if (await page.locator(`[data-default-row="${row}"]`).count() !== 1) throw new Error(`defaults row ${row} missing`);
    }
    await shot(name('defaults', theme, width));
  }

  return { empty, populated };
}
