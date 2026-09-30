/**
 * Visual-proof walker for the Capabilities page and the settings Skills /
 * MCP / Plugins leaves (fixture `capabilities`). Every state at 1440 and 390,
 * light and dark: marketplace home, a shelf, plugin detail (Advanced folded
 * and open), install consent (permissions + prerequisite binary, a
 * permission-free pack, a preview failure), the Installed list (origins, an
 * update, an off plugin), MCP list with an error expanded and the add form,
 * skills (and 80 of them, via `capabilities-many`), tools, the sandboxed
 * writing panel (a real round-trip through the bridge), and the three
 * settings leaves (defaults plus a link here).
 *
 * Screenshots land in KIKI_PROOF_OUTPUT_DIR; names are
 * `cap-<state>-<theme>-<width>`.
 */

export function createCapabilitiesWalker({ page, shot, setProofTheme, webUrl, fixtureUrl, fixtureToken, control, view }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const go = async (path, selector) => {
    await page.goto(url(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { timeout: 15_000 });
    await page.waitForTimeout(350);
  };
  const size = async (width) => { await page.setViewportSize({ width, height: width < 600 ? 844 : 900 }); await page.waitForTimeout(200); };
  const expectNoOverflow = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`${label}: horizontal overflow ${overflow}px`);
  };
  const reset = async () => { await control({ action: 'scenario', name: 'capabilities' }); };

  async function pass(theme, width) {
    const tag = `${theme}-${width}`;
    await size(width);
    await reset();

    // Market: categories, cards, menu, Advanced, one category.
    await go('/capabilities', '[data-plugins-view="market"] [data-catalog-row]');
    if (await page.locator('[data-installed-strip]').count() !== 0) throw new Error('the market must not carry an installed strip');
    const officeIcon = await page.locator('[data-catalog-row="kiki-office"] [data-capability-icon]').first().getAttribute('data-capability-icon');
    if (officeIcon !== 'image') throw new Error(`official catalog icon must render as an image, saw ${officeIcon}`);
    await expectNoOverflow(`market ${tag}`);
    await shot(`cap-market-${tag}`);
    await page.locator('#plugins-shelf-coding').scrollIntoViewIfNeeded();
    await shot(`cap-market-shelves-${tag}`);
    await page.locator('[data-catalog-more="kiki-office"]').click();
    await page.waitForSelector('[data-plugin-card-menu]', { timeout: 5000 });
    await shot(`cap-market-menu-${tag}`);
    await page.keyboard.press('Escape');
    await page.locator('[data-plugins-advanced] > button').click();
    await page.waitForSelector('[data-plugins-advanced][data-open="true"] [data-catalog-source]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await page.locator('[data-plugins-advanced]').scrollIntoViewIfNeeded();
    await shot(`cap-market-advanced-${tag}`);
    await page.locator('[data-plugins-shelf-more="coding"]').click();
    await page.waitForSelector('[data-plugins-view="shelf"]', { timeout: 5000 });
    await shot(`cap-market-shelf-${tag}`);

    // Installed: one list, origin labels, an update, an off plugin, a broken one.
    await go('/capabilities?view=installed', '[data-plugins-view="installed"] [data-plugin-row]');
    for (const [id, origin] of [['kiki-writing', 'official'], ['research', 'catalog'], ['sketchbook', 'local'], ['broken-tools', 'local']]) {
      const seen = await page.locator(`[data-plugin-row="${id}"]`).getAttribute('data-plugin-origin');
      if (seen !== origin) throw new Error(`${id} must read as ${origin}, saw ${seen}`);
    }
    if (await page.locator('[data-plugin-row="sketchbook"]').getAttribute('data-plugin-enabled') !== 'false') throw new Error('sketchbook must render off');
    if (width >= 480) await page.waitForSelector('[data-plugin-update="research"]', { timeout: 5000 });
    await expectNoOverflow(`installed ${tag}`);
    await shot(`cap-installed-${tag}`);
    await page.locator('[data-plugin-more="research"]').click();
    await page.waitForSelector('[data-plugin-card-menu] [data-menu-item="update"]', { timeout: 5000 });
    await shot(`cap-installed-menu-${tag}`);
    await page.keyboard.press('Escape');
    await page.locator('[data-plugins-view="installed"] input[type="search"]').fill('D:/work');
    await page.waitForFunction(() => document.querySelectorAll('[data-plugin-row]').length === 1);
    await shot(`cap-installed-search-${tag}`);

    // Detail of an installed official plugin: panels, skins, Advanced.
    await go('/capabilities?plugin=kiki-writing', '[data-plugin-detail="kiki-writing"] [data-plugin-contribution]');
    await page.waitForSelector('[data-plugin-contribution="themes"]', { timeout: 10_000 });
    await shot(`cap-detail-${tag}`);
    await page.locator('[data-plugin-advanced] > button').click();
    await page.waitForSelector('[data-plugin-advanced][data-open="true"]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await page.locator('[data-plugin-advanced]').scrollIntoViewIfNeeded();
    await shot(`cap-detail-advanced-${tag}`);

    // Pinned GitHub plugin with a rollback copy and an update.
    await go('/capabilities?plugin=research', '[data-plugin-detail="research"]');
    await page.locator('[data-plugin-advanced] > button').click();
    await page.waitForTimeout(250);
    await page.locator('[data-plugin-advanced]').scrollIntoViewIfNeeded();
    await shot(`cap-detail-pinned-${tag}`);

    // Broken plugin: diagnostics surface without opening anything.
    await go('/capabilities?plugin=broken-tools', '[data-plugin-broken]');
    await shot(`cap-detail-broken-${tag}`);

    // Install consent: permissions; OfficeCLI is offered right after install.
    await go('/capabilities?plugin=kiki-office', '[data-plugin-install="kiki-office"]');
    await shot(`cap-detail-uninstalled-${tag}`);
    await page.locator('[data-plugin-install="kiki-office"]').click();
    await page.waitForSelector('[data-install-permissions]', { timeout: 10_000 });
    await shot(`cap-install-consent-${tag}`);
    await page.locator('[data-install-advanced] > button').click();
    await page.waitForTimeout(250);
    await shot(`cap-install-consent-advanced-${tag}`);
    await page.locator('[data-install-confirm]').click();
    await page.waitForSelector('[data-install-done]', { timeout: 10_000 });
    await shot(`cap-install-done-${tag}`);
    await page.locator('[data-install-prerequisite-action="officecli"]').click();
    await page.waitForSelector('[data-install-prerequisite="officecli"] [role="status"]', { timeout: 5000 });
    await shot(`cap-install-prereq-${tag}`);
    await page.keyboard.press('Escape');

    // Permission-free pack and a failing preview.
    await go('/capabilities?plugin=community-theme-pack', '[data-plugin-install="community-theme-pack"]');
    await page.locator('[data-plugin-install="community-theme-pack"]').click();
    await page.waitForSelector('[data-install-no-permissions]', { timeout: 10_000 });
    await shot(`cap-install-light-${tag}`);
    await page.keyboard.press('Escape');
    await go('/capabilities?plugin=sql-lens', '[data-plugin-install="sql-lens"]');
    await page.locator('[data-plugin-install="sql-lens"]').click();
    await page.waitForSelector('[data-install-error]', { timeout: 10_000 });
    await shot(`cap-install-error-${tag}`);
    await page.keyboard.press('Escape');

    // Installed management and add-from-source.
    await go('/capabilities?view=installed', '[data-plugins-view="installed"] [data-plugin-row]');
    await page.locator('[data-capabilities-add]').click();
    await page.locator('[data-capabilities-add-item="plugin"]').click();
    await page.waitForSelector('[data-add-source]', { timeout: 5000 });
    await shot(`cap-add-source-${tag}`);
    await page.keyboard.press('Escape');

    // Plugin panel through the sandbox bridge.
    await go('/capabilities?plugin=kiki-writing', '[data-plugin-open-panel="manuscript"]');
    await page.evaluate(() => localStorage.setItem('kiki.lastSessionId', 'session_fixture_capabilities'));
    await page.locator('[data-plugin-open-panel="manuscript"]').click();
    const frame = page.frameLocator('iframe[data-plugin-panel="kiki-writing:manuscript"]');
    await frame.locator('#status').filter({ hasText: 'Ready to send' }).waitFor({ timeout: 10_000 });
    const sandbox = await page.locator('iframe[data-plugin-panel]').getAttribute('sandbox');
    if (sandbox !== 'allow-scripts') throw new Error(`panel sandbox must be exactly allow-scripts, got ${sandbox}`);
    await frame.locator('#draft').fill('The lighthouse keeper counted the ships again.');
    await frame.locator('#send').click();
    await frame.locator('#status').filter({ hasText: 'Sent to session.' }).waitFor({ timeout: 10_000 });
    await shot(`cap-panel-${tag}`);
    await page.keyboard.press('Escape');

    // Skills, MCP, Tools tabs.
    await go('/capabilities?tab=skills', '[data-skills-view] [data-skill-row]');
    await shot(`cap-skills-${tag}`);
    await go('/capabilities?tab=mcp', '[data-mcp-server="fixture-web"]');
    await shot(`cap-mcp-${tag}`);
    await page.locator('[data-mcp-server="fixture-web"] button[aria-expanded]').click();
    await page.waitForSelector('[data-mcp-error="fixture-web"]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`cap-mcp-error-${tag}`);
    await page.locator('[data-mcp-add]').click();
    await page.waitForSelector('[data-mcp-editor]', { timeout: 5000 });
    await shot(`cap-mcp-add-${tag}`);
    await go('/capabilities?tab=tools', '[data-tools-view] [data-tool-row]');
    await shot(`cap-tools-${tag}`);

    // Settings leaves: server defaults only, each linking to this page.
    await go('/settings/plugins', '#st-card-plugins [data-capability-link="plugins"]');
    await page.waitForSelector('[data-capability-link="plugins"] [data-capability-icon]', { timeout: 10_000 });
    await shot(`cap-settings-plugins-${tag}`);
    await go('/settings/mcp', '#st-card-mcp [data-capability-link="mcp"]');
    await shot(`cap-settings-mcp-${tag}`);
    await go('/settings/skills', '#st-card-skill-catalog [data-capability-link="skills"]');
    await shot(`cap-settings-skills-${tag}`);
    await expectNoOverflow(`settings skills ${tag}`);
    await page.locator('[data-capability-link-open="skills"]').click();
    await page.waitForSelector('[data-capabilities-page="skills"] [data-skill-row]', { timeout: 10_000 });

    // Skills at scale (fixture `capabilities-many`, 80 skills).
    await control({ action: 'scenario', name: 'capabilities-many' });
    // A concurrent HMR full reload can blank the stylesheet mid-walk; retry the
    // whole block (its UI state does not survive a reload) instead of keeping a bad shot.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await skillsAtScale(tag);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        console.log(`[capabilities] ${error.message}; retrying skills-many (${attempt})`);
        await page.waitForTimeout(1500);
      }
    }
  }

  // Tokens come from src/styles; Tailwind sizes the icons. Both must be live.
  async function ensureStyled(label) {
    const styled = await page.evaluate(() => {
      const token = getComputedStyle(document.documentElement).getPropertyValue('--kiki-motion-quick').trim();
      // Unstyled pages render inline SVG icons at their intrinsic, oversized box.
      const icons = [...document.querySelectorAll('svg')].slice(0, 40);
      const iconOk = icons.length > 0 && icons.every((svg) => svg.getBoundingClientRect().width <= 64);
      return token !== '' && iconOk;
    });
    if (!styled) throw new Error(`stylesheet not applied at ${label}`);
  }

  async function styledShot(name) {
    await ensureStyled(name);
    await shot(name);
    await ensureStyled(`${name} (after capture)`);
  }

  async function skillsAtScale(tag) {
    await go('/capabilities?tab=skills', '[data-skills-group="project"] [data-skill-row]');
    const projectRows = await page.locator('[data-skills-group="project"] [data-skill-row]').count();
    if (projectRows !== 8) throw new Error(`project group must preview 8 of 28 skills, saw ${projectRows}`);
    if (await page.locator('[data-skills-group="builtin"]').getAttribute('data-open') !== 'false') throw new Error('built-in skills must start folded');
    await expectNoOverflow(`skills many ${tag}`);
    await styledShot(`cap-skills-many-${tag}`);
    await page.locator('[data-skills-show-all="project"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-skills-group="project"] [data-skill-row]').length === 28);
    await page.locator('[data-skills-fold="plugin"]').click();
    await page.locator('[data-skills-fold="builtin"]').click();
    await page.locator('[data-skills-group="project"]').scrollIntoViewIfNeeded();
    await styledShot(`cap-skills-many-expanded-${tag}`);
    await page.locator('[data-skills-view] input[type="search"]').fill('incident');
    await page.waitForSelector('[data-skills-result-count]', { timeout: 5000 });
    await page.evaluate(() => { document.querySelector('[data-skills-view]')?.scrollIntoView(); });
    await styledShot(`cap-skills-many-search-${tag}`);
  }

  return async function walk() {
    // Theme and width come from the job (registry `matrix`): one (theme,
    // width) pass per context instead of a loop over all four.
    await pass(view.theme, view.width);
  };
}
