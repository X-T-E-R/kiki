/**
 * Visual-proof walker for native SSH (fixture `native-ssh`):
 *
 *   Settings › SSH hosts: list, an open Kiki row, an open config row, the add
 *   form (with validation), the delete confirm; connection switches, each host
 *   key panel state, and the switch reading its value back after a reload.
 *   Composer: ＋ › SSH hosts panel and the session chips; remove one chip.
 *   Tray: connect + password, connect + key file/passphrase, two-round
 *   keyboard-interactive, first-seen host key, and the changed-key refusal
 *   (a failed tool call, no card).
 *
 * Every submission is asserted against the fixture's redacted record: the
 * shape is checked, the secret values are never read back. Both themes at
 * 1440 and 390; shots go to KIKI_PROOF_OUTPUT_DIR (default
 * .tmp/visual-proof/batch3), prefixed with the proof locale.
 */

export function createNativeSshWalker({ page, shot, resizeViewport, setProofTheme, control, view, webUrl, fixtureUrl, fixtureToken, locale }) {
  const url = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${fixtureToken}`;
  const name = (base, theme, width) => `ssh-${base}-${theme}-${width}-${locale}`;
  const open = async (path, selector) => {
    await page.evaluate(() => {
      try { localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: new Date().toISOString() })); } catch { /* ignore */ }
    });
    await page.goto(url(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { timeout: 20_000 });
    await page.waitForTimeout(500);
  };
  const reset = async () => {
    await control({ action: 'scenario', name: 'native-ssh' });
  };
  const submissions = async () => (await control({ action: 'ssh-submissions' })).data?.submissions ?? [];
  const lastSubmission = async (approvalId) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const found = (await submissions()).filter((entry) => entry.approval_id === approvalId).at(-1);
      if (found !== undefined) return found;
      await page.waitForTimeout(150);
    }
    throw new Error(`no SSH submission recorded for ${approvalId}`);
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const openSession = async (sessionId) => {
    // An SSH approval opens as the tray's current decision, which takes the
    // composer card over and hides its textarea: either seat is the session
    // view being ready.
    await open(`/s/${sessionId}`, '[data-composer-variant="main"] textarea, [data-needs-you-back]');
  };

  // The action row must stay on screen and clickable however tall the form gets.
  const actionsVisible = async (label) => {
    const box = await page.locator('[data-ssh-actions] [data-ssh-submit]').boundingBox();
    const viewport = page.viewportSize();
    expect(box !== null && viewport !== null && box.y >= 0 && box.y + box.height <= viewport.height,
      `${label}: action row off screen (${JSON.stringify(box)} in ${JSON.stringify(viewport)})`);
    const hit = await page.evaluate(() => {
      const button = document.querySelector('[data-ssh-actions] [data-ssh-submit]');
      const rect = button.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top !== null && button.contains(top);
    });
    expect(hit, `${label}: action row covered`);
  };

  async function settings(theme, width) {
    await open('/settings/ssh', '[data-ssh-host-row]');
    const kiki = await page.locator('[data-ssh-group="kiki"] [data-ssh-host-row]').count();
    const config = await page.locator('[data-ssh-group="ssh-config"] [data-ssh-host-row]').count();
    expect(kiki === 4 && config === 3, `expected 4 Kiki + 3 config rows (dev shadowed), saw ${kiki} + ${config}`);
    await shot(name('settings', theme, width));
    await page.click('[data-ssh-host-row="gpu-box"] > summary');
    await page.locator('[data-ssh-host-row="gpu-box"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(name('settings-kiki-row', theme, width));
    await page.click('[data-ssh-host-row="gpu-box"] > summary');
    await page.click('[data-ssh-host-row="build-runner"] > summary');
    await page.locator('[data-ssh-host-row="build-runner"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(name('settings-config-row', theme, width));
    await page.click('[data-ssh-host-row="build-runner"] > summary');
    await page.locator('#st-card-ssh-connection').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(name('settings-connection', theme, width));

    // Host keys: nothing is read until the row asks, and each state the route
    // can answer with has to be distinguishable in the panel itself. Rows are
    // opened from their element state, not by click count: a re-render can
    // arrive with every details closed and the next click would close it again.
    const rowOpen = (id) => page.locator(`[data-ssh-host-row="${id}"]`).evaluate((row) => row.open);
    const setRow = async (id, open) => {
      if ((await rowOpen(id)) !== open) await page.click(`[data-ssh-host-row="${id}"] > summary`);
    };
    const panel = async (id, state) => {
      await setRow(id, true);
      const before = await page.locator(`[data-ssh-host-row="${id}"] [data-ssh-host-keys]`).count();
      expect(before === 0, `${id}: the panel exists before it is asked for`);
      await page.click(`[data-ssh-host-row="${id}"] [data-ssh-host-keys-toggle]`);
      await page.waitForSelector(`[data-ssh-host-row="${id}"] [data-ssh-host-keys][data-state="${state}"]`, { timeout: 10_000 });
      await page.locator(`[data-ssh-host-row="${id}"]`).scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      return (await page.locator(`[data-ssh-host-row="${id}"] [data-ssh-host-keys]`).textContent()) ?? '';
    };
    const hidePanel = async (id) => {
      if ((await page.locator(`[data-ssh-host-row="${id}"] [data-ssh-host-keys]`).count()) > 0) {
        await page.click(`[data-ssh-host-row="${id}"] [data-ssh-host-keys-toggle]`);
      }
      await setRow(id, false);
    };

    const recorded = await panel('gpu-box', 'recorded');
    const entries = await page.locator('[data-ssh-host-row="gpu-box"] [data-ssh-host-key-record]').count();
    expect(entries === 2, `expected two gpu-box entries, saw ${entries}`);
    const fingerprint = await page.locator('[data-ssh-host-row="gpu-box"] [data-ssh-host-key-fingerprint]').first().textContent();
    expect(fingerprint?.startsWith('SHA256:') === true, `gpu-box rendered no fingerprint: ${fingerprint}`);
    expect(recorded.includes('/home/ubuntu/.ssh/known_hosts:12'), `gpu-box lost its source line: ${recorded}`);
    expect(recorded.includes('The host itself is not contacted.'), `gpu-box does not say what a local match means: ${recorded}`);
    await shot(name('host-keys-recorded', theme, width));
    await hidePanel('gpu-box');

    const unrecorded = await panel('dev', 'unrecorded');
    expect(unrecorded.includes('No entry for this host'), `dev should report no local entry: ${unrecorded}`);
    await shot(name('host-keys-unrecorded', theme, width));
    await hidePanel('dev');

    const unavailable = await panel('prod-db', 'unavailable');
    expect(unavailable.includes('cannot be determined'), `prod-db should explain the undecidable file: ${unavailable}`);
    expect(unavailable.includes('/srv/keys/ssh hosts'), `prod-db should list the path it could not use: ${unavailable}`);
    expect(!unavailable.includes('No entry for this host'), 'an unreadable file must not read as "no record"');
    await shot(name('host-keys-unavailable', theme, width));
    await hidePanel('prod-db');

    const revoked = await panel('staging', 'recorded');
    expect(revoked.includes('@revoked') && revoked.includes('Revoked'), `staging should mark its revoked entry: ${revoked}`);
    await hidePanel('staging');
    const authority = await panel('build-runner', 'unavailable');
    expect(authority.includes('@cert-authority'), `build-runner should name the CA marker: ${authority}`);
    await hidePanel('build-runner');
    const invalid = await panel('pi-lab', 'unavailable');
    expect(invalid.includes('cannot be parsed') && invalid.includes('Fingerprint unavailable'),
      `pi-lab should mark an unreadable key: ${invalid}`);
    await hidePanel('pi-lab');

    // SSH-01: the switch shows the stored value. With the aliases gone after a
    // reload, an inference from the lists would have drawn ON again. The switch
    // is the label's visible track; the checkbox itself is sr-only.
    const syncTrack = '[data-ssh-sync] [role="switch"]';
    const syncBox = '[data-ssh-sync] input[type="checkbox"]';
    const syncState = (value) => page.waitForFunction(
      (expected) => document.querySelector('[data-ssh-sync] [role="switch"]')?.getAttribute('aria-checked') === expected,
      value, { timeout: 10_000 },
    );
    await page.locator('#st-card-ssh-connection').scrollIntoViewIfNeeded();
    expect(await page.locator(syncBox).isChecked(), 'seeded sync should read as on');
    await page.click(syncTrack);
    await syncState('false');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(syncBox, { timeout: 20_000 });
    await page.locator('#st-card-ssh-connection').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    expect(!(await page.locator(syncBox).isChecked()), 'sync read back as on after the switch was turned off');
    await shot(name('settings-sync-off', theme, width));
    await page.click(syncTrack);
    await syncState('true');

    // Add form: submit blank to show validation, then fill and save.
    await page.locator('[data-ssh-add-host]').scrollIntoViewIfNeeded();
    await page.click('[data-ssh-add-host]');
    await page.waitForSelector('[data-ssh-host-form="create"]');
    await page.fill('[data-ssh-host-form] input[placeholder="22"]', '70000');
    await page.click('[data-ssh-form-submit]');
    await page.waitForSelector('[data-field-issue]');
    await shot(name('form-invalid', theme, width));
    await page.fill('[data-ssh-host-form] input[placeholder="dev"]', 'lab-01');
    await page.fill('[data-ssh-host-form] input[placeholder="dev.example.com"]', 'lab-01.example.com');
    await page.fill('[data-ssh-host-form] input[placeholder="deploy"]', 'ops');
    await page.fill('[data-ssh-host-form] input[placeholder="22"]', '');
    await shot(name('form-filled', theme, width));
    await page.click('[data-ssh-form-submit]');
    await page.waitForSelector('[data-ssh-host-row="lab-01"]', { timeout: 5000 });

    // Delete confirm names the host and the consequence.
    await page.click('[data-ssh-host-row="lab-01"] > summary');
    await page.click('[data-ssh-host-row="lab-01"] [data-ssh-delete]');
    await page.waitForSelector('[role="alertdialog"]');
    await shot(name('delete-confirm', theme, width));
    await page.locator('[role="alertdialog"] [data-confirm-action="confirm"]').click();
    await page.waitForSelector('[data-ssh-host-row="lab-01"]', { state: 'detached', timeout: 5000 });
  }

  async function composer(theme, width) {
    await openSession('session_ssh_hosts');
    await page.waitForSelector('[data-composer-ssh-chip]', { timeout: 10_000 });
    const chips = await page.locator('[data-composer-ssh-chip]').count();
    expect(chips === 3, `expected 3 session chips, saw ${chips}`);
    await shot(name('composer-chips', theme, width));
    await page.click('[data-add-menu-trigger]');
    await page.click('[data-add-menu-ssh]');
    await page.waitForSelector('[data-composer-ssh-panel]');
    await page.waitForTimeout(250);
    await shot(name('composer-panel', theme, width));
    // Tick a host (PUT) then close; the chip row grows.
    await page.click('[data-composer-ssh-host="dev"]');
    await page.waitForSelector('[data-composer-ssh-host="dev"][aria-checked="true"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-composer-ssh-chip="dev"]', { timeout: 5000 });
    // Remove the temporary target from its chip (DELETE).
    await page.click('[data-composer-ssh-chip="ubuntu@10.0.0.9"] [data-composer-ssh-chip-remove]');
    await page.waitForSelector('[data-composer-ssh-chip="ubuntu@10.0.0.9"]', { state: 'detached', timeout: 5000 });
    await shot(name('composer-chips-after', theme, width));
  }

  async function approvals(theme, width) {
    // Password sign-in.
    await openSession('session_ssh_password');
    await page.waitForSelector('[data-ssh-approval="connect"]', { timeout: 10_000 });
    await shot(name('card-connect', theme, width));
    await page.click('[data-ssh-method="password"]');
    await page.fill('[data-ssh-password]', 'fixture-password');
    await page.click('[data-ssh-save="session"]');
    await actionsVisible('password');
    await shot(name('card-password', theme, width));
    await page.click('[data-ssh-submit]');
    const pw = await lastSubmission('approval_ssh_pw');
    expect(pw.decision === 'approved' && pw.credential?.password === 16 && pw.credential?.save === 'session',
      `password submission shape wrong: ${JSON.stringify(pw)}`);

    // Key file + passphrase, default save scope (workspace).
    await openSession('session_ssh_key');
    await page.waitForSelector('[data-ssh-approval="connect"]', { timeout: 10_000 });
    await page.click('[data-ssh-method="keyFile"]');
    await page.fill('[data-ssh-key-path]', '~/.ssh/id_lab');
    await page.fill('[data-ssh-passphrase]', 'hunter22');
    await actionsVisible('key file');
    await shot(name('card-key', theme, width));
    // Paste key: the tallest variant (textarea + passphrase + save scope).
    await page.click('[data-ssh-method="keyText"]');
    await page.fill('[data-ssh-key-text]', '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----');
    await actionsVisible('paste key');
    await shot(name('card-paste', theme, width));
    await page.click('[data-ssh-method="keyFile"]');
    await page.click('[data-ssh-submit]');
    const key = await lastSubmission('approval_ssh_key');
    expect(key.credential?.privateKeyPath === 13 && key.credential?.passphrase === 8 && key.credential?.save === 'workspace',
      `key submission shape wrong: ${JSON.stringify(key)}`);

    // Keyboard-interactive: two rounds.
    await openSession('session_ssh_otp');
    await page.waitForSelector('[data-ssh-approval="prompts"]', { timeout: 10_000 });
    await actionsVisible('otp round 1');
    await shot(name('card-otp-1', theme, width));
    await page.fill('[data-ssh-prompt="0"]', 'pw-round-one');
    await page.click('[data-ssh-submit]');
    const first = await lastSubmission('approval_ssh_otp1');
    expect(JSON.stringify(first.credential?.answers) === '[12]', `round 1 answers wrong: ${JSON.stringify(first)}`);
    await page.waitForSelector('[data-ssh-approval-id="approval_ssh_otp2"] [data-ssh-prompt="0"]', { timeout: 10_000 });
    await page.fill('[data-ssh-prompt="0"]', '482913');
    await actionsVisible('otp round 2');
    await shot(name('card-otp-2', theme, width));
    await page.click('[data-ssh-submit]');
    const second = await lastSubmission('approval_ssh_otp2');
    expect(JSON.stringify(second.credential?.answers) === '[6]' && second.credential?.save === undefined,
      `round 2 answers wrong: ${JSON.stringify(second)}`);

    // First-seen host key: no credential fields, trust sends a bare decision.
    await openSession('session_ssh_hostkey');
    await page.waitForSelector('[data-ssh-approval="host_key"]', { timeout: 10_000 });
    const credentialInputs = await page.locator('[data-ssh-approval="host_key"] input').count();
    expect(credentialInputs === 0, 'host-key card must not render credential inputs');
    await actionsVisible('host key');
    await shot(name('card-hostkey', theme, width));
    await page.click('[data-ssh-submit]');
    const trust = await lastSubmission('approval_ssh_hostkey');
    expect(trust.decision === 'approved' && trust.credential === undefined, `host-key submission wrong: ${JSON.stringify(trust)}`);

    // Changed key: engine refuses; the session shows the failed call, no card.
    await openSession('session_ssh_changed');
    await page.waitForTimeout(600);
    const cards = await page.locator('[data-ssh-approval]').count();
    expect(cards === 0, 'changed host key must not produce an approval card');
    await shot(name('changed-key', theme, width));
  }

  return async function walk() {
    // Theme and width come from the job (registry `matrix`): one pass each.
    const { theme, width } = view;
    await reset();
    await settings(theme, width);
    await reset();
    await composer(theme, width);
    await reset();
    await approvals(theme, width);
    // Short desktop: the sign-in forms must still reach their buttons. It is a
    // 1440-only probe of a second viewport, so it rides the desktop job.
    if (width === 1440) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(300);
      await reset();
      await approvals(theme, '1280x720');
      // Narrow: the fingerprint panel and the switch have to stay readable and
      // reachable at phone width, where the row grid leaves the least room.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await reset();
      await open('/settings/ssh', '[data-ssh-host-row]');
      await page.click('[data-ssh-host-row="gpu-box"] > summary');
      await page.click('[data-ssh-host-row="gpu-box"] [data-ssh-host-keys-toggle]');
      await page.waitForSelector('[data-ssh-host-row="gpu-box"] [data-ssh-host-keys][data-state="recorded"]', { timeout: 10_000 });
      await page.locator('[data-ssh-host-row="gpu-box"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(name('host-keys-narrow', theme, 390));
      await page.locator('#st-card-ssh-connection').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(name('settings-connection-narrow', theme, 390));
    }
  };
}
