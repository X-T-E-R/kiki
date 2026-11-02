import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'thread-cleanup', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{ name: 'thread-cleanup', run: async ({ page, view, link, control, shot }) => {
    const id = 'session_cleanup_fixture';
    const label = view.locale === 'zh' ? '进程清理待确认' : 'Process cleanup unconfirmed';
    await page.goto(link('/s/session_idle_fixture'));
    const row = page.locator(`[data-session-row="${id}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute('data-session-row-state'), 'cleanup-pending');
    assert.ok((await row.innerText()).includes(label));
    assert.equal(await page.locator('[data-session-row="session_running_fixture"]').getAttribute('data-session-row-state'), 'running');
    const input = page.locator('[data-composer-session="session_idle_fixture"]');
    await input.fill(`/s/${id} `);
    const chip = page.locator(`[data-thread-ref-chip="${id}"]`).first();
    await chip.waitFor();
    assert.equal(await chip.getAttribute('data-thread-ref-status'), 'cleanup_pending');
    assert.ok((await chip.getAttribute('title')).includes(label));
    await shot('thread-cleanup-pending');
    await control({ action: 'emit_event', session_id: id, frame: {
      type: 'event.session.work_changed', payload: {
        busy: false, executing: false, main_turn_active: false, cleanup_pending: false,
        pending_interaction: 'none', last_turn_reason: 'completed',
      },
    } });
    await page.waitForFunction((id) => document.querySelector(`[data-session-row="${id}"]`)?.getAttribute('data-session-row-state') !== 'cleanup-pending', id);
    await page.waitForFunction((id) => document.querySelector(`[data-thread-ref-chip="${id}"]`)?.getAttribute('data-thread-ref-status') === 'idle', id);
    assert.ok(!(await row.innerText()).includes(label));
    await shot('thread-cleanup-confirmed');
    await page.route(/\/api\/sessions\?/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.items = body.data.items.filter((session) => session.id !== id);
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await input.fill(`/s/${id} `);
    await page.waitForFunction((id) => document.querySelector(`[data-thread-ref-chip="${id}"]`)?.getAttribute('data-thread-ref-status') === 'idle', id);
    assert.equal(await row.count(), 0);
    await control({ action: 'emit_event', session_id: id, frame: {
      type: 'event.session.work_changed', payload: {
        busy: true, executing: false, main_turn_active: false, cleanup_pending: true,
        pending_interaction: 'none', last_turn_reason: 'completed',
      },
    } });
    await page.waitForFunction((id) => document.querySelector(`[data-thread-ref-chip="${id}"]`)?.getAttribute('data-thread-ref-status') === 'cleanup_pending', id);
    await shot('thread-cleanup-fetched-reference');
  } }, { name: 'thread-cleanup-priority', fixture: 'thread-cleanup', run: async ({ page, link, control, shot }) => {
    const id = 'session_cleanup_fixture';
    await page.goto(link('/s/session_idle_fixture'));
    const row = page.locator(`[data-session-row="${id}"]`);
    await row.waitFor();
    await page.locator('[data-composer-session="session_idle_fixture"]').fill(`/s/${id} `);
    const assertStatus = async (rowState, refStatus) => {
      await page.waitForFunction(({ id, rowState, refStatus }) =>
        document.querySelector(`[data-session-row="${id}"]`)?.getAttribute('data-session-row-state') === rowState &&
        document.querySelector(`[data-thread-ref-chip="${id}"]`)?.getAttribute('data-thread-ref-status') === refStatus,
      { id, rowState, refStatus });
    };
    await assertStatus('cleanup-pending', 'cleanup_pending');
    for (const [pending, rowState, refStatus] of [
      ['question', 'needs-me', 'awaiting_answer'],
      ['approval', 'needs-me', 'awaiting_approval'],
      ['none', 'cleanup-pending', 'cleanup_pending'],
    ]) {
      await control({ action: 'emit_event', session_id: id, frame: {
        type: 'event.session.work_changed', payload: {
          busy: true, executing: true, main_turn_active: true, cleanup_pending: true,
          pending_interaction: pending, last_turn_reason: 'completed',
        },
      } });
      await assertStatus(rowState, refStatus);
    }
    await shot('thread-cleanup-priority');
  } }],
});
if (result.failed.length > 0) process.exitCode = 1;
