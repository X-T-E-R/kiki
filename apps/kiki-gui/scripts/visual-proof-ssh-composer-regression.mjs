/**
 * Resident session-SSH walker (fixture `ssh-composer-regression`):
 *
 *   /new: preselect a host in the ＋ menu, see the strip, send. The created
 *   session already has the host (real PUT before the first message), the
 *   first prompt carries no host ref, the timeline draws no per-message host
 *   row, and the strip is still there afterwards.
 *   The joined list is read back from the server on reload and on a switch to
 *   another session, and unjoining takes effect immediately.
 *   A second send in the same session repeats none of the above.
 *
 * 1440 and 390. Shots go to KIKI_PROOF_OUTPUT_DIR (default
 * .tmp/visual-proof/<run-id>), prefixed with the proof locale.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'ssh-composer-regression', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{ name: 'ssh-composer-regression', fixture: 'ssh-composer-regression', run: async ({ page, shot, control, link, view }) => {
    const scopeLabel = view.locale === 'zh' ? '本会话 SSH' : 'Session SSH';
    const draftLabel = view.locale === 'zh' ? '待加入 SSH' : 'SSH to join';
    await page.waitForSelector('[data-session-group="week"]');

    await page.click('[data-add-menu-trigger]');
    await page.waitForSelector('[data-add-menu-ssh]');
    await shot('new-plus-ssh');
    await page.click('[data-add-menu-ssh]');
    await page.click('[data-composer-ssh-host="gpu-box"]');
    await page.waitForSelector('[data-composer-ssh-host="gpu-box"][aria-checked="true"]');
    await page.click('[data-add-menu-trigger]');
    // The draft strip names the join, not a message part.
    await page.waitForSelector(`[data-composer-ssh-strip]:has-text("${draftLabel}")`);
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"]');
    await page.fill('[data-composer-variant="main"] textarea', 'Inspect the SSH host');
    await shot('new-ssh-preselected-before-send');

    await page.click('[data-send-ready]');
    await page.waitForURL(/\/s\//);
    const sid = new URL(page.url()).pathname.split('/').at(-1);
    // The first message must not carry the host: the session already has it.
    await page.waitForSelector('[data-transcript-lane="user"] .bg-bubble-user');
    const inspected = await control({ action: 'session', session_id: sid });
    const text = (inspected.data.last_prompt_submission.content ?? [])
      .filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    assert(!text.includes('ssh_host_refs'), `first prompt serialized a host ref: ${text}`);
    assert(!text.includes('gpu-box'), `first prompt named the host: ${text}`);
    assert((await page.locator('[data-user-ssh-host]').count()) === 0, 'timeline drew a per-message host row');
    assert((await page.locator('.bg-bubble-user').first().textContent()).includes('Inspect the SSH host'), 'first message missing');

    // Resident: the strip reads the joined list back after the send. The
    // handoff runs before the session view mounts its own strip, so wait on
    // the control itself; the card may be taken over by a decision, which
    // hides the strip from view without removing it. The chip carries the host
    // ID as its attribute and the host NAME as its text, so match on the id.
    await page.waitForSelector('[data-composer-ssh-strip]');
    await page.waitForSelector('[data-composer-ssh-strip] [data-composer-ssh-chip="gpu-box"]', { state: 'attached', timeout: 20_000 });
    assert((await page.locator(`[data-composer-ssh-strip]:has-text("${scopeLabel}")`).count()) === 1, 'strip does not name the session scope');
    await shot('session-ssh-resident-after-send');

    // A second message repeats no ref and no row.
    await page.fill('[data-composer-variant="main"] textarea', 'Now the build');
    await page.click('[data-send-ready]');
    await page.waitForFunction(() => document.querySelectorAll('[data-transcript-lane="user"] .bg-bubble-user').length >= 2, null, { timeout: 15_000 });
    const afterSecond = await control({ action: 'session', session_id: sid });
    const secondText = (afterSecond.data.last_prompt_submission.content ?? [])
      .filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    assert(!secondText.includes('ssh_host_refs') && !secondText.includes('gpu-box'), `second prompt carried the host: ${secondText}`);
    assert((await page.locator('[data-user-ssh-host]').count()) === 0, 'timeline drew a host row on the second message');
    assert((await page.locator('[data-composer-ssh-strip] [data-composer-ssh-chip="gpu-box"]').count()) === 1, 'the strip lost its host after the second send');
    await shot('session-ssh-resident-after-second-send');

    // The strip opens its own list without a second page.
    await page.click('[data-composer-ssh-toggle]');
    await page.waitForSelector('[data-composer-ssh-list] [data-composer-ssh-panel]');
    await shot('session-ssh-strip-list-open');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-composer-ssh-list]', { state: 'detached' });

    // Reopen: the joined list comes from the server, not from this window.
    await page.goto(link(`/s/${sid}`));
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"]');
    await shot('session-ssh-after-reload');

    // Unjoining is authoritative at once.
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"] [data-composer-ssh-chip-remove]');
    await page.click('[data-composer-ssh-chip="gpu-box"] [data-composer-ssh-chip-remove]');
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-ssh-chip]').length === 0, null, { timeout: 15_000 });
    assert((await page.locator('[data-user-ssh-host]').count()) === 0, 'timeline drew a host row');
    await shot('session-ssh-after-unjoin');

    // Another session shows its own list: switching re-reads the server.
    await page.goto(link('/s/session_ssh_hosts'));
    await page.waitForSelector('[data-composer-ssh-chip="staging"]');
    assert((await page.locator('[data-composer-ssh-chip]').count()) === 3, 'expected the other session three joined hosts');
    await page.fill('[data-composer-variant="main"] textarea', 'Check the joined hosts');
    await shot('existing-session-ssh-before-send');
    await page.click('[data-send-ready]');
    await page.waitForFunction(() => document.querySelectorAll('[data-transcript-lane="user"] .bg-bubble-user').length >= 1, null, { timeout: 15_000 });
    assert((await page.locator('[data-composer-ssh-chip]').count()) === 3, 'joined hosts cleared on send');
    assert((await page.locator('[data-user-ssh-host]').count()) === 0, 'timeline drew a host row');
    await shot('existing-session-ssh-after-send');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await shot('existing-session-ssh-after-send-mobile');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(link('/new'));
    await page.waitForSelector('[data-add-menu-trigger]');
    await page.click('[data-add-menu-trigger]');
    await page.waitForSelector('[data-add-menu-ssh]');
    await page.click('[data-add-menu-ssh]');
    await page.click('[data-composer-ssh-host="gpu-box"]');
    await page.click('[data-add-menu-trigger]');
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"]');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await shot('new-ssh-strip-mobile');
  }}],
});
if (result.failed.length > 0) process.exitCode = 1;
