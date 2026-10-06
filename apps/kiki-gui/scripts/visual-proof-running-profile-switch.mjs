/**
 * running-profile-switch proof (fixture `running-profile-switch`):
 *
 *   Start a long turn, then — while it is still running — open the profile
 *   chip, browse the catalog, and switch to another profile. The chip must not
 *   be locked; picking a different profile asks once; the dialog names the
 *   profile, says it lands on the next message, and says the running turn is
 *   untouched. Confirming shows the pick as pending without applying it. The
 *   next user message carries the new profile.
 *
 * Desktop 1440, plus the open picker at mobile 390.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'running-profile-switch', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{
    name: 'running-profile-switch',
    fixture: 'running-profile-switch',
    run: async ({ page, shot, control, link }) => {
      await page.goto(link('/s/session_fixture_profile_switch'));
      await page.waitForSelector('#composer-agent-profile-select', { timeout: 30_000 });

      // Put a real turn in flight first: the scenario's turn never ends, so
      // everything below happens while kiki is working.
      await page.fill('[data-composer-variant="main"] textarea', 'Start the long migration job');
      await page.click('[data-send-ready]');
      // The composer swaps its placeholder while it works: that is the honest
      // 'a turn is running' signal this proof needs.
      await page.waitForFunction(
        () => (document.querySelector('textarea[data-composer]')?.placeholder ?? '').toLowerCase().includes('while it works'),
        null, { timeout: 30_000 },
      );
      await page.waitForTimeout(600);

      const trigger = page.locator('#composer-agent-profile-select');
      assert(!(await trigger.isDisabled()), 'the profile chip is locked while a turn runs');
      await shot('running-chip-browsable');

      // Browsing is not a switch: the whole catalog opens, and dismissing it
      // leaves the binding exactly as it was.
      await trigger.click();
      await page.waitForSelector('#composer-agent-profile-select-list [role="option"]', { timeout: 10_000 });
      const options = await page.locator('#composer-agent-profile-select-list [role="option"]').allTextContents();
      assert(options.some((text) => text.includes('reviewer')), `the picker did not list a second profile: ${JSON.stringify(options)}`);
      await page.waitForTimeout(400);
      await shot('running-picker-open');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const bound = (await trigger.innerText()).trim();
      assert(!/next message/i.test(bound), `browsing left a pending mark behind: ${bound}`);

      // Picking a different profile asks once.
      await trigger.click();
      await page.waitForSelector('#composer-agent-profile-select-list [role="option"]', { timeout: 10_000 });
      await page.locator('#composer-agent-profile-select-list [role="option"]').filter({ hasText: 'reviewer' }).first().click();
      await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
      const dialog = await page.locator('[role="alertdialog"]').first().innerText();
      assert(dialog.includes('reviewer'), `the confirmation does not name the profile: ${dialog}`);
      assert(/next message/i.test(dialog), `the confirmation does not say when it applies: ${dialog}`);
      assert(/running now/i.test(dialog), `the confirmation does not answer the running-turn question: ${dialog}`);
      await page.waitForTimeout(300);
      await shot('running-switch-confirm');

      await page.locator('[role="alertdialog"] button').filter({ hasText: 'Switch profile' }).first().click();
      await page.waitForTimeout(400);
      // Pending reads as pending, in words — not as already applied.
      const pending = (await trigger.innerText()).trim();
      assert(/next message/i.test(pending), `the pending chip does not say it is pending: ${pending}`);
      assert(pending.includes('reviewer'), `the pending chip does not name the profile: ${pending}`);
      await shot('running-switch-pending');

      // The turn that was running was not interrupted by the confirmation.
      // The composer is the product surface under test, so 'still working' is
      // read from it: its placeholder is what a user actually sees.
      const stillWorking = await page.evaluate(
        () => (document.querySelector('textarea[data-composer]')?.placeholder ?? '').toLowerCase().includes('while it works'),
      );
      assert(stillWorking, 'the running turn stopped when the switch was confirmed');

      // The next user message carries the new profile.
      await page.fill('[data-composer-variant="main"] textarea', 'Now answer as the reviewer');
      await page.click('[data-send-ready]');
      await page.waitForTimeout(1200);
      const after = await control({ action: 'session', session_id: 'session_fixture_profile_switch' });
      const carried = after.data.last_prompt_submission;
      assert(carried?.profile === 'reviewer', `the next message did not carry the profile: ${JSON.stringify(carried)}`);
      await page.waitForTimeout(500);
      await shot('running-switch-applied');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.locator('#composer-agent-profile-select').click();
      await page.waitForSelector('#composer-agent-profile-select-list [role="option"]', { timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot('running-picker-open-mobile');
    },
  }],
});
if (result.failed.length > 0) process.exitCode = 1;
