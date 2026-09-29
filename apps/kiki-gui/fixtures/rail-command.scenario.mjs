/**
 * rail-command — a long orchestrator session for the right-rail variants
 * (`?rail=a|b|c|d`, see src/components/rail-variants/).
 *
 * Shaped after a real 40-hour main-agent session: one main agent coordinating
 * owners across four model families (Opus frontend owners, Sol general
 * owners, Luna workers, DeepSeek explorers under an owner), most of them
 * reported back hours ago, eight still in flight, two parked on approvals
 * and one on a question. The main timeline carries the user's recent
 * prompts and six context compactions.
 *
 * Fixture-server data only (see helpers.mjs, fixture-transcript.mjs).
 */

import { sessionRecord, ts } from './helpers.mjs';
import railScale from './rail-scale.scenario.mjs';


const MODEL = {
  opus: 'anthropic/claude-opus-5-5',
  sol: 'axon/gpt-6-sol',
  luna: 'axon/gpt-5.6-luna',
  ds: 'deepseek-v4-flash',
};
const EFFORT = { opus: 'xhigh', sol: 'xhigh', luna: 'max', ds: 'max' };

// [id, label, description, family, profile, status, parent, startedAgo, endedAgo, summary]
// `null` endedAgo = still in flight. Minutes are relative to "now".
const ROWS = [
  ['agent-150', 'ssh_gui', 'SSH GUI', 'opus', 'frontend', 'completed', 'main', 980, 930, 'SSH profiles, login card and remote workspace picker landed.'],
  ['agent-152', 'worktree_b1', 'Worktree isolation B1', 'sol', 'general', 'completed', 'main', 940, 870, 'Worktree create/archive over REST, with tests.'],
  ['agent-156', 'relay_b1', 'Relay compaction B1-B3', 'sol', 'general', 'completed', 'main', 900, 810, 'Fresh relay compaction wired end to end.'],
  ['agent-160', 'rail_v4', 'Right rail redesign v4', 'opus', 'frontend', 'completed', 'main', 860, 790, 'Rail v4: profile card, needs-you block, roster.'],
  ['agent-163', 'ctx_strategy_gui', 'Context strategy panel GUI', 'opus', 'frontend', 'completed', 'main', 800, 740, 'Strategy panel and compaction markers in the GUI.'],
  ['agent-166', 'i18n_zh_01', 'Translate zh chunks 01-02', 'luna', 'worker', 'completed', 'main', 720, 690, 'Two chunks translated against the glossary.'],
  ['agent-167', 'i18n_zh_03', 'Translate zh chunks 03-04', 'luna', 'worker', 'failed', 'main', 720, 700, undefined, 'Model request failed: 429 rate limited after 3 retries.'],
  ['agent-170', 'integration_review', 'Integration review of batch', 'opus', 'reviewer', 'completed', 'main', 640, 580, '4 findings; 2 blocking, both fixed by their owners.'],
  ['agent-174', 'isolation_design', 'Design Kiki instances/isolation', 'opus', 'think', 'completed', 'main', 560, 470, 'Design doc committed; B1-B8 slices defined.'],
  ['agent-179', 'paper_revert', 'Restore pre-9.23 paper palette', 'opus', 'frontend', 'cancelled', 'main', 420, 400, undefined],
  ['agent-180', 'test_arch', 'Redesign visual-proof & test tiers', 'opus', 'general', 'completed', 'main', 400, 330, 'Three tiers: unit, smoke, visual proof on demand.'],
  ['agent-182', 'rail_v6', 'Right rail full redesign', 'opus', 'frontend', 'completed', 'main', 390, 250, 'Rail v6 committed as one topic; screenshots in .tmp.'],
  ['agent-186', 'ref_panels', 'Reference side panel patterns', 'ds', 'explore', 'completed', 'agent-182', 380, 306, 'Side-panel patterns from eight donors, with paths.'],
  ['agent-183', 'composer_v5', 'Composer + transcript fixes', 'opus', 'frontend', 'failed', 'main', 360, 300, undefined, 'Stopped after the worktree changed under it: 3 files modified by another owner.'],
  ['agent-193', 'locate_map', 'Map timeline jump entry points', 'ds', 'explore', 'completed', 'agent-183', 340, 295, 'Every locate/jump entry point in the timeline, mapped.'],
  ['agent-192', 'img_rca', 'Image thumbnail root cause', 'ds', 'explore', 'completed', 'agent-183', 330, 281, 'The broken tile comes from the thumbnail cache key, not data: URLs.'],
  ['agent-187', 'runtime_audit', 'Memory/search/SelectTools audit', 'sol', 'general', 'cancelled', 'main', 330, 310, undefined],
  ['agent-188', 'memory_check', 'Why memory disabled by default', 'luna', 'worker', 'completed', 'main', 320, 299, 'Memory was off by a stale default; no code change needed.'],
  ['agent-191', 'selecttools_fix', 'SelectTools/CallTool failure', 'sol', 'general', 'completed', 'main', 330, 295, 'Hidden unusable dynamic tool controls; 7 files.'],
  ['agent-189', 'search_design', 'Global search redesign doc', 'opus', 'general', 'completed', 'main', 320, 271, 'Design doc written and committed.'],
  ['agent-196', 'gui_gap_scan', 'Config keys missing from GUI', 'ds', 'explore', 'completed', 'main', 290, 266, '31 config keys with no GUI surface, grouped by page.'],
  ['agent-198', 'mem_default_on', 'Memory enabled by default', 'luna', 'worker', 'completed', 'main', 290, 267, 'Memory now on by default; committed.'],
  ['agent-195', 'notes_review', 'Review TodoList notes vs fresh relay', 'opus', 'reviewer', 'completed', 'main', 280, 247, '笔记被整段替换而丢失；fresh 资格判定有两条误否决。'],
  ['agent-197', 'space_amend', 'Amend space design: in-window switch', 'opus', 'general', 'completed', 'main', 285, 249, '两种模式都做；文档已提交，未 push。'],
  ['agent-200', 'search_s0', 'Search S0: honest unavailable state', 'luna', 'worker', 'completed', 'main', 270, 246, '后端 S0 已提交：搜索不可用时如实说明。'],
  ['agent-201', 'cancel_provenance', 'Stopped-by-you mislabel + images', 'sol', 'general', 'completed', 'main', 280, 246, '两个 bug 已修复并验证，三个提交。'],
  ['agent-206', 'collapse_survey', 'Survey history collapse donors', 'ds', 'explore', 'completed', 'agent-203', 262, 245, 'codeg, Codex and Claude desktop fold rules, compared.'],
  ['agent-199', 'search_s1', 'Search S1: sqlite FTS5 core', 'sol', 'general', 'completed', 'main', 268, 229, 'S1 已提交：sqlite fts5 索引核心。'],
  ['agent-207', 'fresh_fix', 'Fresh relay eligibility + notes UX', 'sol', 'general', 'completed', 'main', 260, 229, '两个主题分别提交，未触碰其他 owner 的改动。'],
  ['agent-204', 'perm_rules_ui', 'Permission rules in GUI', 'sol', 'general', 'completed', 'main', 262, 227, '持久化权限规则已提交。'],
  ['agent-205', 'memory_ui2', 'Memory settings fully in GUI', 'sol', 'general', 'completed', 'main', 258, 224, '记忆设置全部进入 GUI，已提交。'],
  ['agent-210', 'search_s2', 'Search S2: incremental sync + WAL', 'sol', 'general', 'completed', 'main', 236, 201, 'S2 增量同步与 WAL 已提交，8 个文件。'],
  ['agent-209', 'space_b1', 'Space B1: home.toml + layered config', 'sol', 'general', 'completed', 'main', 232, 178, 'B1 后端已落地并提交。'],
  ['agent-202', 'composer_v6', 'Composer popovers/enter/status', 'opus', 'frontend', 'completed', 'main', 250, 171, 'composer 这一轮做完了，分 4 个提交。'],
  ['agent-203', 'timeline_v1', 'History blocks/annotations/jump', 'opus', 'frontend', 'completed', 'main', 268, 164, 'Four commits on kiki, one per topic.'],
  ['agent-208', 'ephemeral_b8', 'Space B8: ephemeral sessions', 'sol', 'general', 'completed', 'main', 214, 162, '临时对话 core、REST 与 CLI 已提交。'],
  ['agent-184', 'secrets_ui2', 'Secrets viewable/editable', 'opus', 'frontend', 'completed', 'main', 300, 124, '密钥字段可查看、可编辑；集成测试已修好。'],
  ['agent-212', 'integrate_gui', 'Commit remaining GUI batch by topic', 'sol', 'general', 'completed', 'main', 150, 106, '七个提交，按主题整合，未 push。'],
  ['agent-213', 'build_promote', 'Clean-worktree build + promote', 'sol', 'general', 'completed', 'main', 104, 89, '干净 worktree 构建并 promote，冷启动冒烟通过。'],
  ['agent-211', 'search_s3', 'Search S3: process isolation + budgets', 'sol', 'general', 'completed', 'main', 140, 85, 'S3 已提交：索引进程隔离与预算。'],
  ['agent-218', 'ephemeral_gui', 'Ephemeral session GUI entry', 'sol', 'general', 'cancelled', 'main', 60, 27, undefined],
  ['agent-220', 'gui_gaps', 'GUI config gaps batch 2', 'sol', 'general', 'cancelled', 'main', 58, 27, undefined],
  ['agent-185', 'theme_v2', 'Palette with emphasis + footer + wallpaper', 'opus', 'frontend', 'completed', 'main', 300, 21, '强调色体系落地：attention、selected、section-ink。'],
  ['agent-217', 'hc_theme_refs', 'Find HC theme references', 'ds', 'explore', 'completed', 'agent-185', 40, 18, '68 个参考项目里的高对比主题，附路径。'],
  ['agent-221', 'notes_gui', 'Compaction reasons + notes view', 'sol', 'general', 'completed', 'main', 50, 17, '后端范围已完成并分主题提交。'],
  ['agent-224', 'donor_queue', 'Donor queue UI evidence', 'ds', 'explore', 'completed', 'agent-223', 24, 13, '排队区在 6 个参考项目中的渲染方式。'],
  ['agent-222', 'ops_m1', 'Smoke gate + desktop-ops skill', 'luna', 'worker', 'completed', 'main', 70, 10, '冒烟门禁、desktop-ops 技能已提交。'],
  // In flight.
  ['agent-214', 'rail_variants', 'Bold right-rail variants for decision', 'opus', 'frontend', 'running', 'main', 34, null],
  ['agent-215', 'rail_open_fix', 'Rail subagent open == timeline open', 'opus', 'frontend', 'running', 'main', 34, null],
  ['agent-216', 'settings_visual', 'Unify settings visual system', 'opus', 'frontend', 'suspended', 'main', 33, null],
  ['agent-219', 'search_s4', 'Search S4: wire sqlite backend in', 'sol', 'general', 'suspended', 'main', 30, null],
  ['agent-223', 'composer_states', 'Composer state variants for decision', 'opus', 'frontend', 'suspended', 'main', 25, null],
  ['agent-225', 'preview_fix', 'Preview image blur + fullscreen scope', 'opus', 'frontend', 'running', 'main', 4, null],
  ['agent-226', 'fold_refs_codeg_pi', 'Fold rules in codeg + pi-desktop', 'ds', 'explore', 'running', 'agent-203', 2, null],
  ['agent-227', 'fold_refs_codex_claude', 'Fold rules in Codex + Claude desktop', 'ds', 'explore', 'running', 'agent-203', 2, null],
];

// A second, fully loaded session: more agents (long names, three levels),
// five items waiting, a long checklist with notes, and a busy activity feed.
const FULL_TITLE = '统筹：右栏第二轮、设置页视觉统一、搜索 S4 接入与构建发布前的整批回归检查';
const EXTRA_ROWS = [
  ['agent-230', 'settings_visual_unify_every_section_card_and_dropdown', 'Unify every settings section card, dropdown and save-feedback row to the new visual system', 'opus', 'frontend', 'running', 'main', 20, null],
  ['agent-231', 'search_s4_reindex_probe', 'Probe reindex timing on the 1.1 GB session store', 'ds', 'explore', 'running', 'agent-219', 12, null],
  ['agent-232', 'search_s4_wal_checkpoint_probe', 'Check WAL checkpoint cadence under concurrent writers', 'ds', 'explore', 'running', 'agent-219', 11, null],
  ['agent-233', 'composer_states_queue_preview_reference_scan', 'Scan six donors for queued-message previews', 'ds', 'explore', 'running', 'agent-223', 9, null],
  ['agent-234', 'build_promote_windows_nsis_bundle_and_cold_start_smoke', 'Clean-worktree build, NSIS bundle and cold-start smoke on Windows', 'sol', 'general', 'suspended', 'main', 8, null],
  ['agent-235', 'i18n_glossary_audit', 'Audit the zh glossary against the new rail strings', 'luna', 'worker', 'running', 'main', 7, null],
  ['agent-236', 'timeline_fold_rules_unify_with_read_media', 'Unify fold rules with Read media', 'opus', 'frontend', 'suspended', 'main', 6, null],
  ['agent-237', 'preview_fix_blur_probe', 'Find where the preview downsamples images', 'ds', 'explore', 'completed', 'agent-225', 5, 3, '缩放发生在 MediaLightbox 的 srcset 选择，不在解码。'],
  ['agent-238', 'ops_nightly_visual_smoke', 'Nightly visual smoke on the 11 scenarios', 'luna', 'worker', 'failed', 'main', 30, 14, undefined, 'Visual smoke failed: 2 of 11 scenarios differ beyond threshold (settings-ia, rail-scale).'],
  ...Array.from({ length: 24 }, (_, i) => [`agent-3${String(i).padStart(2, '0')}`, `batch_probe_${i + 1}`, `Batch probe ${i + 1}: grep call sites and report counts`, i % 3 === 0 ? 'ds' : i % 3 === 1 ? 'luna' : 'sol', 'explore', i % 5 === 0 ? 'running' : 'completed', i < 12 ? 'agent-230' : 'agent-203', 50 + i * 3, i % 5 === 0 ? null : 40 + i * 2, `Probe ${i + 1}: ${3 + (i % 7)} call sites.`]),
];
const REGULAR_IDS = new Set(['agent-202', 'agent-203', 'agent-206', 'agent-211', 'agent-212', 'agent-213', 'agent-185', 'agent-217', 'agent-222', 'agent-214', 'agent-215', 'agent-216', 'agent-219', 'agent-223', 'agent-225', 'agent-226', 'agent-227']);

const TODOS_REGULAR = [
  ['读 rail_v6 与 rail_open_fix 的现状', 'done'],
  ['按第一屏重新排默认右栏的区块', 'in_progress'],
  ['驾驶舱跟随主题配色', 'pending'],
  ['两种主题各截一张给用户确认', 'pending'],
];
const TODOS_FULL = [
  ['读 rail_v6 与 rail_open_fix 的现状，确认 AgentRelations 的紧凑 chip 不回退', 'done'],
  ['整理真实会话的数据形状：224 个智能体、6 次压缩、324 轮', 'done'],
  ['默认模式：profile 默认折叠，等你处理置顶，第一屏放下「现在 · 上下文 · 智能体」', 'done'],
  ['默认模式：等你处理的第一件事做成完整卡片，其余压成一行，超过五件折叠', 'in_progress'],
  ['默认模式：动态改成按时间排的一条流，文件、命令、派单、回报、压缩放在一起', 'pending'],
  ['驾驶舱：跟随主题配色，浅色主题下不再是一块深色异物', 'pending'],
  ['驾驶舱：「运行中」可以在列表和泳道之间切换', 'pending'],
  ['设置：右栏默认显示「默认 / 驾驶舱」，放在常规 › 输入与时间线', 'pending'],
  ['满载 mock：智能体很多、todo 很长、动态很多、名字很长', 'pending'],
  ['1440 与 1280，浅色与深色各截图，自己看过再交', 'pending'],
  ['删除 A、C、D 原型与 ?rail= 切换', 'pending'],
  ['临时 GIT_INDEX_FILE 提交，确认 HEAD 未被推进', 'pending'],
];
const NOTES_FULL = {
  goal: '在现有右栏上调整，而不是整体推翻；驾驶舱作为可切换的第二种模式保留。',
  decided: '第一屏：等你处理 → 现在 → 上下文与费用 → 智能体。profile、动态、能力默认折叠。',
  next: '做满载截图，交给主控确认后再落地 i18n 与设置项。',
};

// Tool activity for the main agent, newest last: files, commands, dispatches.
const ACTIVITY_REGULAR = [
  ['Read', { kind: 'file_io', operation: 'read', path: 'apps/kiki-gui/src/components/RightRail.tsx' }, 26],
  ['Bash', { kind: 'command', command: 'git log --oneline -8' }, 22],
  ['Edit', { kind: 'diff', path: 'apps/kiki-gui/src/components/agent-panel/InspectorNow.tsx', diff: '' }, 9],
  ['Bash', { kind: 'command', command: 'pnpm --filter @kiki/gui typecheck' }, 4],
];
const ACTIVITY_FULL = [
  ...ACTIVITY_REGULAR,
  ['Read', { kind: 'file_io', operation: 'read', path: 'apps/kiki-gui/src/components/settings/GeneralSection.tsx' }, 18],
  ['Write', { kind: 'file_io', operation: 'write', path: 'apps/kiki-gui/src/components/rail-variants/DefaultRail.tsx' }, 15],
  ['Edit', { kind: 'diff', path: 'apps/kiki-gui/src/components/rail-variants/CockpitRail.tsx', diff: '' }, 12],
  ['Edit', { kind: 'diff', path: 'packages/session-core/src/settings/settings.ts', diff: '' }, 11],
  ['Bash', { kind: 'command', command: 'node .tmp/rail_variants/shots.mjs x --locales=zh --widths=1440,1280 --themes=light,dark' }, 7],
  ['Read', { kind: 'file_io', operation: 'read', path: 'apps/kiki-gui/src/components/AgentBreadcrumb.tsx' }, 5],
  ['Bash', { kind: 'command', command: 'npx oxlint --type-aware apps/kiki-gui/src/components/rail-variants' }, 2],
];

function buildSession(SID, full) {
const rows = full ? [...ROWS, ...EXTRA_ROWS] : ROWS.filter((row) => REGULAR_IDS.has(row[0]));
const WAITING = [
  { agent: 'agent-216', id: 'approval_cmd_settings', kind: 'approval', tool: 'Bash', display: { kind: 'command', command: 'pnpm --filter @kiki/gui build' }, action: 'Run: pnpm --filter @kiki/gui build', ago: 6 },
  { agent: 'agent-219', id: 'approval_cmd_search', kind: 'approval', tool: 'Write', display: { kind: 'file_io', operation: 'write', path: 'packages/kap-server/src/search/sqliteBackend.ts' }, action: 'Write packages/kap-server/src/search/sqliteBackend.ts', ago: 3 },
  { agent: 'agent-223', id: 'question_cmd_composer', kind: 'question', header: '排队预览', question: '排队的消息要做成几种预览给你挑？', options: ['三种：条、卡片、内联', '两种就够', '先只做一种'], ago: 1 },
  ...(full ? [
    { agent: 'agent-234', id: 'approval_cmd_bundle', kind: 'approval', tool: 'Bash', display: { kind: 'command', command: 'pnpm --filter @kiki/gui desktop:build && node scripts/desktop-release.mjs --promote --channel preview --skip-notarize' }, action: 'Run: pnpm --filter @kiki/gui desktop:build', ago: 2 },
    { agent: 'agent-236', id: 'approval_cmd_fold', kind: 'approval', tool: 'Edit', display: { kind: 'diff', path: 'apps/kiki-gui/src/components/timeline/foldRules.ts', diff: '' }, action: 'Edit apps/kiki-gui/src/components/timeline/foldRules.ts', ago: 1 },
  ] : []),
];

// The user's recent prompts on the main timeline (newest last).
const PROMPTS = [
  [178, '收到 secrets_ui2 的回复，先把它剩下的集成测试收尾。'],
  [106, '把剩下的 GUI 改动按主题提交，干净 worktree 里构建一次。'],
  [34, '右侧栏我还是不满意，按照当前对话多做几个版本让我决断，大胆一些。'],
  [28, 'subagent 在时间线里占用太多了；前端别再派给 sol。'],
  [25, '排队做成气泡不是好主意，对话框的各种情况都做预览让我决断。'],
  [19, '当前轮次里不是最新的块也应该折叠；Read media 单独一行显示。'],
  [13, 'bug：批注已经发送的情况下仍然会留在对话框里。'],
  [6, '鼠标悬浮侧边栏的效果很丑。'],
  [3, '预览界面查看图片会糊，全屏按钮会无视侧边栏。'],
  [1, '时间线右侧没对齐。'],
];
// Six compactions over the session; the last two fall inside the visible day.
const COMPACTIONS = [2351, 1915, 1664, 1190, 921, 301];

const ended = (status) => status === 'completed' || status === 'failed' || status === 'cancelled';

const roster = rows.map(([id, label, description, family, profile, status, parent, startedAgo, endedAgo, summary, error], index) => ({
  id: `task_${id}`,
  session_id: SID,
  kind: 'subagent',
  status: status === 'suspended' ? 'running' : status,
  subagent_phase: status === 'suspended' ? 'suspended' : undefined,
  description,
  agent_id: id,
  parent_agent_id: parent,
  label,
  profile,
  model: MODEL[family],
  thinking_effort: EFFORT[family],
  created_at: ts(startedAgo + 1),
  started_at: ts(startedAgo),
  ...(ended(status) && endedAgo !== null ? { completed_at: ts(endedAgo) } : {}),
  ...(summary !== undefined ? { output_preview: summary } : {}),
  ...(error !== undefined ? { stop_reason: error } : {}),
  ...(status === 'cancelled' ? { output_preview: 'Stopped by main before finishing.' } : {}),
  tool_call_count: 6 + ((index * 7) % 41),
  live: true,
}));

function phaseFor(status) {
  switch (status) {
    case 'running': return { kind: 'running', turnId: 1, step: 1, stepId: 't1.1', since: 0 };
    case 'suspended': return { kind: 'awaiting_approval', turnId: 1, since: 0 };
    case 'failed': return { kind: 'ended', turnId: 1, reason: 'failed', at: 0 };
    case 'cancelled': return { kind: 'interrupted', turnId: 1, reason: 'aborted', at: 0 };
    default: return { kind: 'ended', turnId: 1, reason: 'completed', at: 0 };
  }
}

function childTranscript([id, , description, family, , status, , startedAgo, , , , ], index) {
  const wait = WAITING.find((entry) => entry.agent === id);
  const live = status === 'running' || status === 'suspended';
  const toolCallId = wait === undefined ? undefined : `call-${wait.id}`;
  const frames = [];
  if (live) frames.push({ kind: 'text', frameId: `${id}-note`, role: 'assistant', text: `Working on: ${description}.` });
  if (wait?.kind === 'approval') {
    frames.push({ kind: 'tool', frameId: `tool-${wait.id}`, toolCallId, name: wait.tool, state: 'running', input: {}, display: wait.display });
  }
  return {
    agent_id: id,
    has_more: false,
    tool_call_count: 6 + ((index * 7) % 41),
    items: frames.length === 0 ? [] : [{
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: description,
      startedAt: ts(startedAgo),
      steps: [{ kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running', startedAt: ts(startedAgo), frames }],
    }],
    interactions: wait === undefined ? [] : [wait.kind === 'approval' ? {
      interactionId: wait.id,
      interactionKind: 'approval',
      toolCallId,
      origin: { agentId: id },
      state: 'pending',
      request: { turnId: 1, toolCallId, toolName: wait.tool, action: wait.action, display: wait.display, createdAt: ts(wait.ago), expiresAt: ts(-600) },
    } : {
      interactionId: wait.id,
      interactionKind: 'question',
      origin: { agentId: id },
      state: 'pending',
      request: {
        turnId: 1,
        questions: [{ id: 'q1', header: wait.header, question: wait.question, options: wait.options.map((label, i) => ({ id: `o${i + 1}`, label })) }],
        createdAt: ts(wait.ago),
      },
    }],
    meta: {
      activity: live ? 'turn' : 'idle',
      agent: {
        model: MODEL[family],
        thinkingEffort: EFFORT[family],
        permission: 'manual',
        contextTokens: 40_000 + ((index * 37_000) % 300_000),
        maxContextTokens: family === 'ds' ? 1_000_000 : 400_000,
        phase: phaseFor(status),
      },
    },
  };
}

const activity = full ? ACTIVITY_FULL : ACTIVITY_REGULAR;
const turnItems = PROMPTS.map(([ago, prompt], index) => {
  const last = index === PROMPTS.length - 1;
  const turnId = `t${300 + index}`;
  const state = last ? 'running' : 'completed';
  const nextAgo = index + 1 < PROMPTS.length ? PROMPTS[index + 1][0] : -1;
  const tools = activity
    .filter(([, , toolAgo]) => toolAgo <= ago && toolAgo > nextAgo)
    .toSorted((l, r) => r[2] - l[2])
    .map(([name, display, toolAgo], i) => ({
      kind: 'tool', frameId: `${turnId}-tool-${i}`, toolCallId: `${turnId}-call-${i}`, name, state: 'done', input: {}, display,
      startedAt: ts(toolAgo), endedAt: ts(toolAgo - 0.2),
    }));
  const liveTool = last ? [{ kind: 'tool', frameId: `${turnId}-live`, toolCallId: `${turnId}-live`, name: 'Read', state: 'running', input: {}, display: { kind: 'file_io', operation: 'read', path: 'apps/kiki-gui/src/components/Transcript.tsx' }, startedAt: ts(0.3) }] : [];
  return {
    kind: 'turn', turnId, ordinal: 300 + index, state, origin: { kind: 'user' }, prompt,
    startedAt: ts(ago), ...(last ? {} : { endedAt: ts(Math.max(0.5, ago - 1)) }),
    steps: [{
      kind: 'step', stepId: `${turnId}.1`, turnId, ordinal: 1, state, startedAt: ts(ago),
      ...(last ? {} : { endedAt: ts(Math.max(0.5, ago - 1)) }),
      frames: [
        ...tools,
        { kind: 'text', frameId: `${turnId}-reply`, role: 'assistant', text: last ? '收到，先定位右侧对齐的来源，再派给 timeline 的 owner。' : '已派给对应的 owner，结果回来后汇总给你。' },
        ...liveTool,
      ],
    }],
  };
});
const todoItems = (full ? TODOS_FULL : TODOS_REGULAR).map(([title, status]) => ({ title, status }));
const todos = [{ todoId: 'todo', items: todoItems, ...(full ? { notes: NOTES_FULL, notesMeta: { rev: 7, hash: 'fx', writtenTurn: 322, writtenStep: 't322.1', coveredMessageId: 'm', windowEpoch: 6 } } : {}), updatedAt: ts(2) }];
const compactionItems = COMPACTIONS.map((ago, index) => ({
  kind: 'marker', markerId: `cmd-compact-${index + 1}`, marker: 'compaction', at: ts(ago),
  payload: index % 2 === 0 ? { strategy: 'relay' } : {},
}));
const mainItems = [...compactionItems, ...turnItems].toSorted((a, b) => Date.parse(a.at ?? a.startedAt) - Date.parse(b.at ?? b.startedAt));

const agentTranscripts = {
  main: {
    agent_id: 'main',
    has_more: false,
    items: mainItems,
    todos,
    meta: {
      activity: 'turn',
      agent: {
        model: MODEL.opus,
        thinkingEffort: 'max',
        permission: 'manual',
        contextTokens: 612_400,
        maxContextTokens: 1_000_000,
        phase: { kind: 'running', turnId: 309, step: 1, stepId: 't309.1', since: 0 },
      },
    },
  },
};
rows.forEach((row, index) => { agentTranscripts[row[0]] = childTranscript(row, index); });

const pendingApprovals = WAITING.filter((wait) => wait.kind === 'approval').map((wait) => ({
  approval_id: wait.id,
  agentId: wait.agent,
  agent_id: wait.agent,
  session_id: SID,
  turn_id: 1,
  tool_call_id: `call-${wait.id}`,
  tool_name: wait.tool,
  action: wait.action,
  tool_input_display: wait.display,
  created_at: ts(wait.ago),
  expires_at: ts(-600),
}));

const pendingQuestions = WAITING.filter((wait) => wait.kind === 'question').map((wait) => ({
  question_id: wait.id,
  agent_id: wait.agent,
  session_id: SID,
  turn_id: 1,
  questions: [{ id: 'q1', header: wait.header, question: wait.question, options: wait.options.map((label, i) => ({ id: `o${i + 1}`, label })) }],
  created_at: ts(wait.ago),
}));

function metricsRow({ input, output, cacheRead, contextTokens, contextLimit, cost, compactions = 0 }) {
  return {
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
    totalTokens: input + output, totalCostUsd: cost, contextTokens, contextLimit,
    compactionCount: compactions, usageSource: 'live',
  };
}
const metrics = {
  main: metricsRow({ input: 170_686_570, output: 2_857_751, cacheRead: 1_017_957_245, contextTokens: 612_400, contextLimit: 1_000_000, cost: 412.6, compactions: 6 }),
};
rows.forEach((row, index) => {
  const input = 900_000 + (index % 9) * 410_000;
  metrics[row[0]] = metricsRow({ input, output: 40_000 + (index % 5) * 9_000, cacheRead: Math.round(input * 3.1), contextTokens: 40_000 + ((index * 37_000) % 300_000), contextLimit: row[3] === 'ds' ? 1_000_000 : 400_000, cost: 1.2 + (index % 7) * 0.9 });
});

  return {
    metrics,
    record: sessionRecord(SID, {
      title: full ? FULL_TITLE : '你好',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'approval',
      created_at: ts(42 * 60 + 11),
      updated_at: ts(0),
      metadata: { cwd: full ? 'C:/Programs/AI/EasyAgent/systems/kiki/apps/kiki-gui/src/components/rail-variants' : 'C:/Programs/AI/EasyAgent' },
      agent_config: { model: MODEL.opus, permission_mode: 'manual' },
      message_count: 1_284,
      usage: {
        input_tokens: 170_686_570,
        output_tokens: 2_857_751,
        cache_read_tokens: 1_017_957_245,
        cache_creation_tokens: 34_306_561,
        total_cost_usd: 412.6,
        context_tokens: 612_400,
        context_limit: 1_000_000,
        turn_count: 324,
      },
    }),
    snapshot: {
      messages: [],
      has_more: false,
      subagents: roster,
      pending_approvals: pendingApprovals,
      pending_questions: pendingQuestions,
      agent_transcripts: agentTranscripts,
    },
  };
}
const REGULAR = buildSession('session_fixture_rail_command', false);
const FULL = buildSession('session_fixture_rail_full', true);

export default {
  agentPanel: {
    ...railScale.agentPanel,
    profile: { ...railScale.agentPanel.profile, description: 'Coordinates owners across the kiki workspace.', model: MODEL.opus, thinking_effort: 'max' },
    // One panel read serves both sessions; the full one's rows are a superset.
    metrics: { ...REGULAR.metrics, ...FULL.metrics },
  },
  sessions: [REGULAR.record, FULL.record],
  snapshots: {
    [REGULAR.record.id]: REGULAR.snapshot,
    [FULL.record.id]: FULL.snapshot,
  },
};

export const RAIL_COMMAND = { REGULAR: REGULAR.record.id, FULL: FULL.record.id };
