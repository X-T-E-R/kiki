/**
 * Visual-proof walker for `/usage?panel=export` (fixture `usage-export`).
 *
 * The panel is a projection of `/api/usage-export`, so this walk is a real loop
 * rather than a set of static screens:
 *
 *   1. the list as a reader meets it: source line, queue ceiling, and one row
 *      per state the server can report — active, credential refused with a queued
 *      batch, a service that holds different data, and a fresh draft;
 *   2. the add flow end to end: a draft that sends nothing, a protocol
 *      handshake, the payload preview with its sample and quality warnings, and
 *      one consent that enables — then the same destination read back in the list
 *      with its consent and its last-success line;
 *   3. a stale preview, which must not offer a consent for a payload nobody saw;
 *   4. the script branch, where the one-time authorisation of the approved
 *      command is stated in the reader's terms;
 *   5. the handoff wizard: both effects of the single consent, the expired
 *      boundary, and the completed state with both receipts;
 *   6. the destructive confirmations, which name what they discard;
 *   7. 390 for the key states (a long origin and a queued failure must not
 *      push the page sideways), and the current space's own theme at dark.
 *
 * Nothing here talks to a real service: the fixture answers every route, and the
 * one place that would reach outward is a `Save and test` against a fixture
 * endpoint.
 */

export function createUsageExportWalker({ page, shot, resizeViewport, control, view, webUrl, fixtureUrl, fixtureToken }) {
  const url = (query = '') =>
    `${webUrl}/usage?panel=export${query === '' ? '' : `&${query}`}&server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base) => `usage-export-${base}${view.locale === 'en' ? '' : `-${view.locale}`}`;
  const expect = (condition, message) => { if (!condition) throw new Error(message); };

  const open = async (query = '') => {
    await page.goto(url(query), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-usage-export-list], [data-usage-export-empty], [data-usage-export-unavailable]', { timeout: 20_000 });
    await page.waitForTimeout(400);
  };
  // Clicking the same row twice closes it, and the detail animates open, so
  // both states are checked rather than assumed.
  const openRow = async (id) => {
    const row = page.locator(`[data-usage-export-destination="${id}"] [data-usage-export-row]`);
    if (await row.getAttribute('aria-expanded') !== 'true') {
      await row.click();
      await page.waitForSelector(`[data-usage-export-detail="${id}"]`, { timeout: 10_000 });
    }
    await page.waitForTimeout(400);
  };
  const setValue = async (selector, value) => {
    await page.locator(selector).fill(value);
    await page.waitForTimeout(120);
  };
  const noHorizontalOverflow = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 1, `${label} overflows by ${overflow}px`);
  };
  /** Every text node inside a container has to stay inside the viewport. */
  const noBleed = async (selector, label) => {
    const bleeding = await page.evaluate((sel) => {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect();
        if (rect.right > window.innerWidth + 1 || rect.left < -1) out.push(el.dataset.usageExportRow ?? sel);
      }
      return out;
    }, selector);
    expect(bleeding.length === 0, `${label} bleeds off-edge: ${bleeding.join(',')}`);
  };

  const VIBE = '11111111-1111-4111-8111-111111111111';
  const LONG_ORIGIN = '22222222-2222-4222-8222-222222222222';
  const DIVERGED = '33333333-3333-4333-8333-333333333333';
  const FRESH = '44444444-4444-4444-8444-444444444444';

  return async function walk() {
    // 1. The list as a reader meets it.
    await open();
    await page.waitForSelector('[data-usage-export-source]', { timeout: 10_000 });
    // The source line names this connection's own server and home; the fixture
    // answers /meta with `fixture-server`, so its id is what proves it.
    const source = await page.locator('[data-usage-export-source]').innerText();
    expect(source.includes('127.0.0.1'), `source line does not name the connected server: ${source}`);
    expect(source.includes('home main'), `source line does not name the home: ${source}`);
    expect(await page.locator('[data-usage-export-row]').count() === 4, 'expected the four seeded destinations');
    // A blocked destination is named in the row, not by a wall of red.
    const refused = await page.locator(`[data-usage-export-destination="${LONG_ORIGIN}"] [data-usage-export-row]`).innerText();
    expect(refused.includes('Credential refused'), `refused row does not name its state: ${refused}`);
    expect(refused.includes('18 buckets'), `refused row does not show its queue: ${refused}`);
    expect((await page.locator(`[data-usage-export-destination="${LONG_ORIGIN}"] [data-usage-export-row] [data-usage-export-state]`).first().getAttribute('data-usage-export-state')) === 'needs-auth',
      'refused row carries the wrong state');
    const capacity = await page.locator('[data-usage-export-capacity]').innerText();
    expect(capacity.includes('50 MiB'), `queue ceiling is not shown: ${capacity}`);
    await noHorizontalOverflow('list');
    await shot(name('list'));

    // 2. The detail of a blocked destination: the recovery action, and the
    //    actions that clear it. The queue survives a pause.
    await openRow(LONG_ORIGIN);
    const detail = await page.locator(`[data-usage-export-detail="${LONG_ORIGIN}"]`).innerText();
    expect(detail.includes('The service refused the stored credential.'), `recovery line missing: ${detail.slice(0, 200)}`);
    expect(detail.includes('Replace the key, test the connection, then resume.'), `recovery action missing: ${detail.slice(0, 200)}`);
    expect(detail.includes('Pending data limit') === false, 'detail repeats the panel-level ceiling');
    await page.locator(`[data-usage-export-detail="${LONG_ORIGIN}"]`).scrollIntoViewIfNeeded();
    await shot(name('detail-refused'));
    await page.locator('[data-usage-export-pause]').click();
    await page.waitForTimeout(600);
    const paused = await page.locator(`[data-usage-export-destination="${LONG_ORIGIN}"] [data-usage-export-row]`).innerText();
    expect(paused.includes('18 buckets'), `pause dropped the queue: ${paused}`);
    expect(paused.includes('Paused'), `pause did not change the state: ${paused}`);
    await shot(name('paused-keeps-queue'));

    // 3. Destructive confirmations name what they discard.
    await openRow(LONG_ORIGIN);
    await page.locator('[data-usage-export-clear-queue]').click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5_000 });
    const clearCopy = await page.locator('[role="alertdialog"]').innerText();
    expect(clearCopy.includes('18 unsent buckets'), `clear-queue confirm does not name the count: ${clearCopy}`);
    await shot(name('confirm-clear-queue'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await openRow(VIBE);
    await page.locator('[data-usage-export-remove]').click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5_000 });
    const removeCopy = await page.locator('[role="alertdialog"]').innerText();
    expect(removeCopy.includes('Nothing is deleted at the service'), `remove confirm hides the remote effect: ${removeCopy}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 4. A service that holds different data: nothing is retried, and the
    //    recovery names the action a human has to choose.
    await openRow(DIVERGED);
    const diverged = await page.locator(`[data-usage-export-detail="${DIVERGED}"]`).innerText();
    expect(diverged.includes('does not accept a lower revision'), `diverged recovery is wrong: ${diverged.slice(0, 200)}`);
    expect(await page.locator('[data-usage-export-sync]').isDisabled(), 'send-now is offered for a diverged destination');
    expect(await page.locator('[data-usage-export-withdraw]').count() === 0, 'withdrawal is offered where the adapter cannot delete');
    await shot(name('detail-diverged'));

    // 5. The add flow, end to end. A draft sends nothing; the preview is the
    //    payload; one consent enables it and the row reads it back.
    await page.locator('[data-usage-export-add]').click();
    await page.waitForSelector('[data-usage-export-form="create"]', { timeout: 5_000 });
    await setValue('[data-usage-export-form-name]', 'receiving warehouse');
    await setValue('[data-usage-export-form-endpoint]', 'https://usage.example.test/ingest');
    // The default is "from now", which has no history behind it; the realistic
    // flow for a new destination is to start earlier, and the boundary the
    // server records is printed under the field, so the walk reads it back.
    await setValue('[data-usage-export-form-history]', await page.evaluate(() => {
      const past = Date.now() - 6 * 3_600_000;
      const local = new Date(past - new Date(past).getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }));
    const boundary = await page.locator('[data-usage-export-form-boundary]').innerText();
    expect(boundary.endsWith('UTC'), `the resolved boundary is not printed as UTC: ${boundary}`);
    await shot(name('form-draft'));

    // A saved draft is a configuration write and nothing more.
    await page.locator('[data-usage-export-form-preview]').click();
    await page.waitForSelector('[data-usage-export-preview-block]', { timeout: 20_000 });
    await page.locator('[data-usage-export-preview-block]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const preview = await page.locator('[data-usage-export-preview-block]').innerText();
    expect(preview.includes('UTC'), `preview does not print the exact history start: ${preview.slice(0, 200)}`);
    expect(preview.includes('vibecafe.ai is told the source is Kimi Code'), 'vibecafe caveat is missing from the vibe preview');
    const sample = await page.locator('[data-usage-export-preview-sample]').innerText();
    expect(sample.includes('schema_version'), `field sample is not the wire shape: ${sample.slice(0, 120)}`);
    // The hash is folded; what it means for the consent is not.
    const binding = page.locator('[data-usage-export-preview-fingerprint]');
    expect(await binding.count() === 1, 'the consent binding hash is gone entirely');
    // A closed disclosure hides its content, so the element is present but not
    // visible — that is the state being asserted here.
    expect(await binding.isVisible() === false, 'the consent binding hash is still on the page without being asked for');
    const bindingOpen = await binding.evaluate((node) => {
      const fold = node.closest('details');
      return fold === null ? null : fold.open;
    });
    expect(bindingOpen === false, `the consent binding hash is not folded: ${String(bindingOpen)}`);
    expect(preview.includes('needs a new preview'), `the consequence of changing the payload is lost: ${preview.slice(0, 200)}`);
    expect(/^[a-f0-9]{24}…$/.test((await binding.textContent() ?? '').trim()),
      'the consent binding hash is malformed');
    await shot(name('form-preview'));

    await page.locator('[data-usage-export-form-enable]').click();
    await page.waitForSelector('[data-usage-export-form]', { state: 'detached', timeout: 30_000 });
    await page.waitForTimeout(600);
    const rows = await page.locator('[data-usage-export-row]').count();
    expect(rows === 5, `the new destination is not in the list (rows=${rows})`);
    const created = await page.locator('[data-usage-export-destination]').last().innerText();
    expect(created.includes('receiving warehouse'), `the new destination is not named: ${created}`);
    expect(created.includes('Active'), `the new destination is not active: ${created}`);
    await shot(name('list-after-consent'));

    // 6. A preview that no longer describes the payload must not offer consent.
    await page.locator('[data-usage-export-destination]').last().locator('[data-usage-export-row]').click();
    await page.waitForSelector('[data-usage-export-edit]', { timeout: 5_000 });
    await page.locator('[data-usage-export-edit]').click();
    await page.waitForSelector('[data-usage-export-form="edit"]', { timeout: 5_000 });
    await setValue('[data-usage-export-form-name]', 'receiving warehouse (renamed)');
    await page.locator('[data-usage-export-form-preview]').click();
    await page.waitForSelector('[data-usage-export-preview]', { timeout: 20_000 });
    await setValue('[data-usage-export-form-name]', 'receiving warehouse again');
    await page.waitForTimeout(300);
    // Editing after a preview invalidates it: the consent is refused until the
    // payload is built again, and the screen says why.
    expect(await page.locator('[data-usage-export-form-enable]').isDisabled(),
      'a stale preview still offers consent');
    expect(await page.locator('[data-usage-export-preview-stale]').count() === 1, 'the stale preview is not explained');
    await shot(name('form-preview-stale'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // 7. The script branch states the one-time authorisation of the command.
    await page.locator('[data-usage-export-add]').click();
    await page.waitForSelector('[data-usage-export-form="create"]', { timeout: 5_000 });
    await setValue('[data-usage-export-form-name]', 'local receiver');
    await page.locator('[data-axis="export-kind"] [data-axis-value="script"]').click();
    await page.waitForSelector('[data-usage-export-form-command]', { timeout: 5_000 });
    const scriptNote = await page.locator('[data-usage-export-form-script-note]').innerText();
    expect(scriptNote.includes('as your OS user'), `script permission is not stated: ${scriptNote}`);
    expect(scriptNote.includes('not a sandbox'), `script is not named as unsandboxed: ${scriptNote}`);
    expect(await page.locator('[data-usage-export-form-secret]').count() === 0, 'a script destination asks for a key');
    await setValue('[data-usage-export-form-command]', 'usage-receiver --json');
    await page.locator('summary:has-text("Advanced")').first().click();
    await page.waitForTimeout(200);
    await shot(name('form-script'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // 8. The handoff: one consent, both effects, and the expired boundary.
    await openRow(FRESH);
    await page.locator(`[data-usage-export-detail="${FRESH}"] [data-usage-export-handoff-section]`, { hasText: 'Old collector handoff' }).waitFor({ timeout: 5_000 });
    const handoff = await page.locator(`[data-usage-export-detail="${FRESH}"] [data-usage-export-handoff-section]`).innerText();
    expect(handoff.includes('stops covering this Kiki home from the boundary onward'), `first consent effect missing: ${handoff.slice(0, 300)}`);
    expect(handoff.includes('queues anything it cannot send while offline'), 'second consent effect missing');
    expect(handoff.includes('does not rewrite the collector'), 'the safety statement is missing');
    expect(handoff.includes('Choose a new future boundary') === false, 'a fresh draft shows the expired copy');
    await shot(name('handoff-not-arranged'));

    // A boundary that has passed is not a takeover.
    const cutoffInput = '[data-usage-export-handoff-cutoff]';
    await setValue(cutoffInput, '2020-01-01T00:00');
    await setValue('[data-usage-export-handoff-file]', 'C:/fixture/collector.json');
    await page.locator('[data-usage-export-handoff-arm]').click();
    await page.waitForSelector('[data-usage-export-handoff-invalid]', { timeout: 5_000 });
    await shot(name('handoff-needs-future-boundary'));
    // `datetime-local` edits wall time, so the walk fills the local rendering of
    // a future moment rather than an ISO string the field would reject.
    await page.locator(cutoffInput).fill(await page.evaluate(() => {
      const when = Date.now() + 90 * 60_000;
      return new Date(when - new Date(when).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    }));
    await page.waitForTimeout(200);
    await page.locator('[data-usage-export-handoff-arm]').click();
    await page.waitForSelector('[data-usage-export-handoff-phase]', { timeout: 20_000 });
    // One consent covers the whole sequence, so the phase that reads back is
    // `armed`: Kiki has taken over at the boundary and is waiting for receipts,
    // which is explicitly not a confirmed sync yet.
    const armed = await page.locator('[data-usage-export-handoff-phase]').innerText();
    expect(armed.includes('Waiting for the first confirmations'), `the handoff did not arm: ${armed}`);
    expect(armed.includes('not a successful sync yet'), 'readiness is described as a completed sync');
    await page.waitForTimeout(400);
    await shot(name('handoff-armed'));

    // The same armed detail with both folded technical parts opened, so the
    // current arrangement is readable in one image: the boundary, the phase,
    // both receipts and the consent facts in the open; the namespace and the
    // match rule only after a click.
    const armedRoot = `[data-usage-export-detail="${FRESH}"]`;
    const armedIdentity = page.locator(`${armedRoot} [data-usage-export-identity] summary`);
    await armedIdentity.scrollIntoViewIfNeeded();
    await armedIdentity.click();
    const armedIdentityText = await page.locator(`${armedRoot} [data-usage-export-identity-body]`).innerText();
    expect(armedIdentityText.includes('not a verified account'), `the identity disclosure lost its derivation note: ${armedIdentityText}`);
    const armedTechnical = page.locator(`${armedRoot} [data-usage-export-handoff-technical] summary`);
    await armedTechnical.scrollIntoViewIfNeeded();
    await armedTechnical.click();
    const armedTechnicalText = await page.locator(`${armedRoot} [data-usage-export-handoff-technical]`).innerText();
    expect(armedTechnicalText.includes('kiki-'), `the namespace moved out of the disclosure: ${armedTechnicalText}`);
    expect(armedTechnicalText.includes('compares the destination with the collector'),
      `the identity mechanism moved out of the disclosure: ${armedTechnicalText}`);
    // Nothing that decides the outcome is folded: the boundary, the two
    // receipts and the arm effects stay in the open.
    expect(await page.locator(`${armedRoot} [data-usage-export-handoff-cutoff-value]`).isVisible(),
      'the boundary value is no longer visible');
    expect(await page.locator(`${armedRoot} [data-usage-export-handoff-legacy]`).isVisible(),
      'the old collector receipt is no longer visible');
    expect(await page.locator(`${armedRoot} [data-usage-export-handoff-native]`).isVisible(),
      'the native receipt is no longer visible');
    await shot(name('detail-expanded'));

    // 9. 390 for the states that carry the most text. The scenario is reloaded
    //    so this pass still sees the refused credential the desktop pass did.
    await control({ action: 'scenario', name: 'usage-export' });
    await resizeViewport(390);
    await open();
    await noHorizontalOverflow('390 list');
    await noBleed('[data-usage-export-row]', '390 rows');
    await shot(name('mobile-390-list'));
    await openRow(LONG_ORIGIN);
    await noHorizontalOverflow('390 refused detail');
    // `innerText` of a scroll container can clip its head, so the two facts are
    // read from the elements that carry them.
    const recovery = page.locator(`[data-usage-export-detail="${LONG_ORIGIN}"] [data-usage-export-recovery]`);
    expect(await recovery.count() === 1, 'the recovery line is lost at 390');
    const recoveryText = await recovery.innerText();
    expect(recoveryText.includes('Replace the key'), `the recovery action is lost at 390: ${recoveryText}`);
    expect(recoveryText.includes('The service refused the stored credential.'), `the recorded reason is lost at 390: ${recoveryText}`);
    const mobileRow = await page.locator(`[data-usage-export-destination="${LONG_ORIGIN}"] [data-usage-export-row]`).innerText();
    expect(mobileRow.includes('18 buckets'), `the queue count is lost at 390: ${mobileRow}`);
    expect(mobileRow.includes('2 failed'), `the quarantine count is lost at 390: ${mobileRow}`);
    expect(mobileRow.includes('https://usage.example.test'), 'the endpoint is lost at 390');
    await page.locator(`[data-usage-export-detail="${LONG_ORIGIN}"]`).scrollIntoViewIfNeeded();
    await shot(name('mobile-390-refused'));
    await resizeViewport(1440);

    // 10. The applied theme, read back from the document rather than assumed:
    //     the shot is taken with whatever `<html data-theme>` resolved to, and a
    //     pale palette here would mean the dark pass never happened.
    // `theme` is a per-space preference written through /homes/{id}/settings, a
    // route this fixture does not serve, so the settings click cannot land. The
    // preference defaults to `system`, and `startThemeSync` follows the OS both
    // on load and on every `change` event — so the OS media emulation below is
    // the real dark path a person with a dark desktop is on, and the resolved
    // value is read back off the document rather than assumed.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'dark', null, { timeout: 10_000 });
    await open();
    await page.waitForTimeout(600);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const paper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim());
    expect(theme === 'dark', `the dark pass did not apply: data-theme=${theme}`);
    // A real dark palette, not a light one with a dark attribute: the paper
    // channel is compared by its red byte, since a packed 24-bit value is never
    // itself below 0x40 however dark it is.
    const paperRed = /^#([0-9a-fA-F]{2})/.exec(paper)?.[1];
    expect(paperRed !== undefined && Number.parseInt(paperRed, 16) < 0x40, `the dark pass painted a light surface: ${paper}`);
    await shot(name('list-dark'));
    await openRow(DIVERGED);
    await shot(name('detail-dark'));

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'light', null, { timeout: 10_000 });
    await control({ action: 'scenario', name: 'usage-export' });
  };
}
