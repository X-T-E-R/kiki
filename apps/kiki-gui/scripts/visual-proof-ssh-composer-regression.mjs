import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  argv: process.argv.slice(2), label: 'ssh-composer-regression', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{ name: 'ssh-composer-regression', fixture: 'ssh-composer-regression', run: async ({ page, shot, control, link, view }) => {
    await page.waitForSelector('[data-session-group="week"]');
    const headings = await page.locator('[data-session-group]').count();
    assert(headings >= 3, `expected multiple date groups, saw ${headings}`);
    const verifyGroups = async () => {
      const geometry = await page.evaluate(() => [...document.querySelectorAll('[data-session-group]')].map((header) => {
        const box = header.getBoundingClientRect();
        const rows = [...document.querySelectorAll('[data-session-title]')].map((row) => row.getBoundingClientRect());
        return { key: header.dataset.sessionGroup, position: getComputedStyle(header).position, height: box.height,
          overlaps: rows.filter((row) => box.y < row.bottom - 1 && box.bottom > row.y + 1).length };
      }));
      assert(geometry.every((entry) => entry.position !== 'sticky' && entry.height >= 28 && entry.overlaps === 0), JSON.stringify(geometry));
      console.log('Sidebar geometry:', JSON.stringify(geometry));
    };
    await verifyGroups();
    await shot('sidebar-date-groups-wide');
    const handle = await page.locator('[data-sidebar-resizer]').boundingBox();
    assert(handle !== null, 'sidebar resize handle missing');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 90, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.evaluate(() => { document.querySelector('[data-session-list]').scrollTop = 530; });
    await page.waitForTimeout(200);
    await verifyGroups();
    await shot('sidebar-date-groups-narrow-scrolled');
    await page.locator('[data-sidebar-resizer]').dblclick();
    await page.click('[data-add-menu-trigger]');
    await page.waitForSelector('[data-add-menu-ssh]');
    await shot('new-plus-ssh');
    await page.click('[data-add-menu-ssh]');
    await page.click('[data-composer-ssh-host="gpu-box"]');
    await page.waitForSelector('[data-composer-ssh-host="gpu-box"][aria-checked="true"]');
    await page.click('[data-add-menu-trigger]');
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"]');
    await page.fill('[data-composer-variant="main"] textarea', 'Inspect the SSH host');
    await shot('new-ssh-preselected-before-send');
    await page.click('[data-send-ready]');
    await page.waitForURL(/\/s\//);
    await page.waitForSelector('[data-user-ssh-host="gpu-box"]');
    const sid = new URL(page.url()).pathname.split('/').at(-1);
    const inspected = await control({ action: 'session', session_id: sid });
    const content = inspected.data.last_prompt_submission.content;
    assert(content.some((part) => part.type === 'text' && part.text.includes('<ssh_host_refs>')), 'missing prompt snapshot');
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"]');
    assert(await page.locator('[data-composer-ssh-scope]').textContent() === (view.locale === 'zh' ? '会话主机' : 'Session hosts'), 'persistent scope label missing');
    await shot('new-ssh-after-send-persistent-status-and-message');
    await page.goto(link(`/s/${sid}`));
    await page.waitForSelector('[data-user-ssh-host="gpu-box"]');
    await shot('ssh-message-snapshot-after-reload');
    await page.click('[data-composer-ssh-chip="gpu-box"] [data-composer-ssh-chip-remove]');
    await page.waitForSelector('[data-composer-ssh-chip="gpu-box"]', { state: 'detached' });
    assert(await page.locator('[data-user-ssh-host="gpu-box"]').count() === 1, 'historical snapshot changed on unjoin');
    await shot('ssh-after-unjoin-historical-snapshot');
    await page.goto(link('/s/session_ssh_hosts'));
    await page.waitForSelector('[data-composer-ssh-chip="staging"]');
    await page.fill('[data-composer-variant="main"] textarea', 'Check the joined hosts');
    await shot('existing-session-ssh-before-send');
    await page.click('[data-send-ready]');
    await page.waitForSelector('[data-user-ssh-host="staging"]');
    assert(await page.locator('[data-composer-ssh-chip]').count() === 3, 'persistent hosts cleared on send');
    await shot('existing-session-ssh-after-send');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('existing-session-ssh-after-send-mobile');
    await page.goto(link('/new'));
    await page.waitForSelector('[data-add-menu-trigger]');
    await page.click('[data-add-menu-trigger]');
    await page.waitForSelector('[data-add-menu-ssh]');
    await shot('new-plus-ssh-mobile');
  }}],
});
if (result.failed.length > 0) process.exitCode = 1;
