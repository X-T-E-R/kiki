/**
 * Visual-proof walker for the Agents team view and profile editor (fixture
 * `profile-editor`): the team table, the editor sheet on its frequent
 * fields, subagents with lease pins and model candidates, Advanced open, the
 * raw file, diagnostics (missing alias, a shadowed file), the new-profile
 * starts, and an external-engine profile. Both themes; 1440 and 390.
 */

export function createProfileEditorWalker({ page, shot, resizeViewport, setProofTheme, webUrl, fixtureUrl, fixtureToken, control }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const sheet = () => page.locator('[role="dialog"]');
  const assertNoOverflow = async (label) => {
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      const doc = document.documentElement.scrollWidth > window.innerWidth + 1;
      return doc || (panel instanceof HTMLElement && panel.scrollWidth > panel.clientWidth + 1);
    });
    if (overflow) throw new Error(`${label} overflows horizontally`);
  };
  const openTeam = async () => {
    await page.goto(url('/settings/agents'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-team-row="lead"]', { timeout: 15_000 });
    await page.waitForTimeout(400);
  };
  const openProfile = async (selector) => {
    await page.locator(selector).first().click();
    await page.waitForSelector('[data-profile-editor]', { timeout: 5000 });
    await page.waitForTimeout(300);
  };
  const closeSheet = async () => {
    await sheet().locator('[data-agent-back]').first().click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 });
  };
  const scrollTo = async (selector) => {
    await sheet().locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(200);
  };
  // Teams: one card per main agent with its dispatchable roster.
  const showTeams = async () => {
    await page.locator('[data-team-layout="teams"]').click();
    await page.waitForSelector('[data-roster-team="lead"] [data-roster-member="implementer"]', { timeout: 5000 });
    if (await page.locator('[data-roster-team="lead"] [data-roster-member="think"]').count() !== 1) throw new Error('lead team is missing a leased member');
    await page.waitForTimeout(200);
  };
  // Unsaved state: edit two frequent fields; the draft footer must announce them.
  const makeDirty = async () => {
    await sheet().locator('#profile-description').fill('Workspace lead: frames, delegates, reviews, accepts.');
    await sheet().locator('#profile-when').fill('Open a new session for multi-step engineering or review work.');
    await sheet().locator('[data-settings-draft][data-dirty="true"]').waitFor({ timeout: 3000 });
    await page.waitForTimeout(250);
  };
  const discardDraft = async () => {
    await sheet().locator('[data-settings-draft] button').filter({ hasText: /Discard|放弃/ }).first().click();
    await sheet().locator('[data-settings-draft][data-dirty="true"]').waitFor({ state: 'detached', timeout: 3000 });
  };

  async function desktop(theme) {
    await resizeViewport(1440);
    await openTeam();
    if (await page.locator('[data-team-row="reviewer"] [data-team-warning]').count() !== 1) throw new Error('missing-alias row is not flagged');
    if (await page.locator('[data-team-source="extra"] [data-team-model] button').count() !== 0) throw new Error('shadowed file must not quick-edit');
    await page.locator('#st-card-main-agents').scrollIntoViewIfNeeded();
    const dispatch = page.locator('[data-team-row="lead"] [data-team-dispatch]');
    if ((await dispatch.locator('[data-team-dispatch-more]').textContent())?.startsWith('+3') !== true) throw new Error('long dispatch list must collapse to +N');
    const escapes = await page.evaluate(() => {
      const card = document.querySelector('#st-card-main-agents')?.getBoundingClientRect();
      return [...document.querySelectorAll('[data-team-dispatch] > span')].some((cell) => card !== undefined && cell.getBoundingClientRect().right > card.right + 0.5);
    });
    if (escapes) throw new Error('May call cell overflows the card');
    const groupOrder = await page.locator('[data-team-group]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-team-group')));
    if (groupOrder.join(',') !== 'workspace,global,builtin') throw new Error(`unexpected group order ${groupOrder.join(',')}`);
    await shot(`profile-team-${theme}`);
    await showTeams();
    await shot(`profile-teams-${theme}`);
    await page.locator('[data-team-layout="list"]').click();

    // Frequent fields: prompt pane + identity/model rail.
    await openProfile('[data-team-open="lead"]');
    await shot(`profile-editor-frequent-${theme}`);
    await makeDirty();
    await shot(`profile-editor-unsaved-${theme}`);
    await discardDraft();
    await sheet().locator('#profile-effort').click();
    await page.waitForSelector('[role="option"]', { timeout: 3000 });
    await shot(`profile-editor-effort-open-${theme}`);
    await page.keyboard.press('Escape');
    await scrollTo('[data-profile-section="subagents"]');
    await shot(`profile-editor-subagents-${theme}`);
    await closeSheet();

    await openProfile('[data-team-open="implementer"]');
    if (await sheet().locator('[data-profile-diagnostic="shadows"] [data-shadowed-file]').count() !== 2) throw new Error('shadowed files not listed');
    await shot(`profile-diag-shadows-${theme}`);
    await scrollTo('[data-profile-section="model-profiles"]');
    await shot(`profile-editor-model-profiles-${theme}`);
    await sheet().locator('[data-profile-section="advanced"] > summary').click();
    if (await sheet().locator('[data-alias-chips="spawn-allowed-models"] [data-alias-chip]').count() !== 2) throw new Error('spawn constraints not loaded');
    await scrollTo('[data-profile-section="advanced"]');
    await shot(`profile-editor-advanced-${theme}`);
    await scrollTo('[data-profile-field="spawnConstraints"]');
    await shot(`profile-editor-spawn-${theme}`);
    await sheet().locator('[data-profile-mode="raw"]').click();
    await sheet().locator('[data-profile-raw] textarea').waitFor({ timeout: 5000 });
    await shot(`profile-editor-raw-${theme}`);
    await closeSheet();

    // Diagnostics: an alias the catalog lacks, then a file that does not run.
    await openProfile('[data-team-open="reviewer"]');
    if (await sheet().locator('[data-profile-diagnostic="aliasMissing"]').count() === 0) throw new Error('alias diagnostic missing');
    await shot(`profile-diag-alias-${theme}`);
    await closeSheet();
    await openProfile('[data-team-source="extra"] [data-team-open]');
    if (await sheet().locator('[data-profile-diagnostic="shadowedBy"]').count() === 0) throw new Error('shadow diagnostic missing');
    await shot(`profile-diag-shadowed-${theme}`);
    await closeSheet();
    await openProfile('[data-team-row="general"] [data-team-open]');
    await shot(`profile-diag-builtin-modified-${theme}`);
    await closeSheet();

    // External engine + main expression; the engine picker reads GET /executors.
    await openProfile('[data-team-open="implementer-grok"]');
    await sheet().locator('#profile-engine').click();
    await page.waitForSelector('[role="option"]:has-text("Claude Code")', { timeout: 3000 });
    await shot(`profile-engine-catalog-${theme}`);
    await page.keyboard.press('Escape');
    await sheet().locator('[data-profile-section="tools"] > summary').click();
    await shot(`profile-external-engine-${theme}`);
    await scrollTo('[data-profile-section="tools"]');
    if (await sheet().locator('[data-profile-field="tools"][data-field-applicability="ignored"]').count() !== 1) throw new Error('ignored tools not marked');
    await shot(`profile-external-ignored-${theme}`);
    await closeSheet();
    await openProfile('[data-team-open="agent"]');
    await scrollTo('[data-profile-field="main"]');
    await shot(`profile-main-builtin-${theme}`);
    await closeSheet();

    // New profile: copy (default), template, blank with a taken name.
    await page.locator('[data-profile-new]').click();
    await page.waitForSelector('[data-agent-create]', { timeout: 5000 });
    await shot(`profile-new-copy-${theme}`);
    await sheet().locator('[data-new-start="blank"]').click();
    await sheet().locator('#new-profile-name').fill('reviewer');
    await page.waitForTimeout(200);
    await shot(`profile-new-blank-taken-${theme}`);
    await sheet().locator('#new-profile-name').fill('');
    await closeSheet();
  }

  async function mobile(theme) {
    await resizeViewport(390);
    await openTeam();
    await assertNoOverflow('team view at 390');
    await shot(`profile-team-390-${theme}`);
    await showTeams();
    await assertNoOverflow('teams at 390');
    await shot(`profile-teams-390-${theme}`);
    await page.locator('[data-team-layout="list"]').click();
    await openProfile('[data-team-open="lead"]');
    await assertNoOverflow('editor at 390');
    await shot(`profile-editor-390-${theme}`);
    await scrollTo('[data-profile-rail]');
    await shot(`profile-editor-rail-390-${theme}`);
    await makeDirty();
    await shot(`profile-editor-unsaved-390-${theme}`);
    await discardDraft();
    await scrollTo('[data-profile-section="subagents"]');
    await shot(`profile-editor-subagents-390-${theme}`);
    await sheet().locator('[data-profile-section="advanced"] > summary').click();
    await scrollTo('[data-profile-section="advanced"]');
    await assertNoOverflow('advanced at 390');
    await shot(`profile-editor-advanced-390-${theme}`);
    await closeSheet();
    await openProfile('[data-team-open="reviewer"]');
    await shot(`profile-diag-alias-390-${theme}`);
    await closeSheet();
    await page.locator('[data-profile-new]').click();
    await page.waitForSelector('[data-agent-create]', { timeout: 5000 });
    await assertNoOverflow('new profile at 390');
    await shot(`profile-new-390-${theme}`);
    await closeSheet();
    await resizeViewport(1440);
  }

  return async function scenarioProfileEditor() {
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await control({ action: 'scenario', name: 'profile-editor' });
      await setProofTheme(theme);
      await desktop(theme);
      await mobile(theme);
    }
    await setProofTheme('light');
  };
}
