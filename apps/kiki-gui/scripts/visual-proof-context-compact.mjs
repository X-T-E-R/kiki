/**
 * Visual-proof walker for the automatic-compaction point (fixture
 * `context-compact`): the context panel's track in every state, the
 * commit-on-release rule, typed input with clamping, the save-as-default
 * menu (model / profile / global, built-in profile greyed), the fallback on
 * an older engine, then the model editor and the profile editor. Both themes;
 * 1440 and 390.
 */

export function createContextCompactWalker({ page, shot, selectSession, resizeViewport, setProofTheme, view, webUrl, fixtureUrl, fixtureToken, control }) {
  const openDetails = async () => {
    await page.waitForSelector('[data-context-meter]', { timeout: 10_000 });
    if (await page.locator('[data-context-details]').count() === 0) await page.click('[data-context-meter]');
    await page.waitForSelector('[data-context-details]', { timeout: 5000 });
  };
  const closeDetails = async () => {
    if (await page.locator('[data-context-details]').count() > 0) await page.click('[data-context-meter]');
  };
  const expectSource = async (source) => {
    await page.waitForFunction(
      (expected) => document.querySelector('[data-context-compact-section]')?.getAttribute('data-compact-source') === expected,
      source,
      { timeout: 5000 },
    );
  };
  const settingsUrl = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;

  async function sessionStates(theme) {
    await selectSession('Fixture: window 550k');
    await openDetails();
    await expectSource('legacy');
    const text = await page.locator('[data-context-details]').innerText();
    if (!/467\.5k/.test(text)) throw new Error(`legacy default 467.5k missing from the panel: ${text}`);
    await shot(`context-compact-room-${theme}`);

    // Dragging updates the copy live but writes nothing until release.
    const slider = page.locator('[data-compact-slider]');
    const box = await slider.boundingBox();
    if (box === null) throw new Error('compaction slider not rendered');
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2, { steps: 6 });
    const during = await page.locator('[data-compact-status]').innerText();
    await shot(`context-compact-dragging-${theme}`);
    // Held thumb: the source label still reads the server's legacy default.
    const heldSource = await page.locator('[data-context-compact-section]').getAttribute('data-compact-source');
    if (heldSource !== 'legacy') throw new Error(`drag committed before release (source ${heldSource})`);
    await page.mouse.up();
    await expectSource('session');
    console.log(`[check] drag copy while held: ${during.split('\n')[0]}`);

    // Typed input clamps to limit − reserve and says so.
    await page.fill('[data-compact-input]', '99%');
    await page.press('[data-compact-input]', 'Enter');
    await page.waitForFunction(() => /500k/.test(document.querySelector('[data-compact-note]')?.textContent ?? ''), null, { timeout: 5000 });
    await shot(`context-compact-clamped-${theme}`);
    await page.fill('[data-compact-input]', '400k');
    await page.press('[data-compact-input]', 'Enter');
    await page.waitForFunction(() => document.querySelector('[data-compact-source-trigger]')?.textContent?.includes('400k'), null, { timeout: 5000 });
    await shot(`context-compact-session-${theme}`);

    // Save-as-default menu: model / editable profile / global (converted %).
    await page.click('[data-compact-source-trigger]');
    await page.waitForSelector('[data-compact-source-menu]', { timeout: 5000 });
    await shot(`context-compact-menu-${theme}`);
    await page.click('[data-compact-save="model"]');
    await expectSource('model');
    await shot(`context-compact-saved-model-${theme}`);
    await closeDetails();

    // Past the point: amber copy, overflow segment, built-in profile greyed.
    await selectSession('Fixture: past point');
    await openDetails();
    await expectSource('session');
    if (await page.locator('[data-compact-overflow]').count() !== 1) throw new Error('overflow segment missing past the point');
    await shot(`context-compact-past-${theme}`);
    // 420k differs from the model default saved above (400k), so a global save
    // cannot take over: the model layer still wins and the card says so.
    await page.fill('[data-compact-input]', '420k');
    await page.press('[data-compact-input]', 'Enter');
    await page.waitForFunction(() => document.querySelector('[data-compact-source-trigger]')?.textContent?.includes('420k'), null, { timeout: 5000 });
    await page.click('[data-compact-source-trigger]');
    await page.waitForSelector('[data-compact-source-menu]', { timeout: 5000 });
    if (!(await page.locator('[data-compact-save="profile"]').isDisabled())) throw new Error('built-in profile save must be disabled');
    await page.click('[data-compact-save="global"]');
    await page.waitForFunction(() => /76\.4%/.test(document.querySelector('[data-compact-note]')?.textContent ?? ''), null, { timeout: 5000 });
    await expectSource('session');
    await shot(`context-compact-global-shadowed-${theme}`);
    await closeDetails();

    await selectSession('Fixture: usable < window');
    await openDetails();
    const limit = await page.locator('[data-compact-limit]').innerText();
    if (!/300k/.test(limit) || !/550k/.test(limit)) throw new Error(`usable/window label wrong: ${limit}`);
    await shot(`context-compact-budget-${theme}`);
    await closeDetails();

    await selectSession('Fixture: tiny window');
    await openDetails();
    if (await page.locator('[data-compact-slider]').count() !== 0) throw new Error('tiny window must lock the slider');
    await shot(`context-compact-tiny-${theme}`);
    await closeDetails();

    await selectSession('Fixture: older engine');
    await openDetails();
    if (await page.locator('[data-context-compact-section]').count() !== 0) throw new Error('older engine must keep the plain meter');
    await shot(`context-compact-legacy-${theme}`);
    await closeDetails();
  }

  async function mobile(theme) {
    await resizeViewport(390);
    // No sidebar at this width: open the session by route.
    await page.goto(settingsUrl('/s/session_fixture_compact_past'), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await openDetails();
    await shot(`context-compact-past-390-${theme}`);
    await closeDetails();
    await resizeViewport(1440);
  }

  async function settings(theme) {
    await page.goto(settingsUrl('/settings/ai?tab=models'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#st-card-models', { timeout: 15_000 });
    await page.locator('[data-model-row="fixture/opus-5-5"] button[aria-expanded]').click();
    await page.waitForSelector('[data-model-context-fields]', { timeout: 10_000 });
    await page.locator('[data-model-context-fields]').scrollIntoViewIfNeeded();
    await shot(`context-compact-model-editor-${theme}`);
    await page.goto(settingsUrl('/settings/ai?tab=defaults'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#st-card-auto-compact', { timeout: 15_000 });
    await page.locator('#st-card-auto-compact').scrollIntoViewIfNeeded();
    await shot(`context-compact-global-card-${theme}`);
    await page.goto(settingsUrl('/settings/agents'), { waitUntil: 'domcontentloaded' });
    // The profile editor keeps the compaction point under Advanced.
    await page.waitForSelector('[data-team-open="builder"]', { timeout: 15_000 });
    await page.locator('[data-team-open="builder"]').click();
    await page.locator('[data-profile-section="advanced"] > summary').click();
    await page.waitForSelector('[data-profile-auto-compact]', { timeout: 5000 });
    await page.locator('[data-profile-auto-compact]').evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await shot(`context-compact-profile-${theme}`);
    await resizeViewport(390);
    await page.waitForTimeout(300);
    await shot(`context-compact-profile-390-${theme}`);
    await resizeViewport(1440);
    await page.locator('[role="dialog"] [data-agent-back]').click();
  }

  return async function scenarioContextCompact() {
    // Theme and width come from the job (registry `matrix`); the desktop job
    // also carries the settings-side probes, the 390 job the phone pass.
    const { theme, width } = view;
    if (width !== 1440) {
      await mobile(theme);
      return;
    }
    await sessionStates(theme);
    await settings(theme);
  };
}
