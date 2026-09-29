/**
 * Visual-proof walker for native SSH (fixture `native-ssh`):
 *
 *   Settings › SSH hosts: list, an open Kiki row, an open config row, the
 *   add form (with validation), the delete confirm; connection switches.
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

export function createNativeSshWalker({ page, shot, resizeViewport, setProofTheme, control, webUrl, fixtureUrl, fixtureToken, locale }) {
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
    await open(`/s/${sessionId}`, '[data-composer-variant="main"] textarea');
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
    for (const theme of ['light', 'dark']) {
      await setProofTheme(theme);
      for (const width of [1440, 390]) {
        await resizeViewport(width);
        await reset();
        await settings(theme, width);
        await reset();
        await composer(theme, width);
        await reset();
        await approvals(theme, width);
      }
    }
    // Short desktop: the sign-in forms must still reach their buttons.
    for (const theme of ['light', 'dark']) {
      await setProofTheme(theme);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(300);
      await reset();
      await approvals(theme, '1280x720');
    }
    await setProofTheme('light');
    await resizeViewport(1440);
  };
}
