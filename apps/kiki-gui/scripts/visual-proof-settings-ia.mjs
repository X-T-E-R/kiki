/**
 * Visual-proof walker for the settings information architecture (IA v2):
 * the navigation as one continuous list of groups, every page owned by the
 * IA slice, the unsaved indicator in the page intro, the Experimental rows on
 * each feature page, the Labs index, search with breadcrumbs, and legacy
 * deep-link redirects. Against the local fixture server no page may say
 * where changes are saved or print a host. Both themes; 1440 and 390. Shots
 * are named `ia-<page>-<theme>-<width>`.
 */

const PAGES = ['general', 'connection', 'sessions', 'permissions', 'tasks', 'hooks', 'workspaces', 'developer', 'labs', 'about'];

/** Feature pages and the experimental flags whose rows they must show. */
const EXPERIMENTAL_PAGES = [
  ['agents', ['agent-profile-routes']],
  ['subagents', ['subagent_release_idle']],
  ['mcp', ['tool-select', 'external_delegation_mcp']],
  ['tasks', ['task_wait', 'task_board']],
];

/** Old section URLs and card hashes that other code or bookmarks still use. */
const REDIRECTS = [
  ['/settings/automation', 'permissions', null],
  ['/settings/communication#st-card-notify-parent', 'sessions', 'st-card-agent-messaging'],
  ['/settings/advanced', 'developer', null],
  ['/settings/experimental#st-card-tool-experiments', 'labs', 'st-card-labs'],
  ['/settings/labs#st-card-mcp-delegation', 'mcp', 'st-card-exp-mcp'],
  ['/settings/agents#st-card-subagent-release-idle', 'subagents', 'st-card-exp-subagents'],
  ['/settings/ai?tab=defaults#st-card-reviewer', 'permissions', 'st-card-reviewer'],
  ['/settings/tasks#st-card-defaults', 'sessions', 'st-card-defaults'],
];

const HOST_PORT = /\b(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|:\d{4,5}\b/;
/** Scope wording that must not come back while the server is the local one. */
const SCOPE_WORDS = /This device|All sessions|Applies to all your sessions|Only affects this app|Saved on the (?:remote )?server/;

export function createSettingsIaWalker({ page, shot, resizeViewport, setProofTheme, view, webUrl, fixtureUrl, fixtureToken }) {
  const url = (path) => {
    const [base, hash] = path.split('#');
    const sep = base.includes('?') ? '&' : '?';
    return `${webUrl}${base}${sep}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}${hash === undefined ? '' : `#${hash}`}`;
  };
  const open = async (path) => {
    await page.goto(url(path), { waitUntil: 'domcontentloaded' });
    // Not every page has an intro any more; the breadcrumb title always renders.
    await page.waitForSelector('[data-settings-page-title]', { timeout: 15_000 });
    await page.waitForTimeout(700);
  };

  async function pages(theme, width) {
    for (const section of PAGES) {
      await open(`/settings/${section}`);
      // The fixture is a loopback server: no remote line, no scope wording, no address.
      if (await page.locator('[data-settings-remote-line]').count() > 0) throw new Error(`${section}: remote line on a local server`);
      const pane = await page.locator('[data-settings-scroll]').innerText();
      const head = pane.split('\n').slice(0, 4).join(' ');
      if (HOST_PORT.test(head) || SCOPE_WORDS.test(head)) throw new Error(`${section}: page head says where it saves: ${head}`);
      const overflow = await page.evaluate(() => {
        const pane = document.querySelector('[data-settings-scroll]');
        return pane === null ? 0 : pane.scrollWidth - pane.clientWidth;
      });
      if (overflow > 1) throw new Error(`${section} overflows horizontally by ${overflow}px at ${width}`);
      await shot(`ia-${section}-${theme}-${width}`);
    }
  }

  async function nav(theme) {
    await open('/settings/permissions');
    if (await page.locator('nav [data-settings-nav-storage]').count() > 0) throw new Error('nav still draws scope blocks');
    const groups = await page.locator('nav [data-settings-nav-tree] > *').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-settings-nav-group')));
    if (groups.join(',') !== 'device,connection,models-agents,work,capabilities,workspace,advanced') throw new Error(`nav groups: ${groups.join(',')}`);
    const navText = await page.locator('nav').first().innerText();
    if (HOST_PORT.test(navText) || SCOPE_WORDS.test(navText)) throw new Error(`nav shows scope or host: ${navText.slice(0, 160)}`);
    await shot(`ia-nav-${theme}-1440`);
  }

  async function experimental(theme, width) {
    for (const [section, flags] of EXPERIMENTAL_PAGES) {
      await open(`/settings/${section}`);
      const block = page.locator(`#st-card-exp-${section}`);
      await block.waitFor({ timeout: 10_000 });
      const rows = await block.locator('[data-experimental-row]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-experimental-row')));
      if (rows.join(',') !== flags.join(',')) throw new Error(`${section} experimental rows: ${rows.join(',')}`);
      for (const flag of flags) {
        const row = block.locator(`[data-experimental-row="${flag}"]`);
        if (await row.locator('[data-experimental-tag]').count() !== 1) throw new Error(`${flag}: no tag`);
        if ((await row.locator('[data-experimental-effect]').innerText()).trim() === '') throw new Error(`${flag}: no timing`);
      }
      const overflow = await page.evaluate(() => {
        const pane = document.querySelector('[data-settings-scroll]');
        return pane === null ? 0 : pane.scrollWidth - pane.clientWidth;
      });
      if (overflow > 1) throw new Error(`${section} overflows horizontally by ${overflow}px at ${width}`);
      await block.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await shot(`ia-exp-${section}-${theme}-${width}`);
    }
  }

  async function labsIndex(theme) {
    await open('/settings/labs');
    const entries = await page.locator('[data-labs-entry]').count();
    if (entries < 8) throw new Error(`labs index lists ${entries} flags`);
    if (await page.locator('#st-card-labs [data-experimental-row]').count() > 0) throw new Error('labs still holds switches');
    // Follow one link: it must land on the flag's own row.
    await page.locator('[data-labs-entry="external_delegation_mcp"] a').click();
    await page.waitForURL(/\/settings\/mcp/, { timeout: 10_000 });
    await page.waitForSelector('#st-card-exp-mcp.settings-card-flash', { timeout: 5000 });
    await page.waitForTimeout(700);
    await shot(`ia-labs-landed-${theme}-1440`);
  }

  async function unsaved(theme, width) {
    // A typed number with its own Save: the page intro flags the draft.
    await open('/settings/tasks');
    const input = page.locator('#st-card-task-policy input').first();
    await input.fill('7');
    await page.waitForSelector('[data-settings-unsaved]', { timeout: 5000 });
    await shot(`ia-unsaved-${theme}-${width}`);
    await page.locator('#st-card-task-policy [data-settings-discard="task-policy"]').click();
    await page.waitForSelector('[data-settings-unsaved]', { state: 'detached', timeout: 5000 });
  }

  async function search(theme) {
    await open('/settings/general');
    const field = page.locator('nav [data-settings-search]');
    // A synonym of the card under test: "notify" now leads with the newer
    // System notifications leaf, and the point here is that Enter lands on the
    // hit's own card and flashes it.
    await field.fill('AgentNotify');
    await page.waitForSelector('nav [role="option"]', { timeout: 5000 });
    await shot(`ia-search-${theme}-1440`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#st-card-agent-messaging.settings-card-flash', { timeout: 5000 });
    if (!page.url().includes('/settings/sessions')) throw new Error(`search landed on ${page.url()}`);
    await shot(`ia-search-landed-${theme}-1440`);
  }

  async function redirects(theme) {
    for (const [from, section, card] of REDIRECTS) {
      await page.goto(url(from), { waitUntil: 'domcontentloaded' });
      await page.waitForURL(new RegExp(`/settings/${section}`), { timeout: 10_000 });
      if (card !== null) {
        await page.waitForSelector(`#${card}`, { timeout: 10_000 });
        if (!page.url().includes(`#${card}`)) throw new Error(`${from} kept hash ${page.url()}`);
      }
      console.log(`[check] ${from} → ${page.url().replace(webUrl, '').replace(/\?[^#]*/, '')}`);
    }
    await page.waitForTimeout(900);
    await shot(`ia-deeplink-reviewer-${theme}-1440`);
  }

  async function mobileNav(theme) {
    await open('/settings/sessions');
    await page.locator('[data-settings-nav-trigger]').click();
    await page.waitForSelector('[role="dialog"] [data-settings-nav-group="advanced"]', { timeout: 5000 });
    if (await page.locator('[role="dialog"] [data-settings-nav-storage]').count() > 0) throw new Error('drawer still draws scope blocks');
    await page.waitForTimeout(300);
    await shot(`ia-nav-drawer-${theme}-390`);
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"] button[aria-label]').first().click().catch(() => undefined);
  }

  return async function walk() {
    // Theme and width come from the job (registry `matrix`): the desktop and
    // the 390 pass are separate contexts, so this walk runs one of them.
    const { theme, width } = view;
    if (width === 1440) {
      await nav(theme);
      await pages(theme, 1440);
      await unsaved(theme, 1440);
      await search(theme);
      await redirects(theme);
      await experimental(theme, 1440);
      await labsIndex(theme);
      return;
    }
    await pages(theme, 390);
    await experimental(theme, 390);
    await unsaved(theme, 390);
    await mobileNav(theme);
  };
}
