/**
 * bare-harness proof (fixture `bare-harness`):
 *
 *   The composer's execution control, at the position the profile picker used
 *   to hold. One panel carries both halves of the choice: the engine, and the
 *   optional profile of that engine. The first entry of every engine is the
 *   bare harness — run it as it is, with no Kiki profile. Picking a profile
 *   implies its engine. Then, while a turn runs, switch the engine: the chip
 *   must stay openable, the confirmation must name the engine and say what
 *   happens to the context and to the record, and the next message must carry
 *   the selection.
 *
 * Desktop 1440, plus the open panel at mobile 390.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'bare-harness', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{
    name: 'bare-harness',
    fixture: 'bare-harness',
    run: async ({ page, shot, control, link }) => {
      await page.goto(link('/s/session_fixture_bare_harness'));
      await page.waitForSelector('#composer-execution-select', { timeout: 30_000 });
      // The committed binding names what runs, before anything is picked.
      const resting = (await page.locator('#composer-execution-select').innerText()).trim();
      assert(/Kiki/.test(resting), `the chip does not name the bound engine: ${resting}`);

      // One panel, both halves. Every engine leads with its bare row, and a
      // profile appears only under the engine it belongs to.
      await page.click('#composer-execution-select');
      await page.waitForSelector('[data-execution-panel]', { timeout: 10_000 });
      const bare = await page.locator('[data-execution-bare]').evaluateAll(
        (rows) => rows.map((row) => row.getAttribute('data-execution-bare')),
      );
      assert(bare.length >= 3, `the panel did not offer every engine: ${JSON.stringify(bare)}`);
      assert(bare.includes('claude-acp') && bare.includes('codex-app-server'), `an external engine is missing: ${JSON.stringify(bare)}`);
      const nested = await page.locator('[data-execution-profile="claude-reviewer"]')
        .evaluate((row) => row.closest('[data-execution-engine]')?.getAttribute('data-execution-engine'));
      assert(nested === 'claude-acp', `the profile is not nested under its own engine: ${nested}`);
      await page.waitForTimeout(400);
      await shot('panel-open');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // Start a turn: the control must not lock, and a pick must say when it
      // lands rather than pretending it already did.
      await page.fill('[data-composer-variant="main"] textarea', 'Start the long migration job');
      await page.click('[data-send-ready]');
      await page.waitForFunction(
        () => (document.querySelector('textarea[data-composer]')?.placeholder ?? '').toLowerCase().includes('while it works'),
        null, { timeout: 30_000 },
      );
      const trigger = page.locator('#composer-execution-select');
      assert(!(await trigger.isDisabled()), 'the execution control is locked while a turn runs');
      assert(/next message/i.test(await trigger.getAttribute('title')), 'the busy tooltip does not say when a pick applies');
      await page.waitForTimeout(400);
      await shot('running-trigger');

      // Switching to a bare external engine asks once, and the dialog says the
      // two things a user is actually unsure about: a fresh context, and a
      // record that stays here.
      await trigger.click();
      await page.waitForSelector('[data-execution-bare="claude-acp"]', { timeout: 10_000 });
      await page.click('[data-execution-bare="claude-acp"]');
      await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
      const dialog = await page.locator('[role="alertdialog"]').first().innerText();
      assert(dialog.includes('Claude Code'), `the confirmation does not name the engine: ${dialog}`);
      assert(/next message/i.test(dialog), `the confirmation does not say when it applies: ${dialog}`);
      assert(/fresh context/i.test(dialog), `the confirmation does not say the context is new: ${dialog}`);
      assert(/stays here|remains readable/i.test(dialog), `the confirmation does not say the record is kept: ${dialog}`);
      assert(/running now/i.test(dialog), `the confirmation does not answer the running-turn question: ${dialog}`);
      await page.waitForTimeout(300);
      await shot('switch-confirm');

      await page.locator('[role="alertdialog"] button').filter({ hasText: 'Switch engine' }).first().click();
      await page.waitForTimeout(400);
      const pending = (await trigger.innerText()).trim();
      assert(/Claude Code/.test(pending), `the pending chip does not name the engine: ${pending}`);
      assert(/next message/i.test(pending), `the pending chip does not say it is pending: ${pending}`);
      // The switch is still cancelable in place: the chip carries the undo, so
      // changing one's mind does not mean reopening the panel.
      const cancel = page.locator('[data-execution-cancel-pending]');
      assert(await cancel.count() === 1, 'the pending chip offers no way to cancel the switch');
      await shot('switch-pending');

      // Cancelling puts the session back on the engine it is actually running.
      await cancel.click();
      await page.waitForTimeout(400);
      assert(
        await page.locator('[data-execution-pending="true"]').count() === 0,
        'the chip still reads pending after cancelling',
      );
      const afterCancel = (await trigger.innerText()).trim();
      assert(!/next message/i.test(afterCancel), `the cancelled switch is still announced: ${afterCancel}`);
      // Put it back so the next-message assertions below still describe a
      // confirmed switch.
      await trigger.click();
      await page.waitForSelector('[data-execution-panel]', { timeout: 10_000 });
      await page.locator('[data-execution-bare="claude-acp"]').first().click();
      await page.waitForTimeout(300);
      const confirmAgain = page.locator('[role="alertdialog"] button').filter({ hasText: 'Switch engine' }).first();
      if (await confirmAgain.count() > 0) {
        await confirmAgain.click();
        await page.waitForTimeout(400);
      }

      // Confirming did not interrupt the turn that was running.
      const stillWorking = await page.evaluate(
        () => (document.querySelector('textarea[data-composer]')?.placeholder ?? '').toLowerCase().includes('while it works'),
      );
      assert(stillWorking, 'the running turn stopped when the switch was confirmed');

      // The next user message carries the selection, and no model: a bare
      // engine keeps its own.
      await page.fill('[data-composer-variant="main"] textarea', 'Now answer as Claude Code');
      await page.click('[data-send-ready]');
      await page.waitForTimeout(1200);
      const after = await control({ action: 'session', session_id: 'session_fixture_bare_harness' });
      const carried = after.data.last_prompt_submission;
      assert(carried?.execution?.executor === 'claude-acp', `the next message did not carry the engine: ${JSON.stringify(carried)}`);
      assert(carried?.execution?.profile === undefined, `a bare engine invented a profile: ${JSON.stringify(carried)}`);
      assert(carried?.model === undefined, `the switch message carried a model: ${JSON.stringify(carried)}`);
      assert(carried?.thinking === undefined, `the switch message carried an effort: ${JSON.stringify(carried)}`);
      assert(carried?.permission_mode === undefined, `the switch message carried an approval mode: ${JSON.stringify(carried)}`);
      // The message AFTER the switch is the one that leaked before: no
      // generation is opening, so nothing absorbs the composer's display
      // values, and a bare engine must still receive none of them. The
      // committed binding rides the session, so the client re-sends no
      // selection at all — that is the correct shape for a continuation.
      await page.fill('[data-composer-variant="main"] textarea', 'And keep going as yourself');
      await page.click('[data-send-ready]');
      await page.waitForTimeout(1200);
      const continued = await control({ action: 'session', session_id: 'session_fixture_bare_harness' });
      const continuedPayload = continued.data.last_prompt_submission;
      assert(continuedPayload?.execution === undefined, `a bare continuation re-sent a selection: ${JSON.stringify(continuedPayload)}`);
      assert(continuedPayload?.model === undefined, `a bare continuation carried a model: ${JSON.stringify(continuedPayload)}`);
      assert(continuedPayload?.thinking === undefined, `a bare continuation carried an effort: ${JSON.stringify(continuedPayload)}`);
      assert(continuedPayload?.permission_mode === undefined, `a bare continuation carried an approval mode: ${JSON.stringify(continuedPayload)}`);
      // The server committed the switch, so the session still reads as the
      // external engine it was moved to.
      assert(
        continued.data.record?.agent_config?.execution?.selection?.executor === 'claude-acp',
        `the continuation did not run on the switched engine: ${JSON.stringify(continued.data.record?.agent_config?.execution)}`,
      );
      await page.waitForTimeout(500);
      await shot('switch-applied');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.locator('#composer-execution-select').click();
      await page.waitForSelector('[data-execution-panel]', { timeout: 10_000 });
      await page.waitForTimeout(400);
      // At 390px the panel must not run off the right edge, and every engine
      // row has to be reachable — a narrow viewport is exactly where the bare
      // hint is the only thing distinguishing two same-named engines.
      const panelBox = await page.locator('[data-execution-panel]').boundingBox();
      assert(panelBox !== null, 'the mobile panel has no box');
      assert(panelBox.x >= 0, `the mobile panel starts off-screen at x=${panelBox.x}`);
      assert(
        panelBox.x + panelBox.width <= 390,
        `the mobile panel runs past the viewport: right edge ${Math.round(panelBox.x + panelBox.width)}`,
      );
      const rows = page.locator('[data-execution-engine]');
      const rowCount = await rows.count();
      assert(rowCount > 0, 'the mobile panel lists no engines');
      for (let index = 0; index < rowCount; index += 1) {
        await rows.nth(index).scrollIntoViewIfNeeded();
        const rowBox = await rows.nth(index).boundingBox();
        assert(rowBox !== null, `engine row ${index} has no box on mobile`);
        assert(rowBox.x >= 0 && rowBox.x + rowBox.width <= 390, `engine row ${index} overflows at 390px`);
      }
      // Scrolled to the end, the last engine is fully inside the panel box
      // rather than hidden behind the footer.
      await page.locator('[data-execution-panel]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);
      const lastBox = await rows.nth(rowCount - 1).boundingBox();
      assert(lastBox !== null, 'the last engine row has no box on mobile');
      assert(
        lastBox.y + lastBox.height <= panelBox.y + panelBox.height + 1,
        `the last engine row is hidden behind the footer: row ends ${Math.round(lastBox.y + lastBox.height)}, panel ends ${Math.round(panelBox.y + panelBox.height)}`,
      );
      await shot('panel-open-mobile');
    },
  }],
});
if (result.failed.length > 0) process.exitCode = 1;
