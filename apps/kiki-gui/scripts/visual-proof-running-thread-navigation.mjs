import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'running-thread-navigation', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{ name: 'running-thread-navigation', run: async ({ page, link, control, shot }) => {
    const input = page.locator('textarea[data-composer-session]');
    async function current(id) {
      await page.waitForURL((url) => url.pathname === `/s/${id}`);
      await page.waitForFunction((id) => {
        const node = document.activeElement;
        return node instanceof HTMLTextAreaElement && node.dataset.composerSession === id && !node.disabled;
      }, id);
    }
    await page.goto(link('/s/idle-pinned'));
    await current('idle-pinned');
    await input.fill('Reference draft');
    await page.keyboard.press('Control+F6');
    await current('running-a');
    await input.fill('A draft survives navigation');
    await input.evaluate((node) => { node.setSelectionRange(2, 7, 'backward'); node.dispatchEvent(new Event('select', { bubbles: true })); });
    for (const id of ['running-b', 'running-c', 'running-a']) {
      await page.keyboard.press('Control+F6');
      await current(id);
    }
    assert.equal(await input.inputValue(), 'A draft survives navigation');
    assert.deepEqual(await input.evaluate((node) => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [2, 7, 'backward']);
    for (const id of ['running-c', 'running-b', 'running-a']) {
      await page.keyboard.press('Control+Shift+F6');
      await current(id);
    }
    await shot('running-thread-cycle-focus');
    // Plain Tab, IME and a browser-owned chord are not application navigation.
    await page.keyboard.press('Tab');
    assert.equal(new URL(page.url()).pathname, '/s/running-a');
    await input.focus();
    await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', ctrlKey: true, isComposing: true, bubbles: true })));
    assert.equal(new URL(page.url()).pathname, '/s/running-a');
    await page.keyboard.press('Control+Tab');
    assert.equal(new URL(page.url()).pathname, '/s/running-a');
    // Ordinary sidebar navigation focuses the new endpoint, without losing the old draft.
    await page.locator('[data-session-row="idle-pinned"] [data-session-title]').click();
    await current('idle-pinned');
    assert.equal(await input.inputValue(), 'Reference draft');
    await page.keyboard.press('Control+Shift+F6');
    await current('running-c');
    // Work changes come through the existing global event/list refresh path.
    const work = async (id, busy) => {
      const refreshed = page.waitForResponse((response) => response.url().includes('/api/sessions?') && response.status() === 200);
      await control({ action: 'emit_event', session_id: id, frame: { type: 'event.session.work_changed', payload: { busy, pending_interaction: 'none' } } });
      await refreshed;
    };
    await work('running-b', false);
    await page.keyboard.press('Control+F6');
    await current('running-a');
    await page.keyboard.press('Control+F6');
    await current('running-c');
    await work('running-a', false);
    await page.keyboard.press('Control+F6');
    await current('running-c');
    await work('running-c', false);
    await page.keyboard.press('Control+Shift+F6');
    await current('running-c');
    await work('idle-pinned', true);
    await page.keyboard.press('Control+F6');
    await current('idle-pinned');
    // An open real modal keeps its input focus and navigation chords do not dismiss it.
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[role="dialog"]');
    const before = new URL(page.url()).pathname;
    await page.keyboard.press('Control+F6');
    assert.equal(new URL(page.url()).pathname, before);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
    await page.locator('[role="dialog"] input').fill('Running B');
    await page.locator('[role="dialog"] [data-index]').filter({ hasText: 'Running B' }).first().click();
    await current('running-b');
    await page.keyboard.press('Control+F6');
    await current('idle-pinned');
    await shot('running-thread-single-candidate');
  } }],
});
if (result.failed.length > 0) process.exitCode = 1;
