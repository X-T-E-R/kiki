/**
 * Visual-proof walker for "send now" into a running turn (fixture `steer`),
 * once for the main session and once for a native child agent. Both walks
 * prove the same contract:
 *
 *   - the message is on the timeline from the keypress on, in every animation
 *     frame, and never in the queue strip (an rAF probe samples the DOM);
 *   - it reads as awaiting insertion (sending, then waiting) while the turn's
 *     current tool call runs;
 *   - when the tool returns, the next step boundary takes it in: the same row
 *     (same block id) settles into an ordinary user bubble, exactly once,
 *     after the tool card.
 *
 * Shots per width: <flow>-sending, <flow>-waiting, <flow>-delivered.
 */

export function createSteerWalker({ page, shot, control, view, webUrl, fixtureUrl, fixtureToken }) {
  const url = (path) => `${webUrl}${path}?server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base) => `steer-${base}-${view.width}`;
  const STEER_TEXT = 'Also check the docs before you wrap up.';

  /** Sample, per animation frame, how many timeline rows and queue rows carry the text. */
  async function startProbe(scope) {
    await page.evaluate(({ scope, text }) => {
      const w = window;
      w.__steer = { frames: [], queued: 0, pressFrame: -1, stop: false };
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && w.__steer.pressFrame < 0) w.__steer.pressFrame = w.__steer.frames.length;
      }, { capture: true });
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('button[data-send-ready], [data-queue-strip] button') : null;
        if (target !== null && w.__steer.pressFrame < 0) w.__steer.pressFrame = w.__steer.frames.length;
      }, { capture: true });
      const tick = () => {
        const root = document.querySelector(scope);
        const rows = [...(root?.querySelectorAll('[data-block-id^="user-"]') ?? [])]
          .filter((row) => row.textContent?.includes(text) && row.parentElement?.closest('[data-block-id^="user-"]') === null);
        w.__steer.frames.push(rows.length);
        if (w.__steer.pressFrame >= 0 && document.querySelector('[data-queue-strip]')?.textContent?.includes(text)) w.__steer.queued += 1;
        if (!w.__steer.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { scope, text: STEER_TEXT });
  }

  async function stopProbe(flow) {
    const probe = await page.evaluate(() => { window.__steer.stop = true; return window.__steer; });
    const { frames, pressFrame, queued } = probe;
    if (pressFrame < 0) throw new Error(`${flow}: the send keypress was not observed`);
    const first = frames.findIndex((count, index) => index >= pressFrame && count > 0);
    if (first < 0) throw new Error(`${flow}: the sent message never reached the timeline`);
    // One React commit of grace between the key and the first painted echo.
    const lag = first - pressFrame;
    if (lag > 3) throw new Error(`${flow}: the message took ${lag} frames to appear after the keypress`);
    const gaps = frames.slice(first).filter((count) => count !== 1).length;
    if (gaps > 0) throw new Error(`${flow}: the message was missing or doubled in ${gaps} of ${frames.length - first} frames`);
    if (queued > 0) throw new Error(`${flow}: the message showed in the queue strip for ${queued} frames`);
    console.log(`[check] ${flow}: on the timeline ${lag} frame(s) after the key, then ${frames.length - first} frames without a gap`);
  }

  /** Awaiting insertion → delivered, asserting the row identity survives. */
  async function proveSteer(flow, scope, sessionId, send) {
    await startProbe(scope);
    await send();
    const row = page.locator(`${scope} [data-block-id^="user-"]`, { hasText: STEER_TEXT });
    await page.locator(`${scope} [data-steer-line="sending"]`).waitFor({ timeout: 5000 });
    await page.waitForTimeout(200);
    await shot(name(`${flow}-sending`));
    await page.locator(`${scope} [data-steer-line="waiting"]`).waitFor({ timeout: 10_000 });
    const pendingId = await row.getAttribute('data-block-id');
    await page.waitForTimeout(400);
    await shot(name(`${flow}-waiting`));
    // The tool finishes; the next step boundary takes the message in.
    await control({ action: 'release', session_id: sessionId });
    await page.locator(`${scope} [data-steer-line]`).waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator(`${scope} >> text=All green. Noted`).waitFor({ timeout: 10_000 });
    if ((await row.count()) !== 1) throw new Error(`${flow}: delivered message rendered ${await row.count()} times`);
    const deliveredId = await row.getAttribute('data-block-id');
    if (deliveredId !== pendingId) throw new Error(`${flow}: the row was replaced on delivery (${pendingId} → ${deliveredId})`);
    // Inserted at the tool boundary: after the tool card, before the reply that read it.
    const order = await page.evaluate(({ scope, text }) => {
      const rows = [...document.querySelectorAll(`${scope} [data-block-id]`)]
        .filter((node) => node.parentElement?.closest('[data-block-id]') === null);
      const at = (predicate) => rows.findIndex(predicate);
      return {
        tool: at((node) => node.textContent?.includes('pnpm test --run') === true),
        steer: at((node) => node.getAttribute('data-block-id')?.startsWith('user-') === true && node.textContent?.includes(text) === true),
      };
    }, { scope, text: STEER_TEXT });
    if (order.tool < 0 || order.steer <= order.tool) {
      throw new Error(`${flow}: the message is not after the tool call it waited for (${JSON.stringify(order)})`);
    }
    await page.waitForTimeout(500); // the bubble's settle transition
    await stopProbe(flow);
    await shot(name(`${flow}-delivered`));
    await control({ action: 'release', session_id: sessionId });
  }

  async function main(queued = false) {
    const sessionId = queued ? 'session_fixture_steer_queue' : 'session_fixture_steer';
    await page.goto(url(`/s/${sessionId}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea:not([disabled])', { timeout: 20_000 });
    await page.fill('textarea', 'Run the tests and fix what fails.');
    await page.press('textarea', 'Enter');
    await page.locator('[role="log"] >> text=Running the suite first.').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    if (queued) {
      await page.fill('textarea', STEER_TEXT);
      await page.press('textarea', 'Enter');
      await page.locator('[data-header-toggle="queue"]').click();
      await page.locator('[data-queue-strip]', { hasText: STEER_TEXT }).waitFor();
      await page.locator('[data-queue-item]', { hasText: STEER_TEXT }).hover();
    }
    await proveSteer(queued ? 'queue' : 'main', '[role="log"]', sessionId, async () => {
      if (queued) await page.locator('[data-queue-strip] button[title]').filter({ hasText: /Send now|立即发送/ }).click();
      else {
        await page.fill('textarea', STEER_TEXT);
        await page.press('textarea', 'Control+Enter');
      }
    });
    if (queued) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const row = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: STEER_TEXT });
      await row.waitFor();
      if ((await row.count()) !== 1) throw new Error('queue: reopened transcript lost or doubled the message');
      await shot(name('queue-reopened'));
    }
  }

  async function child() {
    await page.goto(url('/s/session_fixture_steer_child'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea:not([disabled])', { timeout: 20_000 });
    await page.fill('textarea', 'Delegate the test run.');
    await page.press('textarea', 'Enter');
    await page.waitForTimeout(600);
    await page.goto(url('/s/session_fixture_steer_child/agent/agent-helper'), { waitUntil: 'domcontentloaded' });
    const scope = '[data-agent-workspace-target="agent-helper"]';
    await page.waitForSelector('[data-composer-variant="subagent"]', { timeout: 15_000 });
    await page.locator(`${scope} >> text=Running the suite first.`).waitFor({ timeout: 15_000 });
    const input = page.locator('[data-composer-variant="subagent"] textarea');
    await input.waitFor({ timeout: 10_000 });
    // A busy child has no queue strip: its send button sends into the turn.
    await page.locator('[data-composer-variant="subagent"] button[aria-label]').first().waitFor({ timeout: 5000 });
    await proveSteer('child', scope, 'session_fixture_steer_child', async () => {
      await input.fill(STEER_TEXT);
      await input.press('Enter');
    });
  }

  return async () => {
    await main();
    await main(true);
    await child();
  };
}
