/**
 * Visual-proof walker for an external harness as the main profile (fixture
 * `external-main`): the Claude Code session (tool cards, Kiki dispatch, plan
 * as Todo, usage, a failed turn), the Grok plan review, the Codex YOLO
 * session, the profile editor's Kiki-subagents switch, and the Antigravity
 * binary + sign-in flow in Settings › Connections. 1440 wide, both themes.
 */

export function createExternalMainWalker({ page, shot, view, webUrl, fixtureUrl, fixtureToken }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base) => `external-main-${base}-${view.theme}`;
  const openSession = async (sessionId) => {
    await page.goto(url(`/s/${sessionId}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-transcript-scroll]', { timeout: 20_000 });
    await page.waitForTimeout(700);
  };
  const openRail = async () => {
    if (await page.locator('[data-session-rail]').count() > 0) return;
    await page.locator('[data-rail-toggle]').first().click();
    await page.locator('[data-session-rail]').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
  };
  const optional = async (selector) => (await page.locator(selector).count()) > 0;

  async function sessions() {
    await openSession('session_fixture_external_claude');
    await shot(name('claude'));
    await openRail();
    await shot(name('claude-rail'));
    if (await optional('[data-harness-caps]')) {
      await page.locator('[data-harness-caps] button').first().click();
      await page.waitForTimeout(300);
      await shot(name('claude-caps'));
      await page.keyboard.press('Escape');
    }
    await page.locator('[data-session-actions] > button').first().click();
    await page.waitForTimeout(250);
    await shot(name('claude-menu'));
    await page.keyboard.press('Escape');

    await openSession('session_fixture_external_grok');
    await shot(name('grok-plan'));

    await openSession('session_fixture_external_codex');
    if (await optional('[data-codex-mcp-note]')) throw new Error('codex YOLO still shows the Kiki-tools refusal note');
    await shot(name('codex-yolo'));
    // Kiki's own tool ran under Full access; another MCP server's refusal reads by its code.
    await page.locator('[data-history-fold] button, [data-history-fold][role="button"]').first().click();
    const refused = page.locator('[data-tool-id$="tracker"]').first();
    await refused.waitFor({ timeout: 5000 });
    const refusedText = await refused.innerText();
    if (!/Codex/.test(refusedText) || /approval policy is never/.test(refusedText)) throw new Error(`coded MCP refusal is not translated: ${refusedText}`);
    await page.waitForTimeout(200);
    await shot(name('codex-mcp-refused'));
    // Codex reports fork:false — the session menu must not offer it.
    await page.locator('[data-session-actions] > button').first().click();
    await page.waitForTimeout(250);
    const menuText = await page.locator('[role="menu"]').first().innerText().catch(() => '');
    if (/分叉|Fork/.test(menuText)) throw new Error('codex session menu still offers fork');
    await shot(name('codex-menu'));
    await page.keyboard.press('Escape');
  }

  async function profile() {
    await page.goto(url('/settings/agents'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-team-open="lead-claude"]', { timeout: 15_000 });
    await page.locator('[data-team-open="lead-claude"]').first().click();
    await page.waitForSelector('[data-profile-editor]', { timeout: 5000 });
    await page.waitForTimeout(300);
    const field = (await optional('[data-profile-field="allowKikiSubagents"]')) ? '[data-profile-field="allowKikiSubagents"]' : '[data-profile-field="main"]';
    await page.locator(`[role="dialog"] ${field}`).first().evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(250);
    await shot(name('profile-claude'));
    await page.locator('[role="dialog"] [data-agent-back]').first().click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 });
    await page.locator('[data-team-open="lead-codex"]').first().click();
    await page.waitForSelector('[data-profile-editor]', { timeout: 5000 });
    await page.locator(`[role="dialog"] ${field}`).first().evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(250);
    await shot(name('profile-codex'));
  }

  async function antigravity() {
    await page.goto(url('/settings/ai?tab=providers'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-engine-row="antigravity-acp"]', { timeout: 20_000 });
    await page.locator('[data-engine-row="antigravity-acp"] > summary').click();
    await page.waitForTimeout(300);
    await page.locator('[data-engine-row="antigravity-acp"] [data-engine-check-button]').click();
    await page.waitForSelector('[data-engine-row="antigravity-acp"] [data-engine-diagnostics]', { timeout: 5000 });
    await page.locator('[data-engine-row="antigravity-acp"]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(250);
    await shot(name('antigravity'));
    if (!(await optional('[data-antigravity-install]'))) return;
    await page.locator('[data-antigravity-install]').click();
    await page.waitForSelector('[data-antigravity-progress="download"]', { timeout: 5000 });
    await page.waitForFunction(() => Number(document.querySelector('[data-antigravity-progress] [role="progressbar"]')?.getAttribute('aria-valuenow')) >= 50, null, { timeout: 5000 });
    await page.locator('[data-antigravity]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await shot(name('antigravity-progress'));
    await page.waitForSelector('[data-antigravity-version="1.2.1"]', { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.locator('[data-antigravity]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await shot(name('antigravity-installed'));
    await page.locator('[data-antigravity-signin]').click();
    await page.waitForSelector('[data-antigravity-login="pending"]', { timeout: 5000 });
    await page.locator('[data-antigravity-redirect]').fill('http://localhost:45289/oauth2callback?state=wrong');
    await page.locator('[data-antigravity-complete]').click();
    await page.waitForSelector('[data-antigravity-login-error]', { timeout: 5000 });
    await page.waitForTimeout(200);
    await shot(name('antigravity-retry'));
    await page.locator('[data-antigravity-redirect]').fill('http://localhost:45289/oauth2callback?state=agy-login-1&code=fixture-code');
    await page.locator('[data-antigravity-complete]').click();
    await page.waitForSelector('[data-antigravity-signed-in]', { timeout: 5000 });
    // Sign-in triggers a re-check; shoot the settled row, not the spinner.
    await page.waitForFunction(() => !document.querySelector('[data-engine-check-button][aria-busy="true"]'), null, { timeout: 10_000 });
    await page.waitForTimeout(250);
    await shot(name('antigravity-signed-in'));
    // A vendor rejection ends the flow; the translated line keeps the server's words in its tooltip.
    await page.locator('[data-antigravity-logout]').click();
    await page.waitForSelector('[data-antigravity-signin]', { timeout: 5000 });
    await page.locator('[data-antigravity-signin]').click();
    await page.waitForSelector('[data-antigravity-login="pending"]', { timeout: 5000 });
    await page.locator('[data-antigravity-redirect]').fill('http://localhost:45289/oauth2callback?state=agy-login-2&code=denied');
    await page.locator('[data-antigravity-complete]').click();
    await page.waitForSelector('[data-antigravity-login="idle"] [data-antigravity-login-error]', { timeout: 5000 });
    const title = await page.locator('[data-antigravity-login-error]').getAttribute('title');
    if (title !== 'Antigravity sign-in failed: invalid_grant') throw new Error(`sign-in rejection tooltip is ${title}`);
    await page.waitForTimeout(200);
    await shot(name('antigravity-rejected'));
  }

  return async function scenarioExternalMain() {
    await sessions();
    await profile();
    await antigravity();
  };
}
