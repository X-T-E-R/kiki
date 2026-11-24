/**
 * Visual-proof walker for the flagship Antigravity 1.5+ bridge (`antigravity-bridge`):
 *   1. Antigravity Setup — CLI runtime bar + update badge (`1.5.12 available`) + `code_paste` sign-in flow
 *   2. Antigravity Setup — signed-in profile with entitled Gemini/Claude/GPT models & Auto mode indicator
 *   3. Antigravity Setup — isolated multi-account instance (`instance-agy-work`)
 *   4. ProviderQuotaPanel — live 5h & weekly Antigravity meters + multi-account renewal hint
 */

export function createAntigravityBridgeWalker({ page, shot, webUrl, fixtureUrl, fixtureToken }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;

  return async function scenarioAntigravityBridge() {
    // 1. Open Antigravity engine detail pane in Settings › Connections (signed out + 4 auth modes)
    await page.goto(url('/settings/ai?tab=providers&engine=antigravity-acp'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-antigravity]', { timeout: 20_000 });
    await page.waitForSelector('[data-antigravity-update]', { timeout: 10_000 });
    await page.waitForSelector('[data-antigravity-signin]', { timeout: 10_000 });
    await page.locator('[data-antigravity]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(250);
    await shot('agy-setup-signed-out');

    // 2. Start Google sign-in (`code_paste` flow on agy 1.5+)
    await page.locator('[data-antigravity-signin]').click();
    await page.waitForSelector('[data-antigravity-login="pending"][data-antigravity-flow="code_paste"]', { timeout: 10_000 });
    await page.locator('[data-antigravity]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(250);
    await shot('agy-setup-code-paste');

    // 2. Complete sign-in with raw authorization code (zero broken localhost redirect)
    await page.locator('[data-antigravity-redirect]').fill('4/0A-fixture-code-1511');
    await page.locator('[data-antigravity-complete]').click();
    await page.waitForSelector('[data-antigravity-signed-in]', { timeout: 10_000 });
    await page.waitForSelector('[data-antigravity-models]', { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('[data-engine-check-button][aria-busy="true"]'), null, { timeout: 10_000 });
    await page.locator('[data-antigravity]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(250);
    await shot('agy-setup-signed-in');

    // 3. Switch to multi-account instance (`instance-agy-work`) in the left detail rail
    await page.locator('[data-detail-rail-item="instance-agy-work"]').click();
    await page.waitForSelector('[data-antigravity-instance="instance-agy-work"] [data-antigravity-signed-in]', { timeout: 10_000 });
    await page.locator('[data-antigravity]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(250);
    await shot('agy-setup-instance-work');

    // 4. Open ProviderQuotaPanel — live 5h & weekly Antigravity meters + renewal hint
    await page.goto(url('/usage?panel=quota'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-provider-quota-panel]', { timeout: 20_000 });
    await page.waitForSelector('[data-quota-engine="antigravity-acp"]', { timeout: 10_000 });
    await page.waitForSelector('[data-quota-engine="instance-agy-work"]', { timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot('agy-quota-panel');
  };
}
