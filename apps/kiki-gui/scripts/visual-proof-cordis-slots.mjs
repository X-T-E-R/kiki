/**
 * visual-proof-cordis-slots — Headless Playwright visual verification for
 * Cordis Track A (E12 8 declarative GUI extension slots).
 *
 * Exercises all 8 declarative slot surfaces across light/dark x en/zh x
 * wide(1440)/narrow(390) when invoked with `--matrix=all`, asserting zero
 * horizontal overflow and zero uncaught page errors.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'session_fixture_pipeline';

const CORDIS_SLOTS_PAYLOAD = {
  slots: [
    {
      slot: 'composer-toolbar',
      pluginId: 'cordis-git',
      id: 'stage-review',
      label: { default: 'Stage review', zh: '暂存审阅' },
      tooltip: { default: 'Insert staged hunk review prompt', zh: '插入暂存区变更审阅指令' },
      badgeText: '3',
      tone: 'accent',
      order: 10,
      action: {
        kind: 'insert_prompt',
        text: 'Review staged hunks carefully.',
        submit: false,
      },
    },
    {
      slot: 'composer-toolbar',
      pluginId: 'cordis-lsp',
      id: 'symbol-check',
      label: { default: 'Workspace symbols', zh: '工作区符号' },
      tone: 'neutral',
      order: 20,
      action: {
        kind: 'invoke_plugin_route',
        method: 'POST',
        subpath: '/reindex',
      },
    },
    {
      slot: 'status-capsule',
      pluginId: 'cordis-lsp',
      id: 'tsserver',
      label: { default: 'TS Server', zh: '类型服务' },
      valueText: '12ms',
      dotTone: 'ok',
      order: 10,
      action: {
        kind: 'open_settings_section',
        sectionId: 'plugins',
      },
    },
    {
      slot: 'message-action',
      pluginId: 'cordis-notes',
      id: 'pin-answer',
      label: { default: 'Save to notes', zh: '存入笔记' },
      appliesToRoles: ['assistant'],
      order: 10,
      action: {
        kind: 'invoke_plugin_route',
        method: 'POST',
        subpath: '/notes/pin',
      },
    },
    {
      slot: 'slash-command',
      pluginId: 'cordis-git',
      id: 'commit-draft',
      command: 'commit-draft',
      description: { default: 'Draft a clean commit summary from staged diff', zh: '根据暂存差异生成干净的提交摘要' },
      argumentHint: { default: '[scope]', zh: '[范围]' },
      needsSession: false,
      action: {
        kind: 'insert_prompt',
        text: 'Draft a commit message for $ARGUMENTS',
        submit: false,
      },
    },
    {
      slot: 'settings-section',
      pluginId: 'cordis-lsp',
      id: 'language-servers',
      title: { default: 'Language server indexing', zh: '语言服务索引' },
      subtitle: { default: 'Background workspace symbol graph and diagnostics', zh: '后台工作区符号图谱与静态诊断' },
      order: 10,
    },
    {
      slot: 'tool-card-renderer',
      pluginId: 'cordis-lsp',
      id: 'write-renderer',
      toolNames: ['Write'],
      actionVerb: { default: 'Write artifact', zh: '写入产物' },
      targetFieldPath: 'args.file_path',
      summaryFields: [
        { label: { default: 'Target', zh: '目标路径' }, sourcePath: 'args.file_path', format: 'file-path' },
        { label: { default: 'Outcome', zh: '执行结果' }, sourcePath: 'result', format: 'badge' },
      ],
      detailFields: [
        { label: { default: 'Written content', zh: '写入内容' }, sourcePath: 'args.content', format: 'code' },
      ],
    },
    {
      slot: 'sidebar-panel',
      pluginId: 'cordis-git',
      id: 'worktree-lens',
      panelId: 'worktree-lens',
      title: { default: 'Worktree Lens', zh: '工作树视图' },
      bridge: 'kiki.panel.v1',
      order: 10,
    },
    {
      slot: 'inspector-tab',
      pluginId: 'cordis-lsp',
      id: 'symbol-outline',
      panelId: 'symbol-outline',
      title: { default: 'Symbol Outline', zh: '符号大纲' },
      bridge: 'kiki.panel.v1',
      order: 10,
    },
  ],
};

const result = await runProof({
  root,
  label: 'cordis-slots',
  argv: process.argv.slice(2),
  jobTimeoutMs: 120_000,
  scenarios: [
    {
      name: 'cordis-slots',
      fixture: 'tool-pipeline',
      matrix: ['theme', 'width'],
      run: async ({ page, view, link, shot }) => {
        await page.route('**/api/plugins/gui-slots**', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 0,
              msg: 'success',
              data: CORDIS_SLOTS_PAYLOAD,
              request_id: 'req-cordis-slots-proof',
            }),
          });
        });

        await page.route('**/api/plugins/*/routes/**', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 0,
              msg: 'success',
              data: { ok: true },
              request_id: 'req-cordis-route-proof',
            }),
          });
        });

        await page.goto(link(`/s/${SID}`));
        await page.locator('[data-plugin-composer-slots]').waitFor();
        await page.locator('[data-plugin-status-capsules]').waitFor({ state: 'attached' });

        // Unfold the settled history steps ("Worked 3 steps") so the Write tool card appears.
        const historyFoldToggle = page
          .locator('[data-history-fold]:not([data-history-fold-open]) [data-activity-toggle]')
          .first();
        if ((await historyFoldToggle.count()) > 0 && (await historyFoldToggle.isVisible())) {
          await historyFoldToggle.click();
        }
        await page.locator('[data-plugin-tool-renderer="cordis-lsp:write-renderer"]').waitFor();

        // Expand the plugin-rendered ToolCard (Slot 6) via its label so we don't hit the FilePathLink inside it.
        await page
          .locator('[data-plugin-tool-renderer="cordis-lsp:write-renderer"] [data-activity-label]')
          .first()
          .click();
        await page.locator('[data-plugin-tool-card="cordis-lsp:write-renderer"]').waitFor();

        if (view.width >= 1024) {
          await page.locator('[data-plugin-sidebar-panel="cordis-git:worktree-lens"]').waitFor();
          await page.locator('[data-plugin-inspector-tab="cordis-lsp:symbol-outline"]').waitFor();
        }

        const assertNoHorizontalOverflow = async () => {
          const ok = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          );
          assert.ok(ok, 'Expected zero horizontal overflow');
        };

        await assertNoHorizontalOverflow();
        await shot('cordis-session-slots');

        // Reveal Slot 3 (message-action) inside the final assistant message's overflow menu.
        const lastAssistantRow = page.locator('[data-assistant-prose]').last();
        if (view.width >= 640) {
          await lastAssistantRow.hover();
        } else {
          await lastAssistantRow.click();
        }
        const moreBtn = page.locator('[data-row-more]').last();
        await moreBtn.click({ force: true });
        await page.locator('[data-plugin-message-action="cordis-notes:pin-answer"]').last().waitFor();
        await assertNoHorizontalOverflow();
        await shot('cordis-message-action');
        await page.keyboard.press('Escape');

        // Open Slash menu (Slot 4) and verify plugin slash command renders cleanly.
        const editor = page.locator('textarea, [contenteditable="true"]').first();
        await editor.click();
        await editor.fill('/commit');
        await page.locator('[role="listbox"] [role="option"]').first().waitFor();
        await assertNoHorizontalOverflow();
        await shot('cordis-slash-menu');

        await editor.fill('');

        // Open Settings -> Plugins to verify Slot 5 declarative SectionCard.
        await page.goto(link('/settings/plugins'));
        await page.locator('[data-settings-card="st-card-plugin-slot-cordis-lsp-language-servers"]').waitFor();
        await assertNoHorizontalOverflow();
        await shot('cordis-settings-slot');
      },
    },
  ],
});

if (result.failed > 0) {
  process.exitCode = 1;
}
