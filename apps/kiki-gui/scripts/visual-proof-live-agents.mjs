/**
 * Visual-proof walkers for the Usage → Live agents session list
 * (fixtures `live-agents-compact` and `live-agents-attention`).
 *
 * The list is a projection of the live inventory, the cold session summaries
 * and the per-session execution reads, so the walk drives the real flow
 * through the fixture's klient dispatcher instead of shooting static screens:
 *
 *   compact   — five running sessions fold behind one disclosure line; names
 *               come from the cached session lists (long title, untitled, and
 *               a session whose one metadata read the proof withholds); the
 *               session cut of the breakdown uses the same names; a row's
 *               pause can be cancelled or confirmed, a held row stays in view
 *               while folded, resume returns it; pause-all covers the whole
 *               inventory even while the list is folded.
 *   attention — a failed live session and a session paused before a restart
 *               stay in view in the folded list with their explicit actions;
 *               retry-read never resumes; resume clears the held row.
 *
 * Each view checks the section height, that nothing widens the page at 390,
 * and that every action button is the hit target at its own centre.
 */

const LONG = 'session_7d3f2a91-5c4e-4b8a-9f61-2e0d8c7b6a54';
const UNTITLED = 'session_0b9e4c17-a2d8-4f53-8e6c-91d4b7a3f028';
const MISSING = 'session_c58a1e3b-7f02-4d69-b4e1-3a9f6d20e7c5';
const ZETA = 'session_fixture_usage_zeta';
const ETA = 'session_fixture_usage_eta';
const PAUSED = 'session_e2f47b09-6d1c-4a38-b5f2-7c0e9d81a463';
const LIVE = [ZETA, ETA, LONG, UNTITLED, MISSING];
const LONG_TITLE_START = 'Rebuild the usage export pipeline';
const FAILED_ERROR = 'Resume could not reattach the approval waiter';

function walkerKit({ page, shot, control, view, text, webUrl, fixtureUrl, fixtureToken }) {
  const url = () => `${webUrl}/usage?panel=realtime&server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const narrow = (page.viewportSize()?.width ?? 1440) < 768;
  const name = (base) => `live-agents-${base}`;
  const row = (id) => page.locator(`[data-execution-session="${id}"]`);
  const phaseOf = async (id) => (await control({ action: 'session', session_id: id })).data?.executionControl?.phase;
  const waitPhase = async (id, phase) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await phaseOf(id) === phase) return;
      await page.waitForTimeout(150);
    }
    throw new Error(`${id} never reached ${phase} on the fixture (now ${await phaseOf(id)})`);
  };
  // Withhold the one metadata read for MISSING, so its name has to fall back.
  const withholdMissing = async () => {
    await page.route((target) => target.pathname === `/api/sessions/${MISSING}`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 40401, message: 'session not found' }) })
        : route.continue());
  };
  const open = async () => {
    await page.goto(url(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-execution-sessions]', { timeout: 20_000 });
    await page.waitForTimeout(500);
  };
  const toggle = () => page.locator('[data-execution-sessions-toggle]');
  const setExpanded = async (expanded) => {
    if ((await toggle().getAttribute('aria-expanded')) !== String(expanded)) await toggle().click();
    await page.waitForTimeout(200);
  };
  const focusSection = async () => {
    await page.locator('[data-governance-live-agents]').evaluate((node) => { node.scrollIntoView({ block: 'start' }); });
    await page.waitForTimeout(250);
  };
  const metrics = async () => page.evaluate(() => {
    const section = document.querySelector('[data-governance-live-agents]')?.getBoundingClientRect();
    const list = document.querySelector('[data-execution-sessions]')?.getBoundingClientRect();
    return {
      sectionHeight: Math.round(section?.height ?? 0),
      listHeight: Math.round(list?.height ?? 0),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      listRight: Math.round(list?.right ?? 0),
      innerWidth: window.innerWidth,
    };
  });
  const assertLayout = async (label) => {
    const m = await metrics();
    console.log(`[check] ${label}: section ${m.sectionHeight}px, session list ${m.listHeight}px, overflow ${m.overflow}px`);
    expect(m.overflow <= 1, `${label}: page overflows by ${m.overflow}px`);
    expect(m.listRight <= m.innerWidth + 1, `${label}: session list bleeds past the viewport (${m.listRight} > ${m.innerWidth})`);
    return m;
  };
  /** Every visible action button sits inside the viewport and is the hit target at its centre. */
  const assertOperable = async (label) => {
    const problems = await page.evaluate(() => {
      const out = [];
      for (const button of document.querySelectorAll('[data-execution-sessions] [data-execution-action], [data-execution-sessions] [data-execution-session-open], [data-execution-sessions-toggle]')) {
        if (button.closest('[hidden]') !== null) continue;
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const id = button.closest('[data-execution-session]')?.getAttribute('data-execution-session') ?? 'toggle';
        if (rect.height < 24) out.push(`${id}: ${Math.round(rect.height)}px tall`);
        if (rect.right > window.innerWidth + 1 || rect.left < -1) out.push(`${id}: off-edge`);
        if (hit === null || (hit !== button && !button.contains(hit))) out.push(`${id}: covered`);
      }
      return out;
    });
    expect(problems.length === 0, `${label}: controls not operable: ${problems.join('; ')}`);
  };
  const visibleText = async () => page.locator('[data-governance-live-agents]').innerText();
  const assertNoBareIds = async (label, ids) => {
    const shown = await visibleText();
    const leaked = ids.filter((id) => shown.includes(id));
    expect(leaked.length === 0, `${label}: bare session ids in view: ${leaked.join(', ')}`);
  };
  const hidden = async (id) => row(id).evaluate((node) => node.hidden);
  const clickAction = async (id, action) => {
    await row(id).locator(`[data-execution-action="${action}"]`).click();
  };
  const dialog = () => page.locator('[role="alertdialog"]');
  return { expect, narrow, name, row, phaseOf, waitPhase, withholdMissing, open, toggle, setExpanded, focusSection, assertLayout, assertOperable, assertNoBareIds, hidden, clickAction, dialog, shot, page, text, view };
}

export function createLiveAgentsCompactWalker(options) {
  const kit = walkerKit(options);
  const { expect, page, text, shot, name, row } = kit;
  return async function walk() {
    await kit.withholdMissing();
    await kit.open();
    // Names settle once the cached lists and the withheld read have answered.
    await page.waitForFunction(([long, untitled, missing, untitledText, sessionText]) => {
      const label = (id) => document.querySelector(`[data-execution-session="${id}"] [data-execution-session-open]`)?.textContent ?? '';
      return label(long).startsWith('Rebuild') && label(untitled).startsWith(untitledText) && label(missing).startsWith(sessionText);
    }, [LONG, UNTITLED, MISSING, text('sidebar.untitled'), text('usage.governance.session')], { timeout: 15_000 });

    // 1. Folded by default: one disclosure line under the breakdown.
    const toggleText = await kit.toggle().innerText();
    expect(toggleText.includes(text('usage.execution.sessionsCount', { count: LIVE.length })), `toggle reads ${toggleText}`);
    expect(await kit.toggle().getAttribute('aria-expanded') === 'false', 'session list did not start folded');
    for (const id of LIVE) expect(await kit.hidden(id), `${id} is in view while the list is folded`);
    await kit.assertNoBareIds('folded', LIVE);
    const folded = await kit.assertLayout('folded');
    expect(folded.listHeight <= 44, `folded session list takes ${folded.listHeight}px`);
    await kit.assertOperable('folded');
    await kit.focusSection();
    await shot(name('folded'));

    // 2. The session cut of the breakdown carries the same names.
    await page.locator('[data-axis="governance-agent-dimension"] button', { hasText: text('usage.governance.session') }).first().click();
    await page.waitForSelector('[data-governance-agent-dimension="session"]', { timeout: 5000 });
    const cut = await page.locator('[data-governance-agent-dimension="session"]').innerText();
    expect(cut.includes('Fixture: usage aggregation rework'), `session cut lost the title: ${cut}`);
    expect(cut.includes(`${text('sidebar.untitled')} 0b9e4c17`), `session cut lost the untitled fallback: ${cut}`);
    expect(cut.includes(`${text('usage.governance.session')} c58a1e3b`), `session cut lost the unknown fallback: ${cut}`);
    await kit.assertNoBareIds('session cut', LIVE);
    await kit.assertLayout('session cut');
    await kit.focusSection();
    await shot(name('session-cut'));
    await page.locator('[data-axis="governance-agent-dimension"] button').first().click();
    await page.waitForTimeout(200);

    // 3. Unfolded: every session by name, long title truncated but whole on hover.
    await kit.setExpanded(true);
    for (const id of LIVE) expect(!(await kit.hidden(id)), `${id} stayed hidden after unfolding`);
    const longLabel = row(LONG).locator('[data-execution-session-open]');
    const longTitle = await longLabel.getAttribute('title');
    expect(longTitle?.includes(LONG_TITLE_START) && longTitle.includes(LONG), `long title tooltip is ${longTitle}`);
    const truncated = await longLabel.locator('span').first().evaluate((node) => node.scrollWidth > node.clientWidth);
    // Wide rows have room for the whole title; a phone row has to cut it.
    if (kit.narrow) expect(truncated, 'the long title is not truncated at a narrow width');
    await kit.assertNoBareIds('unfolded', LIVE);
    const unfolded = await kit.assertLayout('unfolded');
    console.log(`[check] unfolded adds ${unfolded.sectionHeight - folded.sectionHeight}px for ${LIVE.length} sessions`);
    await kit.assertOperable('unfolded');
    await kit.focusSection();
    await shot(name('unfolded'));

    // 4. A row's pause asks first; cancelling sends nothing.
    await kit.clickAction(LONG, 'pause');
    await kit.dialog().waitFor({ timeout: 5000 });
    await shot(name('pause-confirm'));
    await kit.dialog().locator('button', { hasText: text('common.cancel') }).click();
    await kit.dialog().waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForTimeout(400);
    expect(await kit.phaseOf(LONG) === 'running', 'a cancelled pause still reached the server');

    // 5. Confirmed pause settles to paused; folding keeps the held row in view.
    await kit.clickAction(LONG, 'pause');
    await kit.dialog().locator('[data-confirm-action="confirm"]').click();
    await page.locator(`[data-execution-paused="${LONG}"]`).waitFor({ timeout: 15_000 });
    await kit.waitPhase(LONG, 'paused');
    await kit.setExpanded(false);
    expect(!(await kit.hidden(LONG)), 'the paused row folded away');
    for (const id of LIVE.filter((id) => id !== LONG)) expect(await kit.hidden(id), `${id} stayed in view while folded`);
    expect((await row(LONG).innerText()).includes(text('usage.execution.pausedHint')), 'paused row lost its restart-safety hint');
    await kit.assertLayout('folded with a paused row');
    await kit.assertOperable('folded with a paused row');
    await kit.focusSection();
    await shot(name('folded-paused'));

    // 6. Resume from the folded row returns it to running and folds it away.
    await kit.clickAction(LONG, 'resume');
    await page.locator(`[data-execution-paused="${LONG}"]`).waitFor({ state: 'detached', timeout: 15_000 });
    await kit.waitPhase(LONG, 'running');
    await page.waitForFunction((id) => document.querySelector(`[data-execution-session="${id}"]`)?.hidden === true, LONG, { timeout: 5000 });

    // 7. Pause-all covers the full inventory even while folded.
    await page.locator('[data-execution-pause-all] button').click();
    await kit.dialog().locator('[data-confirm-action="confirm"]').click();
    for (const id of LIVE) await kit.waitPhase(id, 'paused');
    await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`[data-execution-session="${id}"]`)?.hidden === false), LIVE, { timeout: 15_000 });
    await kit.assertLayout('all paused');
    await kit.focusSection();
    await shot(name('all-paused'));
    for (const id of LIVE) {
      await page.locator(`[data-execution-paused="${id}"] [data-execution-action="resume"]`).waitFor({ timeout: 10_000 });
      await kit.clickAction(id, 'resume');
      await kit.waitPhase(id, 'running');
    }
  };
}

export function createLiveAgentsAttentionWalker(options) {
  const kit = walkerKit(options);
  const { expect, page, text, shot, name, row } = kit;
  return async function walk() {
    await kit.withholdMissing();
    await kit.open();
    await page.locator(`[data-execution-paused="${ETA}"]`).waitFor({ timeout: 15_000 });
    await page.locator(`[data-execution-paused="${PAUSED}"]`).waitFor({ timeout: 15_000 });

    // 1. Folded, yet the failed and the restart-held session stay in view.
    expect(await kit.toggle().getAttribute('aria-expanded') === 'false', 'session list did not start folded');
    expect(!(await kit.hidden(ETA)) && !(await kit.hidden(PAUSED)), 'a session that needs the user folded away');
    for (const id of [ZETA, LONG, UNTITLED, MISSING]) expect(await kit.hidden(id), `${id} stayed in view while folded`);
    const failedText = await row(ETA).innerText();
    expect(failedText.includes(FAILED_ERROR) && failedText.includes(text('usage.execution.retryRead')), `failed row reads ${failedText}`);
    const pausedText = await row(PAUSED).innerText();
    expect(pausedText.includes('Fixture: nightly eval sweep') && pausedText.includes(text('usage.execution.pausedHint')), `paused row reads ${pausedText}`);
    await kit.assertNoBareIds('attention folded', [...LIVE, PAUSED]);
    await kit.assertLayout('attention folded');
    await kit.assertOperable('attention folded');
    await kit.focusSection();
    await shot(name('attention-folded'));

    await kit.setExpanded(true);
    await kit.assertLayout('attention unfolded');
    await kit.assertOperable('attention unfolded');
    await kit.focusSection();
    await shot(name('attention-unfolded'));
    await kit.setExpanded(false);

    // 2. Retry-read re-reads and never resumes the failed session.
    await kit.clickAction(ETA, 'retry-read');
    await page.waitForTimeout(800);
    expect(await kit.phaseOf(ETA) === 'failed', 'retry-read changed the failed session on the server');
    expect(!(await kit.hidden(ETA)), 'failed row folded away after retry-read');

    // 3. Resume clears the held session from the list.
    await kit.clickAction(PAUSED, 'resume');
    await kit.waitPhase(PAUSED, 'running');
    await page.locator(`[data-execution-session="${PAUSED}"]`).waitFor({ state: 'detached', timeout: 15_000 });
    await kit.assertLayout('attention resumed');
    await kit.focusSection();
    await shot(name('attention-resumed'));
  };
}
