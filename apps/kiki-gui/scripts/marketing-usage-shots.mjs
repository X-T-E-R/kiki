/**
 * marketing-usage-shots — the /usage frame set (2026-10-06).
 *
 * A standalone SHOTS table, not a patch to `marketing-campaign.mjs`: that file
 * is owned work in flight, and this set is two files of its own (a scene seed
 * module, four thin scenario entry points, and this table).
 *
 * What this set is for. The page the Features series links from spends three
 * sentences on what a date range costs, one on who is queued and which rule is
 * holding them, and three on where the statistics can be sent. Only the first
 * had a frame — `daily-usage`, a seven-day History chart that this set leaves
 * in place because it is already correct. The other two had none, which is the
 * failure mode a features page cannot afford: the two claims that decide
 * whether a reader trusts the numbers are the two with nothing behind them.
 *
 * So this set adds exactly what is missing and nothing that is not:
 *
 *   ux-usage-live    Usage → Live. A request is waiting, and the row names
 *                    the rule holding it. The rule list below carries an
 *                    enabled rule and a paused one, because "the switch pauses
 *                    a rule without deleting it" is only legible if a paused
 *                    rule is in the picture.
 *   ux-usage-export  Usage → External sync. One destination per kind the
 *                    product supports, in three different states: active,
 *                    credential refused with its queue intact, and paused.
 *                    All three green would claim a delivery setup that never
 *                    fails.
 *
 * The `run` functions import nothing from the campaign runner — every helper
 * they need is defined below, so this module can be registered by appending
 * `...USAGE_SHOTS` to the campaign SHOTS table without any import edit. The
 * campaign runner's `open` and `settle` are module-local, hence the local
 * copies; they are deliberately the same steps in the same order, because
 * "the same frame translated" is the property the series depends on.
 *
 * Frames and where they land:
 *
 *   ux-usage-live    features/daily.md, marketing/gallery
 *   ux-usage-export  features/daily.md, marketing/gallery
 */

/**
 * The export panel's first line names the server it reports from, and the
 * fixture server listens on an ephemeral port — so a captured frame would
 * carry `127.0.0.1:106670` into the pixels, which is a run artifact rather
 * than a product fact.
 *
 * The fix keeps the product honest rather than hiding the line: the frame
 * connects to a neutral origin, and the browser forwards that origin's requests
 * to the very same fixture server over the very same paths. Nothing is
 * fabricated and no route is answered here — the app is unmodified, the
 * responses are the fixture's real ones, and only the address the panel
 * happens to print differs. `assertNeutralSource` below is the guard: a run
 * that lost the rewrite fails instead of shipping the port.
 */
const NEUTRAL_SERVER = 'http://kiki.local';

/** Point the neutral origin at this run's fixture, forwarding every request. */
async function serveNeutralOrigin(page, fixtureUrl) {
  await page.route(`${NEUTRAL_SERVER}/**`, async (route) => {
    await route.continue({ url: route.request().url().replace(NEUTRAL_SERVER, fixtureUrl) });
  });
  // The event socket needs the same treatment, and it is the reason this frame
  // failed on its first run: the banner read "Connection lost — reconnecting"
  // because nothing resolved the neutral host. The client derives the socket URL
  // from the connection origin, so it arrives as `ws://kiki.local/...` — a
  // different scheme from the REST rewrite above, which is why this one is a
  // constructor shim rather than another route: Playwright's WebSocket routing
  // connects to the URL the page asked for, so it cannot redirect the socket the
  // way `page.route` redirects the requests. The shim only rewrites the origin,
  // and the socket still reaches this run's fixture.
  await page.addInitScript(({ neutral, target }) => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        super(typeof url === 'string' ? url.replace(neutral, target) : url, protocols);
      }
    };
  }, { neutral: NEUTRAL_SERVER.replace(/^http/, 'ws'), target: fixtureUrl.replace(/^http/, 'ws') });
}

/**
 * Open a route and wait for one concrete selector — never networkidle. A
 * management page paints its shell before its data arrives, so a shell
 * selector can match while the section below it is still empty; the beat lets
 * the page's own queries land before a walker looks inside.
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
 * `/usage?panel=realtime`. Both halves of the claim have to be on screen at
 * once — the waiting row that names its rule, and the rule list that rule comes
 * from — so the frame waits for the rule rows rather than for the panel shell,
 * and scrolls the rules up under the live summary instead of capturing a view
 * where one of the two is below the fold.
 */
async function shootUsageLive({ page, link, shot }) {
  await open(page, link, '/usage?panel=realtime', '[data-request-governance]');
  const rows = page.locator('[data-governance-rule]');
  await rows.first().waitFor({ timeout: 30_000 });
  // The waiting list is the point of the frame: an empty one would render the
  // same panel and support none of the prose.
  if (await page.locator('[data-governance-waiting] li').count() === 0) {
    throw new Error('live frame has no waiting request, so it cannot show which rule is holding one');
  }
  await page.locator('[data-governance-rules]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await settle(page);
  await shot();
}

/**
 * `/usage?panel=export`. The list is the frame; opening a row would replace it
 * with that one destination's detail and lose the fact that three kinds exist
 * at once. The refusal row is waited for specifically, because a run that lost
 * it would ship a frame claiming a setup that never fails.
 *
 * The panel's first line names the server it reports from, and the fixture
 * server listens on an ephemeral port, so a captured frame would carry
 * `127.0.0.1:106670` into the pixels — a run artifact, not a product fact. The
 * panel reads the server from its own connection config, so one `?server=` in
 * the frame's own link is all it takes to point that line at the name a reader
 * recognizes. The destinations themselves are untouched: they come from the
 * fixture routes, over the real request path.
 */
async function shootUsageExport({ page, link, shot, fixtureUrl }) {
  await serveNeutralOrigin(page, fixtureUrl);
  const neutral = (path) => link(path).replace(encodeURIComponent(fixtureUrl), encodeURIComponent(NEUTRAL_SERVER));
  await open(page, neutral, '/usage?panel=export', '[data-usage-export-panel]', 60_000);
  const rows = page.locator('[data-usage-export-list] li');
  await rows.first().waitFor({ timeout: 30_000 });
  if (await rows.count() < 3) {
    throw new Error(`export frame shows ${await rows.count()} destinations, expected one per kind`);
  }
  if (await page.locator('[data-usage-export-state="needs-auth"]').count() === 0) {
    throw new Error('export frame has no refused destination, so it would claim a delivery setup that never fails');
  }
  // The source line is a shell that paints before its own query resolves, so
  // the value is waited for by content rather than by presence: reading it too
  // early yields a bare label and would pass a check that never ran. The panel
  // prints the host with its scheme stripped, so the check looks for the host.
  await page.waitForFunction(
    () => (document.querySelector('[data-usage-export-source]')?.textContent ?? '').includes('kiki.local'),
    undefined,
    { timeout: 30_000 },
  ).catch(async () => {
    throw new Error(`export frame would print the fixture address as the reporting server: ${await page.locator('[data-usage-export-source]').innerText()}`);
  });
  // A transport fault over an otherwise correct list is a capture defect, not a
  // product state. The banner is up for the first moments of every load, so
  // this waits for it to clear rather than merely testing that it is absent —
  // a check that ran at the wrong moment would pass a frame that still shows it.
  await page.waitForFunction(
    () => !document.body.textContent.includes('Connection lost') && !document.body.textContent.includes('连接中断'),
    undefined,
    { timeout: 20_000 },
  ).catch(() => {
    throw new Error('export frame captured a reconnecting banner over the destination list');
  });
  await settle(page);
  await shot();
}

const USAGE_SHOTS = [
  {
    name: 'ux-usage-live',
    scenario: 'ux-20261006-u1',
    viewport: { width: 1440, height: 900 },
    run: shootUsageLive,
  },
  {
    name: 'ux-usage-export',
    scenario: 'ux-20261006-u2',
    viewport: { width: 1440, height: 900 },
    run: shootUsageExport,
  },
];

export default USAGE_SHOTS;
