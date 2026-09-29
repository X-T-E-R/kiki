/**
 * Visual-proof walker for worktree isolation (fixture `worktrees`): the /new
 * opt-in (Git folder, plain folder), creating a worktree session and its
 * branch mark in the header and sidebar, Settings › Workspaces › Worktrees
 * (list, in-use disable, dirty removal warning, failed removal with the kept
 * path, cleanup), and the archive dialog's "also remove its worktree". Both
 * themes at 1440 and 390. Run with
 * KIKI_PROOF_OUTPUT_DIR=apps/kiki-gui/.tmp/worktree_gui to keep the shots
 * beside the other owners' proof output.
 */

export function createWorktreesWalker({ page, shot, resizeViewport, setProofTheme, control, webUrl, fixtureUrl, fixtureToken, locale }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base, theme, width) => `worktree-${base}-${theme}-${width}-${locale}`;
  // The worktree is shared: another owner's save can trigger a vite full
  // reload mid-step, so navigation retries once before failing.
  const open = async (path, selector) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await page.goto(url(path), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(selector, { timeout: 20_000 });
        break;
      } catch (error) {
        if (attempt >= 1) throw error;
      }
    }
    await page.waitForTimeout(500);
  };
  const expectCount = async (selector, count, label) => {
    const seen = await page.locator(selector).count();
    if (seen !== count) throw new Error(`${label}: expected ${count} × ${selector}, saw ${seen}`);
  };
  const noOverflow = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`${label} overflows horizontally by ${overflow}px`);
  };
  const reset = async () => {
    await control({ action: 'scenario', name: 'worktrees' });
  };
  const openSidebarIfDrawer = async (width) => {
    if (width >= 768) return;
    await page.click('button[aria-label]:has(svg[data-icon="menu"])');
    await page.waitForTimeout(400);
  };

  async function newSession(theme, width) {
    // Git workspace: switch offered, off by default, hint beside it.
    await open(`/new?workspace=wd_fixture_000000000000`, '[data-new-worktree="ready"]');
    if (await page.locator('[data-new-worktree-toggle]').isChecked()) throw new Error('worktree toggle must default to off');
    await expectCount('[data-new-worktree-hint]', 0, 'hint while off');
    await noOverflow('new (git)');
    await shot(name('new-off', theme, width));
    await page.locator('[data-new-worktree] label').click();
    if (!await page.locator('[data-new-worktree-toggle]').isChecked()) throw new Error('worktree toggle did not turn on');
    await expectCount('[data-new-worktree-hint]', 1, 'hint while on');
    await page.locator('[data-new-worktree-toggle]').focus();
    await shot(name('new-on', theme, width));
    // Plain folder: disabled with the reason.
    await open(`/new?workspace=wd_fixture_000000000001`, '[data-new-worktree="not-git"]');
    if (!await page.locator('[data-new-worktree-toggle]').isDisabled()) throw new Error('not-git toggle must be disabled');
    await shot(name('new-not-git', theme, width));
  }

  async function createFlow() {
    await reset();
    await open(`/new?workspace=wd_fixture_000000000000`, '[data-new-worktree="ready"]');
    await page.locator('[data-new-worktree] label').click();
    await page.fill('textarea[data-composer]', 'Draft the migration plan');
    await page.press('textarea[data-composer]', 'Control+Enter');
    await page.waitForURL(/\/s\/session_/, { timeout: 15_000 });
    await page.waitForSelector('header [data-worktree-mark]', { timeout: 15_000 });
  }

  async function session(theme, width) {
    await open('/s/session_fixture_wt_active', 'header [data-worktree-mark]');
    await expectCount('header [data-worktree-mark]', 1, 'session header');
    const title = await page.locator('header [data-worktree-mark]').getAttribute('title');
    if (title === null || !title.includes('C:/fixture/workshop') || !title.includes('HEAD')) throw new Error(`mark tooltip lacks source/base: ${title}`);
    await openSidebarIfDrawer(width);
    await expectCount('aside [data-session-row="session_fixture_plain"] [data-worktree-mark]', 0, 'plain row');
    await expectCount('aside [data-session-row="session_fixture_wt_active"] [data-worktree-mark]', 1, 'worktree row');
    await noOverflow('session');
    await shot(name('session', theme, width));
    // Ordinary session header carries nothing.
    await open('/s/session_fixture_plain', 'header [data-session-title]');
    await expectCount('header [data-worktree-mark]', 0, 'plain header');
  }

  async function settings(theme, width) {
    await open('/settings/workspaces', '[data-worktree-row]');
    await page.locator('#st-card-worktrees').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    if (!await page.locator('[data-worktree-row="wt_a1b2c3"] [data-worktree-remove]').isDisabled()) throw new Error('active worktree remove must be disabled');
    const describedBy = await page.locator('[data-worktree-row="wt_a1b2c3"] [data-worktree-remove]').getAttribute('aria-describedby');
    if (describedBy === null || await page.locator(`#${describedBy}`).count() !== 1) throw new Error('in-use remove lacks its description');
    await noOverflow('settings');
    await shot(name('settings-list', theme, width));

    // Dirty: inspect first, then the loss warning.
    await page.click('[data-worktree-row="wt_d4e5f6"] [data-worktree-remove]');
    await page.waitForSelector('[data-worktree-loss]', { timeout: 10_000 });
    await shot(name('remove-dirty', theme, width));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Clean: plain confirmation.
    await page.click('[data-worktree-row="wt_9a8b7c"] [data-worktree-remove]');
    await page.waitForSelector('[data-worktree-clean]', { timeout: 10_000 });
    await shot(name('remove-clean', theme, width));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Busy: removal fails and the kept checkout path is shown.
    await page.click('[data-worktree-row="wt_3c2d1e"] [data-worktree-remove]');
    await page.waitForSelector('[data-worktree-remove-confirm="clean"]:not([disabled])', { timeout: 10_000 });
    await page.click('[data-worktree-remove-confirm]');
    await page.waitForSelector('[data-worktree-notice="error"] [data-worktree-kept-path]', { timeout: 10_000 });
    await page.waitForSelector('[data-worktree-row="wt_3c2d1e"][data-worktree-state="remove_failed"]', { timeout: 10_000 });
    await page.locator('[data-worktree-row="wt_3c2d1e"]').scrollIntoViewIfNeeded();
    await shot(name('remove-failed', theme, width));

    // Cleanup: dry run, then the confirmation names what goes and what stays.
    await page.click('[data-worktrees-cleanup]');
    await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
    await shot(name('cleanup-confirm', theme, width));
    await page.keyboard.press('Escape');
  }

  async function removeFlows() {
    await reset();
    await open('/settings/workspaces', '[data-worktree-row]');
    // Dirty removal with an explicit discard.
    await page.click('[data-worktree-row="wt_d4e5f6"] [data-worktree-remove]');
    await page.waitForSelector('[data-worktree-remove-confirm="loss"]:not([disabled])', { timeout: 10_000 });
    await page.click('[data-worktree-remove-confirm]');
    await page.waitForSelector('[data-worktree-notice="success"]', { timeout: 10_000 });
    await expectCount('[data-worktree-row="wt_d4e5f6"]', 0, 'dirty removed');
    // Cleanup removes the due one; the failed one stays failed.
    await page.click('[data-worktrees-cleanup]');
    await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
    await page.locator('[role="alertdialog"] button').last().click();
    await page.waitForSelector('[data-worktree-notice="success"]', { timeout: 10_000 });
    await expectCount('[data-worktree-row="wt_9a8b7c"]', 0, 'due removed by cleanup');
  }

  async function archive(theme, width) {
    await reset();
    await open('/s/session_fixture_wt_active', 'header [data-worktree-mark]');
    await openSidebarIfDrawer(width);
    const row = page.locator('aside [data-session-row="session_fixture_wt_active"]');
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: locale === 'zh' ? '归档' : 'Archive', exact: true }).click();
    await page.waitForSelector('[data-archive-remove-worktree]', { timeout: 10_000 });
    if (await page.locator('[data-archive-remove-worktree] input').isChecked()) throw new Error('remove-worktree must default to off');
    await shot(name('archive', theme, width));
    await page.locator('[data-archive-remove-worktree]').click();
    await shot(name('archive-remove', theme, width));
    await page.click('[data-archive-confirm]');
    await page.waitForSelector('[data-archive-remove-worktree]', { state: 'detached', timeout: 10_000 });
  }

  return async function walk() {
    await createFlow();
    await removeFlows();
    for (const theme of ['light', 'dark']) {
      await setProofTheme(theme);
      for (const width of [1440, 390]) {
        await resizeViewport(width);
        await reset();
        await newSession(theme, width);
        await session(theme, width);
        await settings(theme, width);
        await archive(theme, width);
      }
    }
    await setProofTheme('light');
    await resizeViewport(1440);
  };
}
