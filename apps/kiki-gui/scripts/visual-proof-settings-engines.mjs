/**
 * Visual-proof walker for Settings › Models & providers › Connections: the
 * external engines list reading the backend's native-engine discovery
 * (fixture `settings-engines`). Codex installed, Claude Code missing its
 * claude CLI, AGY not installed, Grok's detection failing — one list, four
 * states — then a re-detect that finds AGY installed. Both themes; 1440 and
 * 390. Shots are named `settings-engines-<what>-<theme>-<width>`.
 */

export function createSettingsEnginesWalker({ page, shot, view, webUrl, fixtureUrl, fixtureToken }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base) => `settings-engines-${base}-${view.theme}-${view.width}`;

  const open = async () => {
    await page.goto(url('/settings/ai?tab=providers'), { waitUntil: 'domcontentloaded' });
    const card = page.locator('#st-card-engines');
    await card.locator('[data-engine-list]').waitFor({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
  };

  const states = async () =>
    page.locator('#st-card-engines [data-engine-row]').evaluateAll((rows) =>
      rows.map((row) => `${row.getAttribute('data-engine-row')}=${row.getAttribute('data-engine-discovery')}`));

  return async function walk() {
    await open();
    const seen = (await states()).join(',');
    for (const wanted of ['codex-app-server=installed', 'claude-acp=missing', 'agy-cli=missing', 'grok-acp=error']) {
      if (!seen.includes(wanted)) throw new Error(`engine states read ${seen}, missing ${wanted}`);
    }
    await shot(name('list'));

    // One engine open: the banner states the conclusion and each component
    // on its own line — the CLI missing, the ACP adapter installed — with a
    // next step, and the catalog's bare program/version facts stay out.
    await page.locator('#st-card-engines [data-engine-row="claude-acp"] [data-engine-open]').click();
    await page.locator('[data-engine-discovery-banner="missing"]').waitFor({ timeout: 5_000 });
    const banner = await page.locator('[data-engine-discovery-banner]').innerText();
    if (!banner.includes('Claude Code CLI') || !banner.includes('0.84.0')) throw new Error(`missing banner reads ${JSON.stringify(banner)}`);
    await shot(name('detail-missing'));
    // The close control is a header button on desktop and a back row on
    // narrow widths.
    const close = view.width < 768 ? '[data-engine-back]' : '[data-detail-close]';
    await page.locator(close).click();
    await page.waitForTimeout(300);

    // Detection failed: its own banner and the same re-detect next step.
    await page.locator('#st-card-engines [data-engine-row="grok-acp"] [data-engine-open]').click();
    await page.locator('[data-engine-discovery-banner="error"]').waitFor({ timeout: 5_000 });
    await shot(name('detail-failed'));
    await page.locator(close).click();
    await page.waitForTimeout(300);

    // Re-detect: the same read again; AGY now reports installed while the
    // other engines keep their states, and Settings stays usable throughout.
    await page.locator('[data-engine-redetect-button]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-engine-row="agy-cli"]')?.getAttribute('data-engine-discovery') === 'installed',
      undefined,
      { timeout: 10_000 },
    );
    const settled = (await states()).join(',');
    for (const wanted of ['codex-app-server=installed', 'claude-acp=missing', 'agy-cli=installed', 'grok-acp=error']) {
      if (!settled.includes(wanted)) throw new Error(`after re-detect the states read ${settled}, missing ${wanted}`);
    }
    await shot(name('redetected'));

    // An installed engine's banner states it plainly, with its path source.
    await page.locator('#st-card-engines [data-engine-row="agy-cli"] [data-engine-open]').click();
    await page.locator('[data-engine-discovery-banner="installed"]').waitFor({ timeout: 5_000 });
    await shot(name('detail-installed'));
    await page.locator(close).click();
    await page.waitForTimeout(300);
  };
}
