/**
 * Visual-proof walker for `/capabilities?view=import` (fixture `plugin-import`).
 *
 * The import surface is a real loop, not a set of static screens, so the walk
 * drives the whole chain and checks what the page claims:
 *
 *   1. the surface as a reader meets it: the sources the server offers (one
 *      package carrying every built-in format plus the custom slot, which is
 *      what proves the list is contract data), the target home named as a fact
 *      rather than a field, and the seeded jobs in every state the host can
 *      report;
 *   2. the source home, its own path line, and the discovery list paged by
 *      cursor — the second page has to arrive without a back step;
 *   3. a preview that is honest: a sample, the server's own loss lines, and
 *      one click that starts the job — no second consent dialog;
 *   4. the live job: real progress drawn from real bytes, a stop that takes,
 *      and a resume that returns it to running;
 *   5. a failed job whose message is the server's sentence, not the page's;
 *   6. an archive, read page by page, opened from the archive list and again
 *      from the finished job;
 *   7. 390 for the states that must not push the page sideways: a long source
 *      home, a long title, and a loss list.
 *
 * Nothing here reaches a real home: the fixture server answers all ten import
 * methods, and the only path a user could "type" is fixture text.
 */

const CLAUDE_HOME = 'C:/Users/fixture/.claude';
const MIGRATION = '0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3';
const CHECKLIST = '7a1b9c3d-2e4f-4a6b-8c0d-1e2f3a4b5c6d';
const FIXTURE_REVISION = 'bb12cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899aabb';
/** The local project a native import is aimed at; fixture text, never a real home. */
const NATIVE_WORK_DIR = 'C:/Users/fixture/code/imported-project';
/** The scenario's already-finished native import: kept as the walk's counterexample. */
const SEEDED_NATIVE_JOB = 'job-native-done';
/** The part of the fixture's answer that only the imported history could produce. */
const IMPORTED_REPLY_FRAGMENT = 'the batch was raised to 20,000';
/** A line that exists only in the conversation this walk imports. */
const IMPORTED_CONVERSATION_TITLE = 'Migrate the search index to the new analyzer';

export function createPluginImportWalker({ page, shot, resizeViewport, webUrl, fixtureUrl, fixtureToken }) {
  const url = (query = '') =>
    `${webUrl}/capabilities?view=import${query === '' ? '' : `&${query}`}&server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base) => `plugin-import-${base}`;
  const expect = (condition, message) => { if (!condition) throw new Error(message); };

  /** The session start page, on the same fixture server this walk drives. */
  const openNewSession = async () => {
    await page.goto(`${webUrl}/new?server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
  };
  const open = async (query = '') => {
    await page.goto(url(query), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-plugin-import-view], [data-cap-import-disabled]', { timeout: 20_000 });
    await page.waitForTimeout(400);
  };
  const noHorizontalOverflow = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 1, `${label} overflows by ${overflow}px`);
  };
  /** Every text node inside the surface has to stay inside the viewport. */
  const noBleed = async (label) => {
    const bleeding = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-plugin-import-view] *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1)) out.push(el.className || el.tagName);
      }
      return out.slice(0, 4);
    });
    expect(bleeding.length === 0, `${label} bleeds off-edge: ${bleeding.join(' | ')}`);
  };

  /**
   * The page opens on a Kiki session, so every step that is about the
   * read-only archive states that aim rather than inheriting the default. The
   * native chain is walked first, in its own section at the end.
   */
  const chooseArchive = async () => {
    await page.locator('[data-plugin-import-destination] [data-segment="archive"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-plugin-import-destination]')?.getAttribute('data-plugin-import-destination') === 'archive',
      undefined, { timeout: 8_000 },
    );
    await page.waitForTimeout(250);
  };
  const chooseSession = async (workDir) => {
    await page.locator('[data-plugin-import-destination] [data-segment="native"]').click();
    await page.waitForSelector('[data-plugin-import-workdir-input]', { timeout: 8_000 });
    await page.fill('[data-plugin-import-workdir-input]', workDir);
    await page.waitForTimeout(250);
  };

  return async function walk() {
    // 1. The surface as a reader meets it.
    await open();
    await page.waitForSelector('[data-plugin-import-source]', { timeout: 10_000 });
    const sources = page.locator('[data-plugin-import-source]');
    expect(await sources.count() === 6, `expected all six sources of the one history package, got ${await sources.count()}`);
    // The label is the server's, not a format written in the GUI.
    expect((await sources.nth(0).innerText()).includes('Claude Code'), 'first source is not the server’s Claude Code label');
    expect((await sources.nth(1).innerText()).includes('Codex'), 'second source is not the server’s Codex label');

    // The target is a fact about this connection, not a field to fill.
    const target = page.locator('[data-plugin-import-target]');
    expect(await target.count() === 1, 'the target home is not named once');
    const targetText = await target.innerText();
    expect(targetText.includes('main'), `the target does not name the home: ${targetText}`);
    expect(targetText.includes('This machine'), `the target does not say which machine: ${targetText}`);

    // Every job state the host can report is on screen before anything is started.
    const states = await page.locator('[data-plugin-import-job]').evaluateAll((rows) => rows.map((row) => row.dataset.pluginImportJobState));
    for (const state of ['running', 'cancelled', 'interrupted', 'failed', 'completed']) {
      expect(states.includes(state), `the job list is missing a ${state} job: ${states.join(',')}`);
    }
    // A failure shows the server's sentence, not a page invention.
    const failed = await page.locator('[data-plugin-import-job-state="failed"] [data-plugin-import-job-error]').innerText();
    expect(failed.includes('Source changed'), `the failure does not carry the server's reason: ${failed}`);
    // An interrupted job is resumable, and a stopped one is too.
    expect(await page.locator('[data-plugin-import-job-state="interrupted"] [data-plugin-import-resume]').count() === 1,
      'an interrupted job offers no resume');
    await noHorizontalOverflow('jobs');
    await noBleed('jobs');
    await shot(name('list'));

    // 2. The source home, and the discovery list under it.
    await chooseArchive();
    await page.fill('[data-plugin-import-home]', CLAUDE_HOME);
    await page.waitForSelector(`[data-plugin-import-file="${MIGRATION}"]`, { timeout: 10_000 });
    const firstPage = await page.locator('[data-plugin-import-file]').count();
    expect(firstPage === 3, `the first discovery page should hold three entries, got ${firstPage}`);
    // A second page arrives from the server's cursor, and the list is replaced,
    // not appended, so the reader never sees a duplicate.
    await page.locator('[data-plugin-import-next-page]').click();
    await page.waitForSelector('[data-plugin-import-first-page]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    const secondPage = await page.locator('[data-plugin-import-file]').count();
    expect(secondPage === 2, `the second page should hold the remaining two, got ${secondPage}`);
    expect(await page.locator('[data-plugin-import-first-page]').count() === 1, 'no way back to the newest page');
    await shot(name('discovery'));
    await page.locator('[data-plugin-import-first-page]').click();
    await page.waitForTimeout(400);

    // 3. The preview: honest about the sample, explicit about the losses, and
    //    the consent is this panel — starting is one click.
    await page.locator(`[data-plugin-import-file="${MIGRATION}"]`).click();
    await page.waitForSelector('[data-plugin-import-preview]', { timeout: 15_000 });
    const preview = page.locator('[data-plugin-import-preview]');
    expect(await preview.getAttribute('data-plugin-import-coverage') === 'sample',
      'a bounded parse was drawn as a complete read');
    expect(await preview.getAttribute('data-plugin-import-probe') === 'partial',
      'the probe status is not the server’s');
    const previewText = await preview.innerText();
    expect(previewText.includes('Sample'), 'the sample is not labelled a sample');
    expect(previewText.includes('main'), `the preview does not name its target home: ${previewText}`);
    // The loss lines are the server's own counts and detail.
    const losses = await page.locator('[data-plugin-import-loss]').evaluateAll((rows) => rows.map((row) => row.textContent));
    expect(losses.length === 2, `expected two loss lines, got ${losses.length}: ${losses.join(' | ')}`);
    expect(losses.some((line) => line.includes('Sidechain')), 'the sidechain loss is missing');
    expect(losses.some((line) => line.includes('Images are recorded as placeholders')), 'the image loss is missing');
    // No dialog is stacked on top: the start button is in the panel itself.
    expect(await page.locator('[role="alertdialog"]').count() === 0, 'starting asks for a second confirmation');
    // The rows fold once there is a consequence, and there is a way back.
    expect(await page.locator('[data-plugin-import-change-file]').count() === 1, 'the folded list offers no way back');
    expect(await page.locator('[data-plugin-import-file]').count() === 1, 'the folded list still shows every row');
    // The action is on screen with the consequence, not below the fold. The
    // page scrolls the preview into view; wait for that to settle first.
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-plugin-import-start]');
      if (button === null) return false;
      const box = button.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }, undefined, { timeout: 8_000 }).catch(() => {});
    const startBox = await page.locator('[data-plugin-import-start]').boundingBox();
    expect(startBox !== null && startBox.y + startBox.height <= 900, `the start action sits below the fold at y=${startBox?.y}`);
    await shot(name('preview'));

    // 4. One click starts the job; the progress that follows is the server's.
    await page.locator('[data-plugin-import-start]').click();
    await page.waitForSelector('[data-plugin-import-job="job-0f4d2a1c6b8e4c3a"]', { timeout: 15_000 });
    const progress = page.locator(`[data-plugin-import-job="job-0f4d2a1c6b8e4c3a"] [data-plugin-import-progress]`).first();
    expect(await progress.count() === 1, 'the started job draws no progress bar');
    // A live job offers the one action that stops it.
    expect(await page.locator('[data-plugin-import-cancel]').count() >= 1, 'a running job offers no stop');
    await page.waitForFunction(() => {
      const bar = document.querySelector('[data-plugin-import-job="job-0f4d2a1c6b8e4c3a"] [data-plugin-import-progress]');
      return bar !== null && Number(bar.getAttribute('aria-valuenow')) > 0;
    }, undefined, { timeout: 15_000 }).catch(() => {});
    const live = await progress.getAttribute('aria-valuenow');
    expect(Number(live) > 0, `the progress bar never advanced past zero (aria-valuenow=${live})`);
    await shot(name('running'));

    // 5. Stopping takes, and the row offers the way back.
    const stop = page.locator('[data-plugin-import-cancel]').first();
    const stopId = await stop.getAttribute('data-plugin-import-cancel');
    await stop.click();
    await page.waitForSelector(`[data-plugin-import-job="${stopId}"][data-plugin-import-job-state="cancelled"]`, { timeout: 15_000 });
    const stopped = page.locator(`[data-plugin-import-job="${stopId}"]`);
    expect(await stopped.locator('[data-plugin-import-resume]').count() === 1, 'a stopped job offers no way back');
    await shot(name('stopped'));
    await stopped.locator('[data-plugin-import-resume]').click();
    await page.waitForSelector(`[data-plugin-import-job="${stopId}"][data-plugin-import-job-state="running"]`, { timeout: 15_000 });
    await shot(name('resumed'));
    await page.locator(`[data-plugin-import-job="${stopId}"] [data-plugin-import-cancel]`).click();
    await page.waitForSelector(`[data-plugin-import-job="${stopId}"][data-plugin-import-job-state="cancelled"]`, { timeout: 15_000 });

    // 6. The archive: an actual record, read page by page, and it says it is
    //    history rather than a conversation.
    await page.locator('[data-plugin-import-archive-open]').first().click();
    await page.waitForSelector('[data-plugin-import-archive-dialog]', { timeout: 10_000 });
    await page.waitForSelector('[data-plugin-import-archive-dialog] dl', { timeout: 10_000 });
    const archiveText = await page.locator('[data-plugin-import-archive-dialog]').innerText();
    expect(archiveText.includes('read-only record'), `the archive does not say what it is: ${archiveText.slice(0, 160)}`);
    expect(archiveText.includes('cannot be continued here'), 'the archive does not say it cannot be continued');
    // The mechanism is folded: the digest and the parser version are one
    // disclosure away, not four rows above the conversation.
    const details = page.locator('[data-plugin-import-archive-details]');
    expect(await details.getAttribute('data-open'), 'the archive does not fold its mechanism');
    // The disclosure keeps its body mounted for the fold transition, so what
    // matters is whether the digest is actually visible on the first screen.
    expect(await page.locator(`[data-plugin-import-archive-details] >> text=${FIXTURE_REVISION}`).isVisible().catch(() => false),
      'the revision is visible before the reader asks for it');
    await details.locator('button').click();
    await page.waitForTimeout(300);
    expect(await details.getAttribute('data-open'), 'the details disclosure did not open');
    expect((await page.locator('[data-plugin-import-archive-dialog]').innerText()).includes(FIXTURE_REVISION),
      'the opened disclosure does not carry the revision');
    await details.locator('button').click();
    await page.waitForTimeout(300);
    const firstArchivePage = await page.locator('[data-plugin-import-archive-record]').count();
    expect(firstArchivePage > 0, 'the archive opened empty');
    expect(await page.locator('[data-plugin-import-archive-more]').count() === 1, 'the archive offers no next page');
    await shot(name('archive'));
    await page.locator('[data-plugin-import-archive-more]').click();
    await page.waitForFunction(
      (before) => document.querySelectorAll('[data-plugin-import-archive-record]').length > before,
      firstArchivePage,
      { timeout: 10_000 },
    );
    const allRecords = await page.locator('[data-plugin-import-archive-record]').count();
    expect(allRecords > firstArchivePage, 'loading the next archive page did not add records');
    // A finished job opens the same archive from its own row.
    expect(await page.locator('[data-plugin-import-open]').count() >= 1, 'a completed job offers no archive');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // 7. The native chain, at desktop width: aim, read the consequences, start
    //    in one click, and land on a session the reader can continue.
    await open();
    await page.waitForSelector('[data-plugin-import-destination]', { timeout: 10_000 });
    expect(await page.getAttribute('[data-plugin-import-destination]', 'data-plugin-import-destination') === 'native',
      'the page does not open on a Kiki session');
    // A seeded native job is already on screen with a real session to continue.
    expect(await page.locator('[data-plugin-import-job="job-native-done"] [data-plugin-import-open-session]').count() === 1,
      'a finished native import offers no session to open');
    // A native import writes no archive, so the archive action must not appear
    // on the same row as though there were one — and the archive row keeps its own.
    expect(await page.locator('[data-plugin-import-job="job-native-done"] [data-plugin-import-open]').count() === 0,
      'a native import offers an archive it never wrote');
    expect(await page.locator('[data-plugin-import-job="job-checklist-done"] [data-plugin-import-open]').count() === 1,
      'the archive import lost its archive action');
    await noBleed('native list');
    await shot(name('native-list'));
    await chooseSession(NATIVE_WORK_DIR);
    await shot(name('native-destination'));
    await noHorizontalOverflow('native destination');
    await noBleed('native destination');

    // A session read with no working directory is not sent at all: there is no
    // sensible default directory, and guessing one would put the conversation
    // somewhere the reader never chose.
    await page.fill('[data-plugin-import-workdir-input]', '');
    await page.waitForSelector('[data-plugin-import-workdir-required]', { timeout: 8_000 });
    await page.fill('[data-plugin-import-home]', CLAUDE_HOME);
    await page.waitForSelector(`[data-plugin-import-file="${CHECKLIST}"]`, { timeout: 10_000 });
    await page.locator(`[data-plugin-import-file="${CHECKLIST}"]`).click();
    await page.waitForTimeout(700);
    expect(await page.locator('[data-plugin-import-preview]').count() === 0,
      'a session read with no working directory was previewed anyway');
    await shot(name('native-workdir-required'));

    // Naming the directory is what unblocks it, and nothing else changes.
    await page.fill('[data-plugin-import-workdir-input]', NATIVE_WORK_DIR);
    await page.waitForSelector('[data-plugin-import-preview]', { timeout: 15_000 });
    const nativePreview = page.locator('[data-plugin-import-preview]');
    expect(await nativePreview.getAttribute('data-plugin-import-preview-kind') === 'native-session',
      'the preview does not say it is a session read');
    const nativeText = await nativePreview.innerText();
    expect(nativeText.includes(NATIVE_WORK_DIR), `the session preview does not name its directory: ${nativeText.slice(0, 200)}`);
    // The action says what it produces, not just "import".
    expect((await page.locator('[data-plugin-import-start]').innerText()).includes('session'),
      'the start action does not say it makes a session');
    // What a session cannot carry is disclosed beside what the parser dropped.
    const nativeLosses = await page.locator('[data-plugin-import-loss]').evaluateAll((rows) => rows.map((row) => row.textContent));
    expect(nativeLosses.some((line) => line.includes('native context')), 'the session losses are not disclosed');
    await noHorizontalOverflow('native preview');
    await noBleed('native preview');
    await shot(name('native-preview'));

    // One click, and the job appears with the host's own progress. The receipt
    // of *this* start is what every step below is bound to: a page that also
    // carries a seeded finished native job would otherwise let any one of them
    // satisfy the next assertion, and the walk would prove nothing about the
    // import the reader just ran.
    // The job id of *this* start. The seeded finished native job stays on the
    // page the whole time, so binding to "whichever row offers a session" would
    // prove nothing about the import just started: the id has to be the one
    // this run added, and the row has to be the one it added it to.
    const idsBefore = await page.locator('[data-plugin-import-job]').evaluateAll(
      (rows) => rows.map((row) => row.getAttribute('data-plugin-import-job')));
    expect(idsBefore.includes(SEEDED_NATIVE_JOB),
      'the seeded native job is missing, so it cannot act as a counterexample');

    await page.locator('[data-plugin-import-start]').click();
    // The page reads the job it started back by id and puts it on screen; this
    // waits for a row that was not there before, which is that job and not the
    // seed. No id is reconstructed here.
    const startedJobId = await page.waitForFunction((before) => {
      const rows = [...document.querySelectorAll('[data-plugin-import-job]')];
      const fresh = rows.map((row) => row.getAttribute('data-plugin-import-job'))
        .filter((id) => !before.includes(id));
      return fresh.length === 0 ? null : fresh[0];
    }, idsBefore, { timeout: 25_000 }).then((handle) => handle.jsonValue());
    expect(typeof startedJobId === 'string' && startedJobId !== '',
      `starting an import added no job (before: ${idsBefore.join(',')})`);
    expect(startedJobId !== SEEDED_NATIVE_JOB, 'the walk bound to the seeded job instead of its own start');
    expect(await page.locator(`[data-plugin-import-job="${SEEDED_NATIVE_JOB}"]`).count() === 1,
      'the seeded native job is gone, so it can no longer contradict the new one');
    await page.waitForSelector(`[data-plugin-import-job="${startedJobId}"]`, { timeout: 15_000 });
    await page.waitForTimeout(900);
    await shot(name('native-started'));

    // It finishes, and *that* row — not any row with the action — offers the session.
    const openSelector = `[data-plugin-import-job="${startedJobId}"] [data-plugin-import-open-session]`;
    await page.waitForSelector(openSelector, { timeout: 40_000 });
    const sessionRow = page.locator(`[data-plugin-import-job="${startedJobId}"]`);
    const sessionId = await page.locator(openSelector).getAttribute('data-plugin-import-open-session');
    expect(typeof sessionId === 'string' && sessionId.length > 0, 'the finished native import names no session');
    expect(await sessionRow.locator('[data-plugin-import-open]').count() === 0,
      'a native import offers an archive it never wrote');
    // The seeded row is a different session, so the two are provably not the
    // same conversation and the walk cannot have opened the wrong one.
    const seededSessionId = await page
      .locator(`[data-plugin-import-job="${SEEDED_NATIVE_JOB}"] [data-plugin-import-open-session]`)
      .getAttribute('data-plugin-import-open-session');
    expect(seededSessionId !== sessionId, 'the new import reused the seeded session, so the two are indistinguishable');
    // The action that matters must be on screen, not three rows down: after a
    // finished import this row is the only thing the reader came back for.
    await sessionRow.locator('[data-plugin-import-open-session]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const openBox = await sessionRow.locator('[data-plugin-import-open-session]').boundingBox();
    expect(openBox !== null && openBox.y + openBox.height <= 900,
      `the session action sits below the fold at y=${openBox?.y}`);
    await noBleed('native finished');
    await shot(name('native-finished'));

    // The whole point: the imported conversation is a session, so opening it
    // lands on a live conversation carrying the imported history, and the
    // reader can carry on in it. Nothing here is a record or a dialog.
    await page.locator(openSelector).click();
    await page.waitForFunction(() => /^\/s\//.test(window.location.pathname), undefined, { timeout: 20_000 });
    // The route is the session this run's job committed, not merely *a*
    // session: that is the claim the whole destination rests on.
    const routedId = new URL(page.url()).pathname.replace(/^\/s\//, '');
    expect(routedId === sessionId,
      `opened ${routedId} but this run's job committed ${sessionId}`);
    // Watch from before the send: the reply arrives either as transcript frames
    // or as the next snapshot, and this step is about which one the page got.
    const snapContents = [];
    await page.waitForSelector('textarea[data-composer]', { timeout: 25_000 }).catch(async () => {
      const url = page.url();
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`no composer at ${url}: ${body}`);
    });
    // And it is this run's imported conversation, on screen: the turns the
    // parser read are the ones drawn here. The header paints on its own timing,
    // so the claim is made about the session and its content rather than about
    // when a label happened to appear.
    const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(shown.includes(IMPORTED_CONVERSATION_TITLE),
      `the opened session does not carry the conversation this run imported: ${shown.slice(0, 240)}`);
    const importedTurns = await page.locator('[data-turn-id]').count();
    if (importedTurns === 0) {
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600);
      throw new Error(`no message rows: ${body}`);
    }
    const sessionBody = await page.locator('body').innerText();
    expect(sessionBody.includes('Migrate the search index'), 'the imported session does not show the conversation it imported');
    await noBleed('imported session');
    await shot(name('native-session-open'));

    // And the reader can continue it: the composer is live, and a further
    // message is accepted and answered against the imported history.
    const before = await page.locator('[data-turn-id]').count();
    await page.fill('textarea[data-composer]', 'What did we decide about the batch size?');
    // The same key the rest of the proof suite uses to submit, so this is the
    // real send path rather than a click on a control that merely looks live.
    const posted = page.waitForRequest(
      (request) => request.method() === 'POST' && /\/prompts$/.test(new URL(request.url()).pathname),
      { timeout: 15_000 },
    ).catch(() => null);
    await page.press('textarea[data-composer]', 'Control+Enter');
    expect(await posted !== null, 'sending into the imported session issued no prompt request');

    // The session accepts the message and clears the composer, in the same
    // session the import created. The fixture's scripted reply arrives on its
    // own live stream, so this step asserts the round trip *into* Kiki.
    // The reply is what proves this is a live conversation rather than a
    // transcript: Kiki answers from the history the import put in context. The
    // fixture's scripted answer quotes a decision that exists only in the
    // imported turns, so seeing it is seeing the migrated context in use.
    // A first chance on the live stream, then a reload: a reply that is only
    // durable in the session snapshot is still a reply the reader gets, and the
    // reload is the honest way to tell "never arrived" from "arrived before the
    // reader looked".
    page.on('response', async (r) => {
      if (!/snapshot|messages/.test(r.url())) return;
      try {
        const d = await r.json();
        const items = d?.data?.messages?.items ?? d?.data?.items ?? [];
        const roles = items.map((m) => m.role).join(',');
        snapContents.push(`${r.url().split('/api/')[1]?.slice(0, 34)} n=${items.length} roles=${roles.slice(-60)}`);
      } catch (e) { snapContents.push(`${r.url().split('/api/')[1]?.slice(0, 40)} NONJSON`); }
    });
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      IMPORTED_REPLY_FRAGMENT,
      { timeout: 12_000 },
    ).catch(() => undefined);
    if (!(await page.evaluate((text) => document.body.innerText.includes(text), IMPORTED_REPLY_FRAGMENT))) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea[data-composer]', { timeout: 20_000 });
    }
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      IMPORTED_REPLY_FRAGMENT,
      { timeout: 20_000 },
    ).catch(async () => {
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      // Separate "the host never produced it" from "the page has not drawn it".
      throw new Error(`no answer in the imported session (expecting ${sessionId}): ${JSON.stringify(snapContents)}`);
    });
    const echoed = await page.evaluate((text) => document.body.innerText.includes(text),
      'What did we decide about the batch size?');
    expect(echoed, 'the message sent into the imported session did not appear in it');
    const draft = await page.locator('textarea[data-composer]').inputValue();
    expect(draft === '', `the composer still holds the sent message: ${draft}`);
    await noBleed('continued session');
    await shot(name('native-session-continued'));
    await open();

    // 8. 390: the native destination and its field must not push the page.
    await resizeViewport(390);
    await page.waitForTimeout(400);
    await noHorizontalOverflow('390 native');
    await noBleed('390 native');
    await shot(name('390-native'));
    await resizeViewport(1440);

    // 8. 390: a long home, a long title and a loss list must not push the page.
    // The native chain navigated away, so this step states its own state: the
    // archive aim, and a home with a file in it.
    await chooseArchive();
    await page.fill('[data-plugin-import-home]', CLAUDE_HOME);
    await page.waitForSelector(`[data-plugin-import-file="${MIGRATION}"]`, { timeout: 15_000 });
    await resizeViewport(390);
    await page.waitForTimeout(400);
    await noHorizontalOverflow('390');
    await noBleed('390');
    await shot(name('390-list'));
    await page.locator(`[data-plugin-import-file="${MIGRATION}"]`).click();
    await page.waitForSelector('[data-plugin-import-preview]', { timeout: 15_000 });
    await noHorizontalOverflow('390 preview');
    await noBleed('390 preview');
    await shot(name('390-preview'));
    await resizeViewport(1440);

    // 0. The direct way in. A reader who already has the history should not
    //    have to find it under Capabilities → Plugins, so the entry lives on the
    //    page they are already on when they mean to start working.
    await openNewSession();
    await page.waitForSelector('[data-hero-import]', { timeout: 20_000 });
    const entryLabel = (await page.locator('[data-hero-import]').textContent()) ?? '';
    expect(entryLabel.includes('Import history'), `the entry does not say what it does: ${entryLabel}`);
    await shot(name('new-session-entry'));
    await page.locator('[data-hero-import]').click();
    await page.waitForFunction(
      () => location.pathname.startsWith('/capabilities') && new URLSearchParams(location.search).get('view') === 'import',
      undefined, { timeout: 20_000 },
    );
    await page.waitForSelector('[data-plugin-import-destination]', { timeout: 20_000 });
    // Six formats from one first-party importer, with nothing installed: the
    // count is the host's own answer, not a plugin list the reader curated.
    expect(await page.locator('[data-plugin-import-source]').count() === 6,
      `expected all six sources, got ${await page.locator('[data-plugin-import-source]').count()}`);
    expect(await page.locator('[data-plugin-import-view]').count() === 1, 'the import page did not open');
    // Nothing is installed for this, and nothing needs to be: the six formats
    // come from the host. What must therefore be absent is the link to a plugin
    // page the reader cannot act on — its absence is the proof that the flow
    // no longer routes through an install.
    expect(await page.locator('[data-plugin-import-open-plugin]').count() === 0,
      'the import page still sends the reader to a plugin to manage');
    await shot(name('entry-arrives-directly'));
  };
}
