/**
 * The agent rail's capability block, read as groups (fixture `tool-groups`).
 * One walk proves the whole read: a chip per built-in category, MCP server,
 * plugin and user-registered tool; `x/y` from the reported states (approval
 * counts as on, unknown never reads as off); the cluster's fold past the cap
 * and its one hover preview; a group opening its complete membership, keeping
 * the in-group filter and the focus across a single tool; the main search
 * finding a switched-off tool without moving a denominator; the extension tab
 * showing every member of a server; and the same panel inside the narrow
 * drawer with no second layer. Every job records the palette its tokens
 * resolve to, because a brightness flag alone does not repaint this build.
 *
 * Screenshots land in KIKI_PROOF_OUTPUT_DIR as `tg-<state>` plus the runner's
 * per-view suffix.
 */

export function createToolGroupsWalker({ page, shot, view, webUrl, fixtureUrl, fixtureToken, dark = false }) {
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const SID = 'session_fixture_tool_groups';
  // The fixtures' copy is asserted through the app's own dictionaries; these
  // few probes are the words this walk keys on.
  const C = view.locale === 'zh'
    ? { custom: '自定义工具', on: '开启', off: '未开启', unknown: '状态未确认', pending: '待确认', gone: '已不在', noMatch: '没有匹配的工具或分组', showing: '显示', hits: '命中', group: '组' }
    : { custom: 'Custom tools', on: 'on', off: 'Off', unknown: 'State unconfirmed', pending: 'awaiting approval', gone: 'no longer in the current tool list', noMatch: 'No matching tools or groups', showing: 'Showing', hits: 'matched', group: 'group' };

  const rail = () => page.locator('[data-session-rail]');
  const section = () => rail().locator('[data-rail-capabilities]');
  const chip = (key) => rail().locator(`[data-capability-group-chip="${key}"]`);
  const chips = () => rail().locator('[data-capability-group-chip]');

  /**
   * Clicking a group adds a panel under the chips, so a chip further down the
   * cluster can be below the fold. Bring it into view first, or the click lands
   * on whatever the column happens to show there.
   */
  async function openChip(key) {
    const target = chip(key);
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    await target.click();
  }

  /**
   * The palette this build actually paints. The stored brightness flag reaches
   * the DOM in some boots and not others (the applied skin owns the palette),
   * so every job records what the tokens resolve to instead of assuming the
   * job's theme dimension repainted anything.
   */
  async function logPalette() {
    const palette = await page.evaluate(() => [
      document.documentElement.dataset['theme'],
      getComputedStyle(document.documentElement).getPropertyValue('--color-panel').trim(),
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
    ].join('|'));
    console.log(`[tg] ${view.locale}/${view.theme}/${view.width} ${palette}`);
  }

  async function openRail() {
    if (await rail().count() > 0) return;
    await page.locator('[data-rail-toggle]').first().click();
    await rail().waitFor({ timeout: 10_000 });
  }

  /** The 能力 block starts folded; open it and settle on the tools tab. */
  async function openCapabilities() {
    await section().scrollIntoViewIfNeeded();
    if (await section().locator('[data-capability-tab-button]').count() === 0) {
      await section().locator('button').first().click();
    }
    await section().locator('[data-capability-tab-button="tools"]').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(200);
  }

  async function openTab(id) {
    await section().locator(`[data-capability-tab-button="${id}"]`).click();
    await page.waitForTimeout(200);
  }

  async function expectCount(locator, expected, label) {
    const seen = await locator.count();
    if (seen !== expected) throw new Error(`${label}: expected ${expected}, saw ${seen}`);
  }

  async function expectText(locator, needle, label) {
    const seen = (await locator.innerText()).replace(/\s+/g, ' ');
    if (!seen.includes(needle)) throw new Error(`${label}: expected "${needle}" in "${seen}"`);
  }

  /** Nothing in this surface may spill past its own column. */
  async function expectNoOverflow(label) {
    const boxes = await page.evaluate(() => {
      const scroller = document.querySelector('[data-session-rail]');
      if (!scroller) return null;
      return { scroll: scroller.scrollWidth, client: scroller.clientWidth };
    });
    if (boxes !== null && boxes.scroll > boxes.client + 1) {
      throw new Error(`${label}: overflows its column (${boxes.scroll} > ${boxes.client})`);
    }
  }

  async function main() {
    await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea, [data-transcript-scroll]', { timeout: 20_000 });
    await logPalette();
    // Below lg the session page has no rail and no rail control at all (the
    // accepted behaviour this slice must not reopen); the narrow pass records
    // that and nothing opens a second drawer over it.
    if (view.width < 1024) {
      await expectCount(page.locator('[data-rail-toggle]'), 0, 'narrow rail toggle');
      await expectCount(page.locator('[data-capability-group-chip]:visible'), 0, 'narrow visible chips');
      await shot('tg-narrow-page');
      return;
    }
    await openRail();
    await openCapabilities();

    // One chip per group: 17 built-in/source groups plus the user's own read as
    // its own group. Eighteen is well under the cap, so nothing folds.
    await expectCount(chips(), 18, 'tools tab chips');
    await expectCount(rail().locator('[data-capability-groups-more]'), 0, 'fold control');
    // The compression is real: no per-tool rows survive on the tools tab.
    await expectCount(rail().locator('[data-capability-list="tools"] [data-capability-item]'), 0, 'tools tab rows');
    await expectCount(rail().locator('[data-capability-list="tools"]'), 0, 'tools tab list');

    // Counts come from the reported states, not from what is switched on.
    const osChip = chip('builtin:os/backends');
    if (await osChip.getAttribute('data-capability-group-count') !== '5/6') {
      throw new Error(`os/backends must read 5/6 (approval counts as on), saw ${await osChip.getAttribute('data-capability-group-count')}`);
    }
    // An unconfirmed state is never dressed as off: the chip says `?/3`, and
    // the machine count keeps the underlying numbers.
    await expectText(chip('builtin:memory'), '?/3', 'unconfirmed group');
    if (await chip('builtin:memory').getAttribute('data-capability-group-unknown-count') !== '3') {
      throw new Error('an unconfirmed group must report its unknown count');
    }
    if (await chip('builtin:browser').getAttribute('data-capability-group-disconnected') !== '') {
      throw new Error('a group with an unconnected member must say so');
    }
    // A waiting invocation stays visible in the preview and the panel, not as
    // a second state word on the chip (the chip's `x/y` already counts it).

    await expectText(chip('user:custom'), C.custom, 'user tools group');
    await shot('tg-cluster');

    // Hover: one floating preview anchored to the chip. It is a layer, so the
    // page below must not move: the cluster keeps its height and the tab strip
    // keeps its position.
    const geometryBefore = await page.evaluate(() => {
      const list = document.querySelector('[data-capability-group-list]');
      const tabs = document.querySelector('[data-capability-tab-button="tools"]');
      return { list: list?.getBoundingClientRect().height ?? 0, tabs: tabs?.getBoundingClientRect().top ?? 0 };
    });
    await chip('builtin:os/backends').hover();
    const preview = page.locator('[data-capability-group-preview="builtin:os/backends"]');
    await preview.waitFor({ timeout: 5_000 });
    await expectText(preview, '5/6', 'preview counts');
    await expectText(preview, C.pending, 'preview pending note');
    await expectText(preview, 'Write', 'preview off names');
    if (await page.locator('[role="dialog"]').count() !== 0) throw new Error('hover must not open an overlay');
    const geometryAfter = await page.evaluate(() => {
      const list = document.querySelector('[data-capability-group-list]');
      const tabs = document.querySelector('[data-capability-tab-button="tools"]');
      return { list: list?.getBoundingClientRect().height ?? 0, tabs: tabs?.getBoundingClientRect().top ?? 0 };
    });
    if (Math.abs(geometryAfter.list - geometryBefore.list) > 0.5) {
      throw new Error(`hover changed the cluster height: ${geometryBefore.list} -> ${geometryAfter.list}`);
    }
    if (Math.abs(geometryAfter.tabs - geometryBefore.tabs) > 0.5) {
      throw new Error(`hover moved the tab strip: ${geometryBefore.tabs} -> ${geometryAfter.tabs}`);
    }
    // The card is wider than its chip, so it can sit over the chips beside it.
    // It must not take a click aimed at one of them.
    const covered = await page.evaluate(() => {
      const card = document.querySelector('[data-capability-group-preview]');
      if (!card) return null;
      const box = card.getBoundingClientRect();
      const others = Array.from(document.querySelectorAll('[data-capability-group-chip]'))
        .filter((node) => node.getAttribute('data-capability-group-chip') !== card.getAttribute('data-capability-group-preview'));
      return others
        .map((node) => ({ key: node.getAttribute('data-capability-group-chip'), r: node.getBoundingClientRect() }))
        .filter(({ r }) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top)
        .map(({ key, r }) => {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { key, hit: hit?.closest('[data-capability-group-chip]')?.getAttribute('data-capability-group-chip') ?? hit?.tagName ?? null };
        });
    });
    for (const entry of covered ?? []) {
      if (entry.hit !== entry.key) {
        throw new Error(`the preview covers chip ${entry.key}; a click there would hit ${entry.hit}`);
      }
    }
    await shot('tg-preview');

    // The whole group, including the tool that is off and the one waiting. A
    // click expands it in place under the chips: the cluster, the tabs and the
    // sections after them all stay exactly where they were.
    const chipsBefore = await chips().count();
    await osChip.click();
    const detail = rail().locator('[data-tool-group-detail="builtin:os/backends"]');
    await detail.waitFor({ timeout: 5_000 });
    await expectCount(detail.locator('[data-tool-group-item]'), 6, 'group members');
    await expectText(detail.locator('[data-tool-group-section="off"]'), 'Write', 'off member');
    await expectText(detail.locator('[data-tool-group-section="on"]'), 'Bash', 'awaiting member');
    if (await page.locator('[data-capability-group-drawer]').count() !== 0) {
      throw new Error('a clicked group must not open the overlay shell');
    }
    // Only the rail is on screen: the conversation stays outside the panel.
    if (await rail().locator('[data-tool-group-detail]').count() !== 1) throw new Error('the group panel must live in the rail');
    // The expansion is additive: the chips are still there, above the panel.
    if (await chips().count() !== chipsBefore) throw new Error('expanding a group replaced the cluster');
    if (await rail().locator('[data-capability-tab-button="tools"]').count() !== 1) {
      throw new Error('expanding a group replaced the tab strip');
    }
    const panelBelowChips = await page.evaluate(() => {
      const list = document.querySelector('[data-capability-group-list]');
      const expanded = document.querySelector('[data-capability-group-expanded]');
      if (list === null || expanded === null) return false;
      return list.getBoundingClientRect().bottom <= expanded.getBoundingClientRect().top + 1;
    });
    if (!panelBelowChips) throw new Error('the expanded group must sit below the chips');
    await shot('tg-group');

    // In-group search, then one tool, then back: filter, scroll and focus hold.
    const inGroup = detail.locator('[data-tool-group-search]');
    await inGroup.fill('Write');
    await expectText(detail.locator('[data-tool-group-count]'), C.showing, 'in-group count');
    await expectCount(detail.locator('[data-tool-group-item]'), 1, 'filtered members');
    await detail.locator('[data-tool-group-item="Write"]').click();
    await rail().locator('[data-tool-detail]').waitFor({ timeout: 5_000 });
    await expectText(rail().locator('[data-tool-detail]'), 'Write', 'tool detail');
    await shot('tg-tool');
    await detail.locator('[data-tool-group-tool-back]').click();
    if (await inGroup.inputValue() !== 'Write') throw new Error('returning from a tool must keep the group filter');
    await expectCount(detail.locator('[data-tool-group-item]'), 1, 'restored members');
    await detail.locator('[data-tool-group-back]').click();
    await section().locator('[data-capability-tab-button="tools"]').waitFor({ timeout: 5_000 });
    if (await page.evaluate(() => document.activeElement?.getAttribute('data-capability-group-chip')) !== 'builtin:os/backends') {
      throw new Error('back must return focus to the chip it came from');
    }

    // The main search reads group names and tool names, off tools included,
    // and never moves the denominator.
    const filter = section().locator('[data-capability-filter="tools"]');
    await filter.fill('Write');
    // Three groups hold a tool whose name contains "Write", two of them off or
    // unconfirmed: the search reads every state, not only what is on.
    await expectCount(rail().locator('[data-capability-group-chip][data-capability-group-hits]'), 3, 'groups with hits');
    if (await chip('builtin:os/backends').getAttribute('data-capability-group-hits') !== '1') {
      throw new Error('the hit count must name how many members matched');
    }
    if (await chip('builtin:os/backends').getAttribute('data-capability-group-count') !== '5/6') {
      throw new Error('the group count must not follow the search');
    }
    await expectCount(rail().locator('[data-capability-tab-button="tools"]'), 1, 'tabs still visible while searching');
    await shot('tg-search');
    // A query that names the group itself matches its whole membership, and
    // the count still stays the group's.
    await filter.fill('memory');
    await expectCount(rail().locator('[data-capability-group-chip][data-capability-group-hits="3"]'), 1, 'group-name hit');
    if (await chip('builtin:memory').getAttribute('data-capability-group-count') !== '0/3') {
      throw new Error('a group-name hit must keep the group denominator');
    }
    await shot('tg-search-group');
    await filter.fill('zzzz');
    await expectText(rail().locator('[data-capability-group-nomatch]'), C.noMatch, 'no-match copy');
    await shot('tg-search-empty');
    await rail().locator('[data-capability-search-clear]').click();
    await expectCount(chips(), 18, 'chips after clearing');

    // Extensions: one chip per provider, every member listed, two providers
    // sharing a tool short name kept apart.
    await openTab('extensions');
    // Seven servers (one of them with no reported owner), two plugins.
    await expectCount(chips(), 9, 'extension groups');
    await expectCount(rail().locator('[data-capability-groups-more]'), 0, 'extension fold');
    await openChip('mcp:github');
    const github = rail().locator('[data-tool-group-detail="mcp:github"]');
    await github.waitFor({ timeout: 5_000 });
    await expectCount(github.locator('[data-tool-group-item]'), 3, 'github members');
    await expectText(github, 'search_issues', 'short name');
    await github.locator('[data-tool-group-back]').click();
    await openChip('mcp:gitlab');
    await rail().locator('[data-tool-group-detail="mcp:gitlab"]').waitFor({ timeout: 5_000 });
    await expectText(rail().locator('[data-tool-group-detail="mcp:gitlab"]'), 'search_issues', 'same short name, other provider');
    await rail().locator('[data-tool-group-back]').click();
    await openChip('mcp:modelcontextprotocol-filesystem-server-prod');
    const longName = rail().locator('[data-tool-group-detail="mcp:modelcontextprotocol-filesystem-server-prod"]');
    await longName.waitFor({ timeout: 5_000 });
    await expectCount(longName.locator('[data-tool-group-item]'), 2, 'long-named server members');
    await shot('tg-extensions');
    await rail().locator('[data-tool-group-back]').click();
    // A server whose owner was never reported gets its own explicit group.
    if (await chip('mcp:unknown').count() !== 1) throw new Error('an unreported MCP owner needs its own group');

  }

  /** The rail at its own minimum width: the tightest real column this panel lives in. */
  async function narrowRail() {
    await page.evaluate(() => {
      const layout = JSON.parse(localStorage.getItem('kiki.layout') ?? '{}');
      localStorage.setItem('kiki.layout', JSON.stringify({ ...layout, railWidth: 240 }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea, [data-transcript-scroll]', { timeout: 20_000 });
    await openRail();
    await openCapabilities();
    const railWidth = await rail().evaluate((node) => node.getBoundingClientRect().width);
    if (railWidth > 260) throw new Error(`the rail did not take the stored minimum width: ${railWidth}`);
    const overflow = await rail().evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    if (overflow.scroll > overflow.client + 1) {
      throw new Error(`the capability clusters overflow the narrow rail: ${overflow.scroll} > ${overflow.client}`);
    }
    // Every tab stays inside the column: a clipped control reads as a defect.
    const railBox = await rail().boundingBox();
    const tabEdges = await rail().locator('[data-capability-tab-button]').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().right));
    if (railBox === null || tabEdges.some((right) => right > railBox.x + railBox.width + 1)) {
      throw new Error(`a capability tab is clipped at the rail's minimum width: ${JSON.stringify(tabEdges)}`);
    }
    await shot('tg-rail-min');
    await chip('builtin:os/backends').click();
    await rail().locator('[data-tool-group-detail="builtin:os/backends"]').waitFor({ timeout: 5_000 });
    const panelOverflow = await rail().evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    if (panelOverflow.scroll > panelOverflow.client + 1) {
      throw new Error(`the group panel overflows the narrow rail: ${panelOverflow.scroll} > ${panelOverflow.client}`);
    }
    // The reader's own scroll offset comes back exactly, group and tool alike.
    const host = rail();
    await host.evaluate((node) => { node.scrollTop = Math.min(120, Math.max(0, node.scrollHeight - node.clientHeight)); });
    const before = await host.evaluate((node) => node.scrollTop);
    await rail().locator('[data-tool-group-item="Write"]').click();
    await rail().locator('[data-tool-detail]').waitFor({ timeout: 5_000 });
    await rail().locator('[data-tool-group-tool-back]').click();
    await page.waitForTimeout(120);
    const afterTool = await host.evaluate((node) => node.scrollTop);
    if (afterTool !== before) throw new Error(`returning from a tool moved the rail scroll: ${before} -> ${afterTool}`);
    await shot('tg-rail-min-group');
    await rail().locator('[data-tool-group-back]').click();
    await page.waitForTimeout(120);
    const afterGroup = await host.evaluate((node) => node.scrollTop);
    if (afterGroup !== before) throw new Error(`returning from a group moved the rail scroll: ${before} -> ${afterGroup}`);
    await expectCount(chips(), 18, 'narrow-rail chips');
  }

  /**
   * One real Inkstone pass: the active home's own preference is the authority
   * the app reads, so the palette must change without touching the DOM here.
   */
  async function darkPass() {
    await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea, [data-transcript-scroll]', { timeout: 20_000 });
    await page.waitForTimeout(400);
    const palette = await page.evaluate(() => [
      document.documentElement.dataset['theme'],
      getComputedStyle(document.documentElement).getPropertyValue('--color-panel').trim(),
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
    ].join('|'));
    console.log(`[tg-dark] ${view.locale}/${view.width} ${palette}`);
    if (!palette.startsWith('dark|')) throw new Error(`the home's dark preference did not reach the page: ${palette}`);
    if (palette.includes('#FFFDFA')) throw new Error(`the palette is still Paper light: ${palette}`);
    await openRail();
    await openCapabilities();
    await expectCount(chips(), 18, 'dark chips');
    await chip('builtin:os/backends').hover();
    // The card is portaled to the body, so it is not inside the rail column.
    await page.locator('[data-capability-group-preview="builtin:os/backends"]').waitFor({ timeout: 5_000 });
    await shot('tg-dark-preview');
    await chip('builtin:os/backends').click();
    await rail().locator('[data-tool-group-detail="builtin:os/backends"]').waitFor({ timeout: 5_000 });
    await expectCount(rail().locator('[data-tool-group-item]'), 6, 'dark group members');
    await shot('tg-dark-group');
  }

  /**
   * The skills tab of the same rail: chips folded on real wrapped rows, the
   * cut named honestly, and one skill opening its own SKILL.md in the sheet
   * instead of a link out of it.
   */
  async function skillsPass() {
    await openRail();
    await openCapabilities();
    await openTab('skills');
    const clusters = rail().locator('[data-capability-skill-cluster]');
    await clusters.first().waitFor({ timeout: 5_000 });
    // The fold is rows, not a chip count: the cut is four chip rows tall, and
    // the list itself is taller than that whenever it folds.
    const folded = await rail().locator('[data-capability-skill-folded]').count();
    if (folded === 0) throw new Error('the skills list should fold in the rail column');
    const cut = await rail().locator('[data-capability-skill-folded]').first()
      .evaluate((node) => ({ cut: node.getBoundingClientRect().height, rows: getComputedStyle(node).getPropertyValue('max-height') }));
    if (!cut.rows || Number.parseFloat(cut.rows) < 64) {
      throw new Error(`the skills cut should be about four rows tall, saw ${cut.rows}`);
    }
    // Every chip stays reachable: the cut is a reading limit, not a filter.
    if (await rail().locator('[data-capability-item]').count() < 8) {
      throw new Error('the skills tab lost chips under the fold');
    }
    await shot('tg-skills-folded');
    const more = rail().locator('[data-capability-more]');
    await more.first().waitFor({ timeout: 5_000 });
    const label = (await more.first().innerText()).replace(/\s+/g, ' ');
    if (!/\d/.test(label)) throw new Error(`the fold must name how many chips it hides, saw "${label}"`);
    // Each scope folds on its own rows, so opening one is opening that scope.
    // The scope is named up front: opening swaps which control exists, so a
    // positional `.first()` would land on the other scope the second time.
    const scope = (await more.first().evaluate((node) =>
      node.closest('[data-capability-group]')?.getAttribute('data-capability-group'))) ?? null;
    if (scope === null) throw new Error('the fold control must belong to a skills scope');
    const group = rail().locator(`[data-capability-group="${scope}"]`);
    const before = await rail().locator('[data-capability-skill-folded]').count();
    await more.first().click();
    await page.waitForTimeout(250);
    if (await group.locator('[data-capability-skill-folded]').count() !== 0) {
      throw new Error('the fold must open on its toggle');
    }
    // The other scopes keep their own cut: a short list is not dragged open by
    // a long one beside it.
    if (await rail().locator('[data-capability-skill-folded]').count() >= before) {
      throw new Error('opening one scope must not change the others');
    }
    await shot('tg-skills-open');
    // The same scope's own control says "Show fewer" and puts the cut back.
    const less = group.locator('[data-capability-more="less"]');
    await less.waitFor({ timeout: 5_000 });
    await less.click();
    await page.waitForTimeout(250);
    if (await group.locator('[data-capability-skill-folded]').count() !== 1) {
      throw new Error('the fold must return on the way back');
    }

    // One skill opens its own SKILL.md in the sheet: the content is here, not
    // behind a link into another surface. The workspace skill the fixture
    // seeds a real file for is the one that must render its Markdown.
    await rail().locator('[data-capability-item="release-notes"]').first().click();
    const sheet = page.locator('[data-skill-md]');
    await sheet.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const content = sheet.locator('[data-skill-md-content]');
    await content.waitFor({ timeout: 10_000 });
    await expectText(content, 'Release notes', 'SKILL.md heading');
    await expectText(content, 'When to use this', 'SKILL.md body');
    if (await sheet.locator('[data-skill-md-retry]').count() !== 0) {
      throw new Error('a readable SKILL.md must not show a failure');
    }
    // Copy and the full file stay one click away, without leaving the sheet.
    if (await sheet.locator('[data-skill-md-copy]').count() !== 1) throw new Error('the sheet must offer a copy');
    if (await sheet.locator('[data-skill-md-open]').count() !== 1) throw new Error('the sheet must offer the original file');
    await expectNoOverflow(`skills sheet ${view.locale}/${view.width}`);
    await shot('tg-skill-detail');

    // A skill whose file is not there answers for itself instead of leaving a
    // blank panel where the instructions should be. The global scope's chips
    // sit below the fold, so the one to open is named and scrolled to.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const unreadable = rail().locator('[data-capability-item="absorb-anything"]').first();
    await unreadable.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await unreadable.click();
    const missing = page.locator('[data-skill-md]');
    await missing.waitFor({ timeout: 10_000 });
    await missing.locator('[data-skill-md-retry]').waitFor({ timeout: 10_000 });
    await expectText(missing.locator('[data-skill-md-retry]'), view.locale === 'zh' ? '重试' : 'Retry', 'retry copy');
    if (await missing.locator('[data-skill-md-content]').count() !== 0) {
      throw new Error('an unreadable SKILL.md must not render content');
    }
    // The file is still one click away even when the read failed.
    if (await missing.locator('[data-skill-md-open]').count() !== 1) {
      throw new Error('an unreadable SKILL.md must still offer the original file');
    }
    await shot('tg-skill-unreadable');
  }

  /** A real agent-context switch must not carry the previous agent's view. */
  async function agentSwitch() {
    await openCapabilities();
    await chip('builtin:os/backends').click();
    await rail().locator('[data-tool-group-detail="builtin:os/backends"]').waitFor({ timeout: 5_000 });
    await page.goto(link(`/s/${SID}/agent/agent-probe`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea, [data-transcript-scroll]', { timeout: 20_000 });
    await openRail();
    await openCapabilities();
    await expectCount(rail().locator('[data-tool-group-detail]'), 0, 'group view on the next agent');
    await expectCount(chips(), 18, 'chips on the next agent');
    if (await rail().locator('[data-capability-filter="tools"]').inputValue() !== '') {
      throw new Error("the previous agent's search carried over");
    }
  }

  return async function walk() {
    if (dark) {
      await darkPass();
      return;
    }
    await main();
    await skillsPass();
    // The desktop passes carry the rail's minimum width; the narrow viewport
    // keeps its single own frame.
    if (view.width === 1440) {
      await narrowRail();
      await agentSwitch();
    }
  };
}
