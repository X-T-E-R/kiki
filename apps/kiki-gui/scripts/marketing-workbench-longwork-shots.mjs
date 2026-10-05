/**
 * marketing-workbench-longwork-shots — the workbench / long-work /
 * features-index frame set (2026-10-05).
 *
 * A standalone SHOTS table, not a patch to `marketing-campaign.mjs`: that file
 * is owned work in flight, and this slice is three files of its own (a scene
 * seed module, fourteen thin scenario entry points, and this table).
 *
 * What this set is for. The 2026-10-04 pass shot nine frames across the whole
 * Features series. Reading those frames back showed two failure modes specific
 * to the workbench and long-work pages:
 *
 *   · the right rail stacked three empty states (no working notes, no injected
 *     rules in effect, no scheduled tasks) beside a live turn, so the window
 *     read as a product with nothing in it; and the EN queue frame carried the
 *     red "Could not read injected rules — Retry" line, an unseeded-route error
 *     in a public frame.
 *   · two whole claims on the long-work page had no frame at all: scheduled
 *     tasks and the task board, which the prose spends a section on.
 *
 * So this set keeps the composition that already worked (real GUI, real
 * interactions, one neutral project) and changes the seeds: every rail block
 * now carries real content, and the two missing surfaces get frames.
 *
 * The `run` functions import nothing from the campaign runner — every helper
 * they need is defined below, so this module can be registered by appending
 * `...WORKBENCH_LONGWORK_SHOTS` to the campaign SHOTS table without any import
 * edit. The campaign runner's `open`, `openGoal`, `openQueue` and `settle` are
 * module-local, hence the local copies; they are deliberately the same steps in
 * the same order, because "the same frame translated" is the property the
 * series depends on.
 *
 * Frames and where they land:
 *
 *   wl-hero-workbench        features/index.md, /, README (the lead screen)
 *   wl-workbench-fleet       workbench.md — per-role model bindings
 *   wl-workbench-subagent    workbench.md — a subagent's own record in the rail
 *   wl-workbench-tasks       workbench.md — background tasks, running/finished/failed
 *   wl-longwork-goal-queue   long-work.md — goal + the two send timings
 *   wl-longwork-scheduled    long-work.md — the global scheduled-task list
 *   wl-longwork-board        long-work.md — the task board
 *   wl-longwork-context      long-work.md — the context card with Fresh selected
 *
 * `wl-longwork-context` reproduces the 2026-10-04 `long-work-context-fresh`
 * composition deliberately: that frame's card was already correct, and the only
 * defect in it was the empty rail above. Same walker, better world.
 */

const S = 'sess_sample_prepare_release';
const READY = '[data-session-sidebar]';

/**
 * Open a route and wait for one concrete selector — never networkidle. A
 * settings or management page paints its shell before its data arrives, so a
 * shell selector can match while the section below it is still empty; the beat
 * lets the page's own queries land before a walker looks inside.
 */
async function open(page, link, path, selector, timeout = 45_000) {
  await page.goto(link(path), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector(selector, { timeout });
  await page.waitForTimeout(1_200);
}

/** Park the pointer away from every hover target and settle paint. */
async function settle(page) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)));
  }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
}

/**
 * Open the composer header row that docks the goal card and the queue strip.
 * Both are folded into that header until the reader opens them, so a walker
 * that waits for `[data-goal-card]` without this step waits forever on an
 * element that is correctly hidden. The toggle is the same one a person uses.
 */
async function openComposerHeader(page, which) {
  const tab = page.locator(`[data-composer-header] [data-header-toggle="${which}"]`);
  await tab.waitFor({ timeout: 30_000 });
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
}

async function openQueue(page, link) {
  await open(page, link, `/s/${S}`, '[data-session-rail]', 60_000);
  await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
  await openComposerHeader(page, 'queue');
  await page.locator('[data-queue-strip]').waitFor({ timeout: 30_000 });
}

async function openGoal(page, link) {
  await open(page, link, `/s/${S}`, '[data-session-rail]', 60_000);
  await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
  await openComposerHeader(page, 'goal');
  await page.locator('[data-goal-card]').waitFor({ timeout: 30_000 });
}

/**
 * Open a subagent's own page. The rail's dispatch-tree row navigates to
 * `/s/:id/agent/:agentId` (src/components/timeline/ToolSemanticParts.tsx:71),
 * and that route swaps the whole session surface: the centre pane becomes the
 * subagent's own transcript, with the lead's tree still one click back in the
 * rail. So this is not a rail-only switch — it is the real "a subagent keeps
 * its own record" surface, and the frame is the product's, not a crop.
 *
 * The rail sets `data-rail-owner-name` to the selected agent's label
 * (src/components/agent-panel/InspectorAgents.tsx:122), which is the product's
 * own signal that the switch landed. Waiting on that rather than on a delay is
 * what stops the frame from showing the lead's transcript under a subagent's
 * caption.
 */
async function openSubagent(page, link, agentId, label) {
  await open(page, link, `/s/${S}/agent/${agentId}`, '[data-session-rail] [data-agent-id]', 60_000);
  await page.waitForFunction((name) => document
    .querySelector('[data-rail-owner]')?.getAttribute('data-rail-owner-name') === name,
  label, { timeout: 30_000 });
  // The subagent's own turn has to be on screen, not just the route: the pane
  // attaches asynchronously, and the claim is about the record.
  await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
  await page.waitForTimeout(600);
}

/** Expand the rail's own disclosure sections so their content is in the frame. */
async function openRailSection(page, toggle) {
  const head = page.locator(`[data-session-rail] ${toggle}`).first();
  if ((await head.count()) === 0) return;
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await page.waitForTimeout(300);
}

/**
 * Fold one rail disclosure closed. The schedule list opens by default
 * (src/components/rail-variants/SessionCronSection.tsx:180), and two expanded
 * plan rows are enough to push the bottom of a 900px dispatch tree out of the
 * frame. Folding it is the reader's own click, and it is what a reader does
 * when they came to look at the agents rather than the plans.
 */
async function foldRailSection(page, headId) {
  const head = page.locator(`[data-session-rail] #${headId}`).first();
  if ((await head.count()) === 0) return;
  if ((await head.getAttribute('aria-expanded')) === 'true') await head.click();
  await page.waitForTimeout(250);
}

/**
 * Bring the transcript to its end so the jump-to-latest pill is not in frame.
 *
 * The pill (src/components/Transcript.tsx:2696) is a floating overlay that
 * appears whenever the virtualizer is not at the end. Captured mid-history it
 * sits on top of a sentence, which reads as a broken image rather than a
 * session in progress.
 *
 * The scroll container is `[data-transcript-scroll]` (Transcript.tsx:4256) —
 * the `role="log"` element is its CHILD, so the scroller is not an ancestor of
 * it. Clicking the pill is the reader's own gesture and drives the virtualizer
 * through its own `scrollToEnd()`, which is more reliable than writing
 * scrollTop directly against a virtualized list.
 */
async function scrollTranscriptToEnd(page) {
  const pill = page.locator('[data-jump-to-latest]');
  if ((await pill.count()) === 0) return;
  await pill.click({ timeout: 10_000 }).catch(() => undefined);
  // The pill unmounts once the virtualizer reports it is at the end; its
  // disappearance is the proof the scroll took.
  await pill.waitFor({ state: 'detached', timeout: 10_000 }).catch(async () => {
    // Fall back to driving the scroller directly, then let React re-render.
    await page.locator('[data-transcript-scroll]').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    }).catch(() => undefined);
  });
  await page.waitForTimeout(500);
}

export const WORKBENCH_LONGWORK_SHOTS = [
  {
    // The one screen a first-time reader has to understand, and the frame the
    // landing page leads with: the lead session and the work it pushed out.
    // Every rail block carries real content here — working notes, a live
    // injected rule, this session's own schedules — so the window reads as a
    // session in progress rather than a product with nothing in it.
    name: 'wl-hero-workbench',
    scenario: 'wl-20261005-w1',
    viewport: { width: 1440, height: 900 },
    themes: ['light'],
    run: async ({ page, link, shot }) => {
      await openGoal(page, link);
      await openQueue(page, link);
      // Order matters: expanding the queue dock shrinks the transcript viewport,
      // and THAT is what raises the jump-to-latest pill. Settling first and
      // clearing the pill second is the only order in which the pill is
      // actually gone when the shutter opens.
      await settle(page);
      await scrollTranscriptToEnd(page);
      await shot({ skipSettle: true });
    },
  },
  {
    // The workbench page's "each role can run a different model" claim. The
    // dispatch tree with its per-role model chips is the subject, so the
    // 1200px crop is deliberate: it is a rail close-up that still shows a main
    // turn beside it, so the frame reads as a session and not as a sidebar.
    name: 'wl-workbench-fleet',
    scenario: 'wl-20261005-w1',
    viewport: { width: 1200, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/s/${S}`, '[data-session-rail] [data-agent-id]', 60_000);
      await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
      // This frame is about the dispatch tree, so the schedule list folds out of
      // the way and all four roles stay in the crop.
      await foldRailSection(page, 'rail-cron-head');
      await settle(page);
      await shot();
    },
  },
  {
    // A subagent's own record, opened in the same right rail: what it was
    // asked, the tool steps it took, its own working notes and its own model
    // binding — with the lead's dispatch tree still one click away. This is the
    // frame behind "a subagent keeps its own record", which had no image.
    name: 'wl-workbench-subagent',
    scenario: 'wl-20261005-w3',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      // The rail labels the Explorer in the reader's language, and the rail
      // header is the signal this waits on, so the label must be the localized
      // one rather than the seed's internal role name.
      const label = locale === 'zh' ? '探索者' : 'Explorer';
      await openSubagent(page, link, 'agent-explorer', label);
      await settle(page);
      await shot();
    },
  },
  {
    // Background tasks are a first-class page, not a rail strip: this is what
    // the workbench page points at when it says a long command need not hold
    // the foreground. Running with its stop control, completed, and failed —
    // the three states a reader needs to recognise their own task in.
    name: 'wl-workbench-tasks',
    scenario: 'wl-20261005-w2',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/s/${S}/tasks`, '[data-session-sidebar]', 60_000);
      // Wait for the finished and failed rows specifically: the page paints
      // its shell first, and a frame taken then would show one task where the
      // caption promises three states.
      await page.waitForFunction(() => document.body.innerText.includes('watch')
        || document.querySelectorAll('[data-task-row], [data-tasks-list] li, [data-task-card]').length >= 3,
      undefined, { timeout: 45_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // The long-work page's first claim: a goal carrying across turns, and the
    // two queued messages each carrying its own send timing. The pointer stays
    // on the first row because the per-row timing control only appears on
    // hover, and that per-row timing IS the point of the frame.
    name: 'wl-longwork-goal-queue',
    scenario: 'wl-20261005-w6',
    viewport: { width: 1200, height: 750 },
    run: async ({ page, link, shot }) => {
      await openGoal(page, link);
      await openQueue(page, link);
      await page.locator('[data-queue-strip] li').first().hover();
      await page.locator('[data-queue-strip] [data-timing-picker]').first().waitFor({ timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      await shot({ skipSettle: true });
    },
  },
  {
    // The long-work page's second claim, first half: the global schedule list.
    // Four plans with their own expressions, next fire times and states — a
    // recurring plan, a one-shot, a nightly, and a paused one. This section of
    // the page had no frame at all in the 2026-10-04 set.
    name: 'wl-longwork-scheduled',
    scenario: 'wl-20261005-w4',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/cron', '[data-cron-page]', 60_000);
      // Wait for the paused and one-shot rows, not merely for the page: the
      // list arrives in two grades and a frame taken between them would show
      // fewer states than the caption claims.
      await page.locator('[data-cron-task]').nth(3).waitFor({ timeout: 45_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // The long-work page's second claim, second half: the task board. Cards
    // are persistent requirements, not agent runs, so the frame shows several
    // columns at once and one card opened with its own goal text — the
    // distinction the section exists to make.
    name: 'wl-longwork-board',
    scenario: 'wl-20261005-w5',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      // The board's first grade paints the lanes; the cards themselves arrive
      // with the read, so wait for a card rather than for the column header.
      await open(page, link, '/board', '[data-board-lanes]', 60_000);
      await page.locator('[data-board-task-card]').first().waitFor({ timeout: 45_000 });
      // Open the requirement that carries the most detail, so the frame shows
      // a card with its own goal text and not just a column of titles.
      const card = page.locator('[data-board-task-card="board_wl_changelog"]').first();
      if ((await card.count()) > 0) {
        await card.click();
        await page.waitForTimeout(900);
      }
      await settle(page);
      await shot();
    },
  },
  {
    // The context card, with Fresh actually selected — not merely present.
    // The 2026-10-04 frame had this card right; the only defect in it was the
    // empty working-notes block above, so the composition is kept and the seed
    // is not.
    name: 'wl-longwork-context',
    scenario: 'wl-20261005-w7',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/s/${S}`, '[data-context-meter]');
      await page.locator('[data-context-meter]').click();
      await page.locator('[data-context-details]').waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => document
        .querySelector('[data-context-strategy]')
        ?.getAttribute('data-strategy') === 'fresh', undefined, { timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
];

export default WORKBENCH_LONGWORK_SHOTS;
