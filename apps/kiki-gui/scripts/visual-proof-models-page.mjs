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
  }

  async function populated() {
    const { theme, width } = view;
    // Theme and width come from the job (registry `matrix`): one pass per context.
    // Models live inside their connection; the retired Models tab lands here.
    await open('/settings/ai?tab=models', '[data-connection-row]');
    if (!page.url().includes('tab=providers')) throw new Error(`tab=models must land on providers, saw ${page.url()}`);
    await page.click('[data-connection-row="managed:github-copilot"] > summary');
    await page.waitForSelector('[data-connection-row="managed:github-copilot"] [data-provider-models] [data-model-row]', { timeout: 10_000 });
    await scrollTo('[data-connection-row="managed:github-copilot"] [data-provider-models]');
    await shot(name('list', theme, width));
    // Search finds a connection by the models it carries.
    const search = '[data-list-search]';
    await page.fill(search, 'gpt');
    await page.waitForTimeout(200);
    await shot(name('search', theme, width));
    await page.fill(search, '');
    // Detail 1: inherited protocol from provider (`openai`) with provider origins.
    await page.click('[data-model-row="managed:github-copilot/claude-sonnet-4.5"] button[aria-expanded]');
    const sonnetEditor = '[data-model-row-editor="managed:github-copilot/claude-sonnet-4.5"]';
    await page.waitForSelector(`${sonnetEditor} [data-model-context-fields]`, { timeout: 10_000 });
    await page.waitForSelector(`${sonnetEditor} [data-model-protocol-field="inherit"]`, { timeout: 5000 });
    const sonnetEffective = (await page.locator(`${sonnetEditor} [data-effective-protocol]`).textContent())?.trim() ?? '';
    if (!sonnetEffective.includes('Chat Completions')) {
      throw new Error(`expected inherited Chat Completions effective protocol line, saw "${sonnetEffective}"`);
    }
    const expectedInheritedSub = locale === 'zh'
      ? ['供应商类型', '端点 提供商', '凭据 提供商']
      : ['provider type', 'endpoint provider', 'credential provider'];
    for (const token of expectedInheritedSub) {
      if (!sonnetEffective.includes(token)) {
        throw new Error(`expected "${token}" in inherited effective line, saw "${sonnetEffective}"`);
      }
    }
    await scrollTo(`${sonnetEditor} [data-model-protocol-field]`);
    await shot(name('detail', theme, width));
    await page.click(`${sonnetEditor} [data-model-editor-tab="advanced"]`);
    await page.waitForSelector('[data-advanced="model-managed:github-copilot/claude-sonnet-4.5"] > button', { timeout: 5000 });
    await page.click('[data-advanced="model-managed:github-copilot/claude-sonnet-4.5"] > button');
    await scrollTo('[data-advanced="model-managed:github-copilot/claude-sonnet-4.5"]');
    await shot(name('detail-advanced', theme, width));
    await page.locator('[data-model-detail="managed:github-copilot/claude-sonnet-4.5"] header button').click();
    await page.locator(sonnetEditor).waitFor({ state: 'detached' });

    // Detail 2: model-level explicit protocol (`google-genai`) different from provider (`openai`),
    // model endpoint + env credential (`OPENAI_API_KEY`) + override routing warning, plus interactive save.
    await page.click('[data-model-row="managed:github-copilot/gemini-2.5-pro"] button[aria-expanded]');
    const geminiEditor = '[data-model-row-editor="managed:github-copilot/gemini-2.5-pro"]';
    await page.waitForSelector(`${geminiEditor} [data-model-protocol-field="google-genai"]`, { timeout: 10_000 });
    const geminiEffective = (await page.locator(`${geminiEditor} [data-effective-protocol]`).textContent())?.trim() ?? '';
    const expectedExplicitSub = locale === 'zh'
      ? ['Google GenAI', '此模型', '端点 模型', '凭据 环境变量 (OPENAI_API_KEY)']
      : ['Google GenAI', 'this model', 'endpoint model', 'credential env (OPENAI_API_KEY)'];
    for (const token of expectedExplicitSub) {
      if (!geminiEffective.includes(token)) {
        throw new Error(`expected "${token}" in explicit effective line, saw "${geminiEffective}"`);
      }
    }
    const geminiIssue = (await page.locator(`${geminiEditor} [role="status"]`).first().textContent())?.trim() ?? '';
    if (!geminiIssue.includes('overrides:') || !geminiIssue.includes('base_url, protocol')) {
      throw new Error(`expected override routing warning in gemini editor, saw "${geminiIssue}"`);
    }
    await scrollTo(`${geminiEditor} [data-model-protocol-field]`);
    await shot(name('detail-protocol', theme, width));
    const geminiPanel = '[data-model-detail="managed:github-copilot/gemini-2.5-pro"]';
    const reopenGemini = async () => {
      await page.locator(`${geminiPanel} header button`).click();
      await page.locator(geminiEditor).waitFor({ state: 'detached' });
      await page.click('[data-model-row="managed:github-copilot/gemini-2.5-pro"] button[aria-expanded]');
    };
    // Reopen after each save so the assertion observes stored state, not only a draft.
    for (const protocol of ['anthropic', 'google-genai']) {
      await page.click(`${geminiEditor} [data-model-protocol-field] [data-searchable-select] > button`);
      await page.click(`[data-select-panel] [data-option-value="${protocol}"]`);
      await page.waitForSelector(`${geminiEditor} [data-model-protocol-field="${protocol}"]`, { timeout: 5000 });
      await page.locator(`${geminiEditor} [data-model-editor-actions] > button`).first().click();
      await page.waitForSelector(`${geminiEditor} [data-saved-tick]`, { timeout: 5000 });
      await reopenGemini();
      await page.waitForSelector(`${geminiEditor} [data-model-protocol-field="${protocol}"]`, { timeout: 5000 });
      const savedEffective = (await page.locator(`${geminiEditor} [data-effective-protocol]`).textContent())?.trim() ?? '';
      const expectedFormat = protocol === 'anthropic' ? 'Messages' : 'Google GenAI';
      if (!savedEffective.includes(expectedFormat)) {
        throw new Error(`expected stored protocol ${expectedFormat}, saw "${savedEffective}"`);
      }
      await scrollTo(`${geminiEditor} [data-model-protocol-field]`);
      await shot(name(`detail-saved-${protocol}`, theme, width));
    }
    await page.locator(`${geminiPanel} header button`).click();
    await page.locator(geminiEditor).waitFor({ state: 'detached' });

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
    await page.click('[data-connection-source-choice="manual"]');
    await page.waitForSelector('[data-provider-protocol="openai"]', { timeout: 5000 });
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
