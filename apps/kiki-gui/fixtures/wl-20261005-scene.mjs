/**
 * wl-20261005-scene — the scenario seeds for the workbench / long-work /
 * features-index screenshot set (2026-10-05).
 *
 * Why a separate module: the 2026-10-04 campaign seeds are owned by
 * public_visuals_frontend_m3 and cover the whole Features series. This set
 * needs three things those seeds do not provide, and it needs them without a
 * concurrent edit to a shared file:
 *
 *   1. A right rail with no empty-state stack. Every rail block the public
 *      frames showed — working notes, injected rules, scheduled tasks — was
 *      rendering its "nothing here" line, so three of them stacked into a
 *      frame that read as a product that had no state. Here each block has its
 *      real content: working notes written by the lead, a live injected rule,
 *      and schedules on the session.
 *   2. Two surfaces the 2026-10-04 set never shot: the scheduled-task panel
 *      (long-work's "跨会话存活的活" first half) and the task board (its
 *      second half). Both already have proven seed surfaces on the fixture
 *      server — `cronTasks` for `/cron`, and `taskBoard` for the
 *      `taskBoardService.read` klient procedure — so these seeds are data, not
 *      new plumbing.
 *   3. A subagent opened in the right rail, so the workbench page's "a
 *      subagent keeps its own record" claim has a frame behind it. That is the
 *      same rail with a different agent selected, driven by the reader's own
 *      click.
 *
 * Locale discipline is the same as marketing-campaign-scene.mjs: identical
 * ids and structure between en and zh, translated visible copy only. The thin
 * `wl-20261005-<id>-<locale>.scenario.mjs` entry points call `build<Id>(locale)`.
 *
 * These are fixture-server wire shapes (see helpers.mjs, fixture-transcript.mjs).
 * No product code is involved.
 */

import { sessionRecord, ts } from './helpers.mjs';
import {
  AGENT,
  ROLE_BINDING,
  SAMPLE_ROOT,
  SESSION,
  WORKSPACE_ID,
  completedMeta,
  runningMeta,
  sampleConfig,
  sampleModels,
  sampleProviders,
  sampleWorkspace,
  textFrame,
  toolFrame,
  turn,
} from './marketing-scene.mjs';

/** The fictional project every frame shows, same as the 2026-10-04 set. */
export const PROJECT_ROOT = SAMPLE_ROOT;
export const PROJECT = 'sample-app';

const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

/** Roster roles as the reader meets them, in the order the rail lists them. */
const AGENT_LABEL = {
  en: { explorer: 'Explorer', builder: 'Builder', reviewer: 'Reviewer', thinker: 'Thinker' },
  zh: { explorer: '探索者', builder: '构建者', reviewer: '审阅者', thinker: '思考者' },
};

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function rolesCopy(locale) {
  const label = AGENT_LABEL[locale] ?? AGENT_LABEL.en;
  return {
    label,
    explorer: {
      description: pick(locale, 'Isolate context and gather sources', '隔离上下文并收集来源'),
      summary: pick(
        locale,
        'Docs tree and release scripts mapped. The 0.3 → 0.4 upgrade guide is the only file still on 0.3 wording.',
        '文档结构与发布脚本已梳理完毕。0.3 → 0.4 升级指南是唯一仍写 0.3 措辞的文件。',
      ),
      prompt: pick(locale, 'Map the docs tree and the release scripts.', '梳理文档结构与发布脚本。'),
      finding: pick(
        locale,
        'Found one file still on 0.3 wording: docs/upgrade-0.4.md.',
        '发现一个文件仍是 0.3 措辞：docs/upgrade-0.4.md。',
      ),
    },
    thinker: {
      description: pick(locale, 'Weigh the upgrade path and call the trade-offs', '评估升级路径并给出取舍结论'),
      summary: pick(
        locale,
        'Staged rollout. Two breaking changes to flag in the notes, and the smoke suite needs a retry budget.',
        '建议分阶段发布。需在说明中标注两处破坏性变更，冒烟套件需要重试预算。',
      ),
      prompt: pick(locale, 'Think through the upgrade path for 0.4 and name the trade-offs.', '思考 0.4 的升级路径，并指出取舍。'),
    },
    builder: {
      description: pick(locale, 'Draft the 0.4 changelog', '起草 0.4 更新日志'),
      prompt: pick(locale, 'Draft the 0.4 changelog.', '起草 0.4 更新日志。'),
    },
    reviewer: {
      description: pick(locale, 'Run the sample-app test suite', '运行 sample-app 测试套件'),
      prompt: pick(locale, 'Run the sample-app test suite.', '运行 sample-app 测试套件。'),
    },
  };
}

/** Per-agent transcript turns, so the rail's tool counts and each opened
 *  subagent's own record have real steps behind them. */
function roleTurns(locale) {
  const copy = rolesCopy(locale);
  return {
    explorer: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.explorer.prompt,
      minutesAgo: 9,
      frames: [
        toolFrame({ frameId: 'wl-ex-read-releasing', toolCallId: 'call_wl_ex_releasing', name: 'Read', input: { path: 'docs/RELEASING.md' }, output: pick(locale, 'Release checklist with 9 steps.', '发布检查清单，共 9 步。') }),
        toolFrame({ frameId: 'wl-ex-read-upgrade', toolCallId: 'call_wl_ex_upgrade', name: 'Read', input: { path: 'docs/upgrade-0.4.md' }, output: pick(locale, 'Steps still name 0.3.0-rc.1 in three places.', '三处仍写着 0.3.0-rc.1。') }),
        toolFrame({ frameId: 'wl-ex-grep-version', toolCallId: 'call_wl_ex_grep', name: 'Grep', input: { pattern: '0\\.3\\.0-rc\\.1', path: 'docs' }, output: pick(locale, '3 matches, all in docs/upgrade-0.4.md.', '3 处匹配，均在 docs/upgrade-0.4.md。') }),
        toolFrame({ frameId: 'wl-ex-gitlog', toolCallId: 'call_wl_ex_git', name: 'Bash', input: { command: 'git log --oneline -20' }, output: pick(locale, '20 commits since 0.3.0.', '自 0.3.0 起共 20 次提交。') }),
        textFrame({ frameId: 'wl-ex-summary', text: copy.explorer.finding }),
      ],
    }),
    thinker: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.thinker.prompt,
      minutesAgo: 12,
      frames: [
        toolFrame({ frameId: 'wl-th-read-releasing', toolCallId: 'call_wl_th_releasing', name: 'Read', input: { path: 'docs/RELEASING.md' }, output: pick(locale, 'Staged-rollout checklist, 9 steps.', '分阶段发布清单，共 9 步。') }),
        toolFrame({ frameId: 'wl-th-grep-breaking', toolCallId: 'call_wl_th_breaking', name: 'Grep', input: { pattern: 'BREAKING' }, output: pick(locale, '2 breaking changes to flag.', '需标注 2 处破坏性变更。') }),
        textFrame({ frameId: 'wl-th-summary', text: copy.thinker.summary }),
      ],
    }),
    builder: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.builder.prompt,
      minutesAgo: 5,
      state: 'running',
      frames: [
        toolFrame({ frameId: 'wl-bu-read-changelog', toolCallId: 'call_wl_bu_changelog', name: 'Read', input: { path: 'CHANGELOG.md' }, output: pick(locale, 'Latest entry: 0.3.0, 41 entries.', '最新条目：0.3.0，共 41 条。') }),
        toolFrame({ frameId: 'wl-bu-grep-feat', toolCallId: 'call_wl_bu_feat', name: 'Grep', input: { pattern: 'feat\\(' }, output: pick(locale, '6 feature commits to fold in.', '需并入 6 条 feature 提交。') }),
        toolFrame({ frameId: 'wl-bu-read-upgrade', toolCallId: 'call_wl_bu_upgrade', name: 'Read', input: { path: 'docs/upgrade-0.4.md' }, output: undefined, state: 'running' }),
      ],
    }),
    reviewer: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.reviewer.prompt,
      minutesAgo: 4,
      state: 'running',
      frames: [
        toolFrame({ frameId: 'wl-rv-read-a11y', toolCallId: 'call_wl_rv_a11y', name: 'Read', input: { path: 'docs/accessibility.md' }, output: pick(locale, 'Checklist restored, 12 checks.', '检查清单已恢复，共 12 项。') }),
        toolFrame({ frameId: 'wl-rv-bash-test', toolCallId: 'call_wl_rv_test', name: 'Bash', input: { command: 'pnpm test --filter sample-app' }, output: undefined, state: 'running' }),
      ],
    }),
  };
}

/** Dispatch-tree roster rows. Each carries its role's model binding. */
function roster(locale, rows) {
  const copy = rolesCopy(locale);
  return rows.map(({ role, status, created, started, completed, toolCalls }) => ({
    id: `task_wl_${role}`,
    session_id: SESSION.release,
    kind: 'subagent',
    status,
    description: copy[role].description,
    agent_id: AGENT[role],
    label: copy.label[role],
    model: ROLE_BINDING[role].rail,
    thinking_effort: ROLE_BINDING[role].effort,
    created_at: ts(created),
    started_at: ts(started),
    ...(completed === undefined ? {} : { completed_at: ts(completed) }),
    ...(status === 'completed' ? { output_preview: copy[role].summary } : {}),
    tool_call_count: toolCalls,
    live: true,
  }));
}

/** Four roles, two in flight, two landed: the fleet a per-role model shot wants. */
const FLEET = [
  { role: 'thinker', status: 'completed', created: 14, started: 13, completed: 10, toolCalls: 3 },
  { role: 'explorer', status: 'completed', created: 9, started: 8, completed: 5, toolCalls: 4 },
  { role: 'builder', status: 'running', created: 6, started: 5, toolCalls: 3 },
  { role: 'reviewer', status: 'running', created: 5, started: 4, toolCalls: 2 },
];

// ---------------------------------------------------------------------------
// Rail content: working notes, injected rules, schedules
// ---------------------------------------------------------------------------

/**
 * The lead's working notes. The rail reads 工作笔记 / Working notes from this
 * agent's own TodoList store; a seed with none renders "还没有工作笔记", and a
 * frame showing that beside a live turn claims the product is idle when it is
 * not. Every section here is a fact the frame's own transcript supports, so
 * nothing in the rail contradicts the pane beside it.
 */
function leadNotes(locale) {
  return {
    goal: pick(locale, 'Ship sample-app 0.4 with the upgrade path proven.', '让 sample-app 0.4 在升级路径验证通过后发布。'),
    directives: pick(
      locale,
      'Never tag, push, or run a release action without the operator saying so.',
      '未经操作者批准，不推送、不打标、不执行发布动作。',
    ),
    decided: pick(
      locale,
      'Changelog entries come from merged PR titles, not raw commit subjects.',
      '更新日志条目取自已合并的 PR 标题，而不是原始提交标题。',
    ),
    evidence: [
      pick(locale, 'Docs build: 0 errors, 41 warnings, all in the upgrade guide.', '文档构建：0 错误，41 告警，全部来自升级指南。'),
      pick(locale, 'Accessibility scan: 12 checks, 0 new failures.', '无障碍扫描：12 项检查，0 个新增失败。'),
      pick(locale, 'Upgrade rehearsal 0.3.9 → 0.4.0-rc.2 kept settings and sessions.', '0.3.9 → 0.4.0-rc.2 升级演练后设置与会话均保留。'),
    ].join('\n'),
    files: pick(
      locale,
      'docs/upgrade-0.4.md · CHANGELOG.md · docs/accessibility.md',
      'docs/upgrade-0.4.md · CHANGELOG.md · docs/accessibility.md',
    ),
    next: pick(
      locale,
      'Fold the 6 feature commits into the changelog, then rerun the test suite.',
      '把 6 条 feature 提交并入更新日志，然后重跑测试套件。',
    ),
    open: pick(
      locale,
      'Does the arm64 smoke suite still time out under load?',
      'arm64 冒烟套件在负载下是否仍会超时？',
    ),
  };
}

function leadTodos(locale) {
  return [
    { title: pick(locale, 'Confirm the docs build', '确认文档构建'), status: 'done' },
    { title: pick(locale, 'Run the accessibility scan', '运行无障碍扫描'), status: 'done' },
    { title: pick(locale, 'Draft the 0.4 changelog', '起草 0.4 更新日志'), status: 'in_progress' },
    { title: pick(locale, 'Confirm the test suite', '确认测试套件'), status: 'pending' },
  ];
}

/**
 * One injected rule, live. The rail's "带入规则 / Injected rules" block reads
 * `/sessions/:id/agents/:agentId/hooks`; with no seed it either renders
 * "本轮没生效的带入规则" (nothing in effect) or, on an unseeded route, the red
 * "Could not read injected rules — Retry" line that shipped in the 2026-10-04
 * en queue frame. One real rule is also the honest frame: a release project
 * that gates edits behind a restated sub-goal.
 */
function injectedRules(locale) {
  return {
    revision: 'hooks-wl-1',
    sources: [{ namespace: 'project', path: 'hooks/release-checklist.toml', status: 'loaded' }],
    diagnostics: [],
    rules: [
      {
        id: 'release-checklist',
        path: 'hooks/release-checklist.toml',
        namespace: 'project',
        event: 'step.before',
        action: { type: 'inject' },
        active: true,
        reason: pick(
          locale,
          'Before editing, restate the current sub-goal in one line.',
          '动手改之前，先用一句话重述当前子目标。',
        ),
        completedSteps: 0,
        order: 0,
        resetPending: false,
      },
      {
        id: 'release-evidence',
        path: 'hooks/release-checklist.toml',
        namespace: 'project',
        event: 'turn.end',
        action: { type: 'inject' },
        active: true,
        reason: pick(
          locale,
          'At the end of a turn, name the evidence the completion claim rests on.',
          '每轮结束时，说明完成判断所依据的证据。',
        ),
        completedSteps: 2,
        order: 1,
        resetPending: false,
      },
    ],
  };
}

/**
 * The session's own schedules. The rail's "本对话定时任务 / Scheduled tasks
 * here" block reads the same `/cron` list the global panel does and filters it
 * to this session (src/components/rail-variants/SessionCronSection.tsx:218) —
 * there is no separate per-session seed. So these two rows live in
 * `cronTasks`, and the two frames that show them (the rail close-up and the
 * global scheduled-tasks page) come off one list and cannot disagree.
 *
 * The 2026-10-04 frames rendered this block's empty state even on a session
 * that was demonstrably doing long work; two real plans on this session is what
 * the long-work page is actually about.
 */
function sessionSchedules(locale) {
  // A next-fire instant must be relative to the WALL CLOCK, not to ts(0).
  // ts() is anchored to KIKI_FIXTURE_EPOCH, which is deliberately in the
  // future, so a countdown built on it is already past when the page asks
  // timeUntil() — and timeUntil() renders a past instant as "expired",
  // which is how a perfectly healthy one-shot plan ends up looking dead on
  // a public frame. The panel ages its countdown against the real clock.
  const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  return [
    {
      id: 'cron_wl_release_notes',
      session_id: SESSION.release,
      workspace_id: WORKSPACE_ID,
      cron: '30 18 * * *',
      human_schedule: pick(locale, 'Once, today at 18:30', '仅一次，今天 18:30'),
      prompt_preview: pick(
        locale,
        'Regenerate the release notes PDF from the changelog and attach it to this session.',
        '根据更新日志重新生成发布说明 PDF，并作为附件发到本会话。',
      ),
      next_fire_at: at(96),
      recurring: false,
      paused: false,
      age_days: 0,
      stale: false,
      created_at: ts(140),
      last_fired_at: null,
    },
    {
      id: 'cron_wl_nightly_docs',
      session_id: SESSION.release,
      workspace_id: WORKSPACE_ID,
      cron: '0 3 * * *',
      human_schedule: pick(locale, 'Every day at 03:00', '每天 03:00'),
      prompt_preview: pick(
        locale,
        'Run the docs build and report the first warning that mentions a broken link.',
        '跑一遍文档构建，并回报第一条提到失效链接的告警。',
      ),
      next_fire_at: at(1_180),
      recurring: true,
      paused: false,
      age_days: 9,
      stale: false,
      created_at: ts(12_960),
      last_fired_at: at(-2_100),
    },
  ];
}

/** The global schedule list, for the scheduled-tasks page frame. */
function globalSchedules(locale) {
  // A next-fire instant must be relative to the WALL CLOCK, not to ts(0).
  // ts() is anchored to KIKI_FIXTURE_EPOCH, which is deliberately in the
  // future, so a countdown built on it is already past when the page asks
  // timeUntil() — and timeUntil() renders a past instant as "expired",
  // which is how a perfectly healthy one-shot plan ends up looking dead on
  // a public frame. The panel ages its countdown against the real clock.
  const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  return [
    {
      id: 'cron_wl_weekly_triage',
      session_id: SESSION.release,
      workspace_id: WORKSPACE_ID,
      cron: '0 9 * * 1',
      human_schedule: pick(locale, 'Every Monday at 09:00', '每周一 09:00'),
      prompt_preview: pick(
        locale,
        'Summarize the sample-app issues opened since last Monday and draft the triage list.',
        '汇总上周一以来新开的 sample-app issue，并起草分诊清单。',
      ),
      next_fire_at: at(1_320),
      recurring: true,
      paused: false,
      age_days: 12,
      stale: false,
      created_at: ts(17_280),
      last_fired_at: ts(11_400),
    },
    ...sessionSchedules(locale),
    {
      id: 'cron_wl_smoke_nightly',
      session_id: SESSION.accessibility,
      workspace_id: WORKSPACE_ID,
      cron: '0 4 * * *',
      human_schedule: pick(locale, 'Every day at 04:00', '每天 04:00'),
      prompt_preview: pick(
        locale,
        'Run the arm64 smoke suite on a clean checkout and report the first failure.',
        '在干净检出上跑 arm64 冒烟套件，并回报第一个失败。',
      ),
      next_fire_at: null,
      recurring: true,
      paused: true,
      age_days: 31,
      stale: true,
      created_at: ts(44_640),
      last_fired_at: ts(1_560),
    },
  ];
}

// ---------------------------------------------------------------------------
// Base: config, catalog, workspace, sessions, rail
// ---------------------------------------------------------------------------

const LOCALIZED_SESSIONS = {
  en: {
    release: 'Prepare the release',
    accessibility: 'Review accessibility',
    documentation: 'Update documentation',
  },
  zh: {
    release: '准备 sample-app 发布',
    accessibility: '检查无障碍',
    documentation: '更新文档',
  },
};

function sessions(locale, { busy = false } = {}) {
  const titles = LOCALIZED_SESSIONS[locale] ?? LOCALIZED_SESSIONS.en;
  const rows = [
    { id: SESSION.release, title: titles.release, busy, minutesAgo: 1 },
    { id: SESSION.accessibility, title: titles.accessibility, minutesAgo: 95 },
    { id: SESSION.documentation, title: titles.documentation, minutesAgo: 150 },
  ];
  return rows.map((row) => sessionRecord(row.id, {
    title: row.title,
    workspace_id: WORKSPACE_ID,
    metadata: { cwd: PROJECT_ROOT },
    // `model` is required and must be a catalog model id, not a display alias:
    // the session view resolves the binding through the catalog, and a session
    // with no model fails to open outright ("无法打开会话 … agent_config.model").
    agent_config: { model: ROLE_BINDING.main.id, profile: 'agent' },
    ...(row.busy ? { busy: true, main_turn_active: true, pending_interaction: 'none' } : {}),
    updated_at: ts(row.minutesAgo),
    created_at: ts(240),
  }));
}

/**
 * The right rail reads its capability block from `agentPanelService.read`. A
 * scenario seeding no panel gets a `fixture/kiki-pro` model and an
 * `available: false` error in the frame, so the panel is seeded. `targets`
 * MUST satisfy `agentCapabilityTargetSchema`
 * (packages/protocol/src/rest/agentProfile.ts:310) — one bad field and the
 * whole panel read is rejected, which is how "Capabilities can't be read right
 * now" got into an otherwise fine frame.
 *
 * PER-AGENT OWNERSHIP, and why this takes the agent the frame is ABOUT rather
 * than returning a panel per agent. The rail asks per agent:
 * `AgentPanelContainer.tsx:125` builds `query = { session_id, agent_id: agentId }`
 * from the currently selected agent and keys the query on it. The identity
 * block then reads `model: profile?.model ?? agentState?.model`
 * (AgentPanelContainer.tsx:237) — the capability read WINS over the live agent
 * state, which already carries the right binding (see `completedMeta` /
 * `runningMeta` in marketing-scene.mjs).
 *
 * So a panel carrying the lead's profile would be replayed for every subagent
 * and a child would read as `agent` / Kimi K3 under its own name. That was a
 * real defect in the first pass of this file: the frame showed the Explorer
 * selected with the lead's identity beside it. It is a SEED defect, not a
 * product one — the product requests the right thing per agent, and only a
 * fixture answering with one static object can get it wrong. (The response is
 * schema-validated against the service output at fixture-klient.mjs:345, so a
 * map keyed by agent id is not an option inside the seed.)
 *
 * Hence `about`: the scenario declares which agent its frame foregrounds, and
 * that frame gets that agent's profile. The lead's frames pass 'main'; the
 * subagent frame passes 'explorer'. `metrics` stays the full per-agent map
 * because the rail reads `metrics[agentId]` and needs the whole tree for its
 * totals — which is why the cost read correctly while the model did not.
 */
function agentPanel(locale, roleList, about = 'main') {
  const copy = rolesCopy(locale);
  const metrics = ({ input, output, cacheRead, contextTokens, cost, model }) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: input + output,
    totalCostUsd: cost,
    contextTokens,
    contextLimit: 262_144,
    compactionCount: 0,
    usageSource: 'live',
    model,
  });
  const perRole = {
    thinker: { input: 54_200, output: 12_800, cacheRead: 38_000, contextTokens: 16_400, cost: 0.86 },
    explorer: { input: 42_100, output: 5_200, cacheRead: 31_000, contextTokens: 12_400, cost: 0.31 },
    builder: { input: 61_800, output: 9_400, cacheRead: 44_200, contextTokens: 18_900, cost: 0.58 },
    reviewer: { input: 33_500, output: 4_100, cacheRead: 22_800, contextTokens: 9_600, cost: 0.24 },
  };
  const metricRows = {
    main: metrics({ input: 128_400, output: 18_600, cacheRead: 96_400, contextTokens: 41_200, cost: 1.42, model: ROLE_BINDING.main.rail }),
  };
  for (const role of roleList) metricRows[AGENT[role]] = metrics({ ...perRole[role], model: ROLE_BINDING[role].rail });

  return {
    context: 'live',
    live: true,
    owner: { profile: 'agent', agent_id: about === 'main' ? 'main' : AGENT[about] },
    available: true,
    // The profile block describes the agent this frame is ABOUT, not the agent
    // that happens to be selected. For the lead that is the coordinating
    // `agent` profile on Kimi K3; for a dispatched role it is that role's own
    // model, the same binding its live agent state reports.
    profile: {
      name: 'agent',
      description: about === 'main'
        ? pick(locale, 'Coordinates the release and routes each role to a model.', '统筹发布，并为每个角色选择模型。')
        : `${copy[about].description}.`,
      source: 'builtin',
      model: ROLE_BINDING[about].rail,
      thinking_effort: ROLE_BINDING[about].effort,
      thinking_effort_source: 'forced',
      profile_source: 'registered',
      subagent_policy: 'advisory',
      tools: ['Read', 'Grep', 'Bash', 'Edit', 'AgentRun'],
    },
    // `targets` is the DISPATCH menu: which profiles this agent may hand work
    // to, and the model each would run on. It describes candidates, never the
    // agent itself — a candidate binding is not the binding an agent runs on,
    // and conflating the two is what made the first pass of this frame wrong.
    targets: roleList.map((target) => ({
      profile: target,
      route: target,
      description: `${copy[target].description}.`,
      executor: 'native',
      model_alias: ROLE_BINDING[target].rail,
      model_source: 'profile',
      thinking_effort: ROLE_BINDING[target].effort,
      effort_source: 'profile',
      dispatch_policy: 'fixed',
      recommendation_status: 'preferred',
      advisory_deviation: false,
      defaults_available: true,
      launch_allowed: true,
    })),
    tools: [
      { name: 'Read', source: 'builtin', category: 'filesystem', state: 'enabled' },
      { name: 'Grep', source: 'builtin', category: 'filesystem', state: 'enabled' },
      { name: 'Bash', source: 'builtin', category: 'shell', state: 'enabled' },
      { name: 'Edit', source: 'builtin', category: 'filesystem', state: 'enabled' },
      { name: 'AgentRun', source: 'builtin', category: 'orchestration', state: 'enabled' },
    ],
    skills: [],
    metrics: metricRows,
    labels: copy.label,
  };
}

/**
 * `options.about` names the role whose panel this scene foregrounds — 'main' for
 * a lead frame, a role name for the subagent frame. See agentPanel above for
 * why the capability read has to describe that specific agent.
 */
function base(locale, roleList, options = {}) {
  const { about = 'main', ...sessionOptions } = options;
  return {
    config: sampleConfig(),
    models: sampleModels(),
    providers: sampleProviders(),
    workspaces: [sampleWorkspace()],
    sessions: sessions(locale, sessionOptions),
    agentPanel: agentPanel(locale, roleList, about),
    agentHooks: injectedRules(locale),
    // The rail's schedule block and the global scheduled-tasks page read this
    // one list (see sessionSchedules above), so both frames come off it.
    cronTasks: sessionSchedules(locale),
  };
}

// ---------------------------------------------------------------------------
// Goals, queue, background tasks
// ---------------------------------------------------------------------------

function goalDocument(locale, tokensUsed) {
  return {
    goalId: 'goal_wl_release',
    objective: pick(locale, 'Prepare the sample-app release', '准备 sample-app 发布'),
    completionCriterion: pick(
      locale,
      'Docs build green, tests approved, changelog drafted',
      '文档构建通过、测试完成、更新日志起草完毕',
    ),
    status: 'active',
    followUpTiming: 'subagents_done',
    controlRevision: 4,
    turnsUsed: 2,
    tokensUsed,
    wallClockMs: 480_000,
    budget: {
      tokenBudget: 40_000,
      turnBudget: 12,
      wallClockBudgetMs: 1_800_000,
      remainingTokens: 40_000 - tokensUsed,
      remainingTurns: 10,
      remainingWallClockMs: 1_320_000,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

function goalMeta(locale, budgetUsed) {
  return {
    objective: pick(locale, 'Prepare the sample-app release', '准备 sample-app 发布'),
    status: 'active',
    completionCriterion: pick(
      locale,
      'Docs build green, tests approved, changelog drafted',
      '文档构建通过、测试完成、更新日志起草完毕',
    ),
    followUpTiming: 'subagents_done',
    controlRevision: 4,
    budgetUsed,
    budgetLimit: 40_000,
  };
}

function queuedPrompt(id, messageId, minutesAgo, position, timing, revision, text) {
  return {
    promptId: id,
    userMessageId: messageId,
    status: 'queued',
    content: [{ type: 'text', text }],
    createdAt: ts(minutesAgo),
    queuePosition: position,
    appendTiming: timing,
    revision,
  };
}

/** One running shell task: the rail's background strip and the tasks page. */
function docsPreviewTask(locale) {
  return {
    id: 'task_wl_docs_preview',
    session_id: SESSION.release,
    kind: 'bash',
    description: pick(locale, 'docs preview build', '文档预览构建'),
    status: 'running',
    command: 'pnpm --filter docs dev',
    created_at: ts(6),
    started_at: ts(6),
    run_in_background: true,
    output_preview: pick(
      locale,
      'vite v6.4.2 building preview…\ntransforming 128 modules…',
      'vite v6.4.2 正在构建预览…\n正在转换 128 个模块…',
    ),
    output_bytes: 4096,
  };
}

/** A completed and a failed task, so the tasks page shows real outcomes. */
function taskPageRows(locale) {
  return [
    {
      id: 'task_wl_watch',
      session_id: SESSION.release,
      kind: 'bash',
      description: pick(locale, 'sample-app test suite (watch)', 'sample-app 测试套件（watch）'),
      status: 'running',
      command: 'pnpm --filter sample-app test -- --watch',
      created_at: ts(4),
      started_at: ts(4),
      run_in_background: true,
      output_preview: pick(
        locale,
        'PASS  src/release/checklist.test.ts\nPASS  src/release/upgrade.test.ts\nwatching for changes…',
        'PASS  src/release/checklist.test.ts\nPASS  src/release/upgrade.test.ts\n正在监听改动…',
      ),
      output_bytes: 8192,
    },
    {
      id: 'task_wl_docs_build',
      session_id: SESSION.release,
      kind: 'bash',
      description: pick(locale, 'docs preview build', '文档预览构建'),
      status: 'completed',
      command: 'pnpm --filter docs build',
      created_at: ts(11),
      started_at: ts(11),
      completed_at: ts(9),
      run_in_background: true,
      output_preview: pick(
        locale,
        'build complete in 18.2s · 41 warnings · 0 errors',
        '构建完成，用时 18.2s · 41 告警 · 0 错误',
      ),
      output_bytes: 16_384,
    },
    {
      id: 'task_wl_smoke',
      session_id: SESSION.release,
      kind: 'bash',
      description: pick(locale, 'arm64 smoke suite', 'arm64 冒烟套件'),
      status: 'failed',
      command: 'pnpm --filter sample-app test:smoke -- --arch arm64',
      created_at: ts(28),
      started_at: ts(28),
      completed_at: ts(26),
      run_in_background: true,
      output_preview: pick(
        locale,
        'FAIL  smoke/launch.test.ts › times out under load (18 000 ms)\nexit code 1',
        'FAIL  smoke/launch.test.ts › 负载下超时（18 000 ms）\n退出码 1',
      ),
      output_bytes: 32_768,
    },
  ];
}

// ---------------------------------------------------------------------------
// WL1 — the lead session, ready for the workbench frames
// ---------------------------------------------------------------------------

/**
 * The fleet workbench with every rail block carrying real content. This is the
 * base for the hero, the per-role-model close-up and the subagent frame: the
 * difference between those three is only which part of the window is
 * foregrounded, so they share one world and cannot drift apart.
 */
export function buildWl1(locale) {
  const roleList = ['thinker', 'explorer', 'builder', 'reviewer'];
  const turns = roleTurns(locale);
  const queued = [
    queuedPrompt(
      'prompt_wl_changelog',
      'um_wl_changelog',
      7,
      0,
      'subagents_done',
      1,
      pick(locale, 'Draft the changelog entries once the subagents are done.', '子智能体完成后，起草更新日志条目。'),
    ),
    queuedPrompt(
      'prompt_wl_artifacts',
      'um_wl_artifacts',
      5,
      1,
      'tasks_done',
      2,
      pick(
        locale,
        'Archive the release files once the build task finishes.',
        '构建任务结束后，归档发布产物。',
      ),
    ),
  ];
  return {
    ...base(locale, roleList, { busy: true }),
    snapshots: {
      [SESSION.release]: {
        messages: [],
        has_more: false,
        tasks: [docsPreviewTask(locale)],
        subagents: roster(locale, FLEET),
        queued_prompts: queued,
        goal: goalDocument(locale, 9_600),
        agent_transcripts: {
          main: {
            agent_id: 'main',
            has_more: false,
            tool_call_count: 6,
            items: [
              turn({
                turnId: 't1',
                ordinal: 1,
                prompt: pick(
                  locale,
                  'Prepare the sample-app 0.4 release; give each role the model it deserves.',
                  '准备 sample-app 0.4 发布，并为每个角色选好模型。',
                ),
                minutesAgo: 18,
                frames: [
                  toolFrame({ frameId: 'wl1-read-releasing', toolCallId: 'call_wl1_releasing', name: 'Read', input: { path: 'docs/RELEASING.md' }, output: pick(locale, 'Release checklist with 9 steps.', '发布检查清单，共 9 步。') }),
                  toolFrame({ frameId: 'wl1-grep-checklist', toolCallId: 'call_wl1_grep', name: 'Grep', input: { pattern: 'release checklist' }, output: pick(locale, '3 matches in docs/RELEASING.md.', 'docs/RELEASING.md 中 3 处匹配。') }),
                  toolFrame({ frameId: 'wl1-bash-docs', toolCallId: 'call_wl1_docs', name: 'Bash', input: { command: 'pnpm -r build docs' }, output: pick(locale, 'docs: build succeeded in 12.4s, 0 errors.', 'docs: 构建成功，用时 12.4s，0 错误。') }),
                  textFrame({
                    frameId: 'wl1-note',
                    text: pick(
                      locale,
                      'Docs build is clean. Sending the upgrade call to Astra at xhigh and the review to Fable, and handing the mechanical passes to DeepSeek and GLM.',
                      '文档构建干净。升级取舍交给 xhigh 的 Astra，评审交给 Fable，机械改动交给 DeepSeek 与 GLM。',
                    ),
                  }),
                ],
              }),
              turn({
                turnId: 't2',
                ordinal: 2,
                prompt: pick(
                  locale,
                  'Land the changelog, then have the reviewer confirm the tests.',
                  '把更新日志落地，再让审阅者确认测试。',
                ),
                minutesAgo: 11,
                frames: [
                  toolFrame({ frameId: 'wl2-bash-version', toolCallId: 'call_wl2_version', name: 'Bash', input: { command: 'pnpm changeset status' }, output: pick(locale, 'No changesets pending for sample-app.', 'sample-app 没有待处理的 changeset。') }),
                  textFrame({
                    frameId: 'wl2-note',
                    text: pick(
                      locale,
                      'No pending changesets, so the changelog is the only thing left to draft before the tag. Handing the draft to the Builder and the suite to the Reviewer.',
                      '没有待处理的 changeset，所以打标前只剩更新日志要起草。起草交给构建者，测试套件交给审阅者。',
                    ),
                  }),
                ],
              }),
              turn({
                turnId: 't3',
                ordinal: 3,
                prompt: pick(
                  locale,
                  'Land the changelog, then have the reviewer confirm the tests.',
                  '把更新日志落地，再让审阅者确认测试。',
                ),
                minutesAgo: 4,
                state: 'running',
                frames: [{ kind: 'thinking', frameId: 'wl1-think', text: pick(locale, 'The changelog draft and the test run are both in flight.', '更新日志草稿和测试都在进行中。') }],
              }),
            ],
            prompts: queued,
            todos: [{              todoId: 'todo',
              items: leadTodos(locale),
              notes: leadNotes(locale),
              notesMeta: { rev: 4, hash: 'wl-notes-r4', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: 'um_wl_release', windowEpoch: 1 },
            }],
            meta: { activity: 'turn', goal: goalMeta(locale, 9_600), agent: runningMeta({ turnId: 3, role: 'main' }) },
          },
          [AGENT.thinker]: {
            agent_id: AGENT.thinker,
            has_more: false,
            tool_call_count: 3,
            items: [turns.thinker],
            todos: [{
              todoId: 'todo',
              items: [
                { title: pick(locale, 'Read the rollout checklist', '读一遍发布清单'), status: 'done' },
                { title: pick(locale, 'Name the breaking changes', '指出破坏性变更'), status: 'done' },
              ],
              notes: {
                goal: pick(locale, 'Call the 0.4 upgrade path and its trade-offs.', '给出 0.4 升级路径及其取舍结论。'),
                decided: pick(
                  locale,
                  'Staged rollout: 0.4 to the two canary workspaces first, then everyone.',
                  '分阶段发布：0.4 先发两个金丝雀工作区，再面向全部。',
                ),
                evidence: pick(
                  locale,
                  'docs/RELEASING.md lists 9 steps; steps 4 and 7 need a human.',
                  'docs/RELEASING.md 共 9 步，其中第 4、7 步需要人工。',
                ),
                next: pick(locale, 'Hand the two flags to the Builder.', '把两处标注交给构建者。'),
              },
              notesMeta: { rev: 2, hash: 'wl-thinker-r2', writtenTurn: 5, writtenStep: 't5.2', coveredMessageId: 'um_wl_thinker', windowEpoch: 0 },
            }],
            meta: { activity: 'idle', agent: completedMeta({ turnId: 1, role: 'thinker' }) },
          },
          [AGENT.explorer]: {
            agent_id: AGENT.explorer,
            has_more: false,
            tool_call_count: 4,
            items: [turns.explorer],
            todos: [{
              todoId: 'todo',
              items: [
                { title: pick(locale, 'Map the docs tree', '梳理文档结构'), status: 'done' },
                { title: pick(locale, 'Find the 0.3 leftovers', '找出 0.3 残留'), status: 'done' },
              ],
              notes: {
                goal: pick(locale, 'Map the docs tree and the release scripts.', '梳理文档结构与发布脚本。'),
                evidence: pick(
                  locale,
                  'grep 0.3.0-rc.1 in docs → 3 matches, all in docs/upgrade-0.4.md.',
                  '在 docs 中 grep 0.3.0-rc.1 → 3 处匹配，均在 docs/upgrade-0.4.md。',
                ),
                files: pick(locale, 'docs/upgrade-0.4.md', 'docs/upgrade-0.4.md'),
              },
              notesMeta: { rev: 1, hash: 'wl-explorer-r1', writtenTurn: 4, writtenStep: 't4.1', coveredMessageId: 'um_wl_explorer', windowEpoch: 0 },
            }],
            meta: { activity: 'idle', agent: completedMeta({ turnId: 1, role: 'explorer' }) },
          },
          [AGENT.builder]: {
            agent_id: AGENT.builder,
            has_more: false,
            tool_call_count: 3,
            items: [turns.builder],
            todos: [{
              todoId: 'todo',
              items: [{ title: pick(locale, 'Fold in the feature commits', '并入 feature 提交'), status: 'in_progress' }],
              notes: {
                goal: pick(locale, 'Draft the 0.4 changelog.', '起草 0.4 更新日志。'),
                next: pick(locale, 'Rewrite the three 0.3 leftovers in the upgrade guide.', '改掉升级指南里三处 0.3 残留。'),
              },
              notesMeta: { rev: 1, hash: 'wl-builder-r1', writtenTurn: 3, writtenStep: 't3.1', coveredMessageId: 'um_wl_builder', windowEpoch: 0 },
            }],
            meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'builder' }) },
          },
          [AGENT.reviewer]: {
            agent_id: AGENT.reviewer,
            has_more: false,
            tool_call_count: 2,
            items: [turns.reviewer],
            todos: [{
              todoId: 'todo',
              items: [{ title: pick(locale, 'Run the suite', '运行测试套件'), status: 'in_progress' }],
              notes: {
                goal: pick(locale, 'Run the sample-app test suite.', '运行 sample-app 测试套件。'),
              },
              notesMeta: { rev: 1, hash: 'wl-reviewer-r1', writtenTurn: 2, writtenStep: 't2.1', coveredMessageId: 'um_wl_reviewer', windowEpoch: 0 },
            }],
            meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'reviewer' }) },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// WL2 — background tasks page
// ---------------------------------------------------------------------------

/** `/s/:id/tasks`: running with a stop control, completed, and failed. */
export function buildWl2(locale) {
  const wl1 = buildWl1(locale);
  const tasks = taskPageRows(locale);
  return {
    ...wl1,
    sessions: wl1.sessions.map((session) => (session.id === SESSION.release ? session : session)),
    snapshots: {
      [SESSION.release]: {
        ...wl1.snapshots[SESSION.release],
        tasks,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// WL3 — the subagent opened in the rail
// ---------------------------------------------------------------------------

/**
 * Same world, one subagent's own record in the foreground. The Explorer is the
 * subject: it is finished, so its record shows a complete turn with tool steps
 * and its own working notes and model binding — which is exactly the "a
 * subagent keeps its own record" claim the workbench page makes in prose.
 *
 * `about: 'explorer'` is the load-bearing line. The capability read describes
 * the agent this frame is about, so the rail's identity block reads
 * GLM 5.3 Flash under the Explorer's name — the same model the live agent state
 * already reports — instead of the lead's binding. Without it the frame showed
 * the Explorer selected next to the lead's identity, which claimed the rail
 * projects main onto a child; it does not, and the seed was simply answering
 * one static panel for every agent.
 */
export function buildWl3(locale) {
  const wl1 = buildWl1(locale);
  // The main turn is still live — the reader is watching the lead's own work,
  // not an idle session — but the rail's roster keeps the Explorer selectable.
  return {
    ...wl1,
    agentPanel: agentPanel(locale, ['thinker', 'explorer', 'builder', 'reviewer'], 'explorer'),
    snapshots: {
      [SESSION.release]: {
        ...wl1.snapshots[SESSION.release],
        subagents: roster(locale, [
          { role: 'explorer', status: 'completed', created: 9, started: 8, completed: 5, toolCalls: 4 },
          { role: 'builder', status: 'running', created: 6, started: 5, toolCalls: 3 },
          { role: 'reviewer', status: 'running', created: 5, started: 4, toolCalls: 2 },
        ]),
        // Only the Explorer has a record, so opening it by id cannot land on
        // a different agent than the frame claims to be about.
        agent_transcripts: {
          [AGENT.explorer]: wl1.snapshots[SESSION.release].agent_transcripts[AGENT.explorer],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// WL4 — scheduled tasks (the global cron panel)
// ---------------------------------------------------------------------------

/** `/cron`: four plans across the workspace, with schedules and real states. */
export function buildWl4(locale) {
  const wl1 = buildWl1(locale);
  return { ...wl1, cronTasks: globalSchedules(locale) };
}

// ---------------------------------------------------------------------------
// WL5 — the task board
// ---------------------------------------------------------------------------

/**
 * `/board`: a workspace's requirements as cards, several in flight, one
 * linked to the release session beside it. The card detail is seeded too, so
 * the frame can show a card opened with its own goal text rather than a title
 * and nothing else.
 */
export function buildWl5(locale) {
  const wl1 = buildWl1(locale);
  /**
   * A card summary in the shape the board read actually validates: `storage` is
   * the storage OBJECT (not a `storageId` string) and `completedAt` is present
   * and nullable. Get either wrong and the whole read fails, which is what puts
   * "Task board is unavailable right now" on the page. `description` is not on
   * a summary — it arrives from the `detail` map on a `show` read.
   */
  const storage = { root: PROJECT_ROOT, storageId: 'board_sample_app', kind: 'workspace' };
  const card = (id, title, { priority, status, category, minutesAgo, sessionIds = [], revision, completed = false }) => ({
    id,
    workspaceId: WORKSPACE_ID,
    storage,
    title,
    priority,
    status,
    revision,
    createdAt: ts(minutesAgo + 600),
    updatedAt: ts(minutesAgo),
    completedAt: completed ? ts(minutesAgo) : null,
    archived: false,
    category,
    sessionIds,
    executionIds: [],
  });
  const cards = [
    card('board_wl_release', pick(locale, 'Prepare the sample-app 0.4 release', '准备 sample-app 0.4 发布'),
      { priority: 'P1', status: 'active', category: 'release', minutesAgo: 4, sessionIds: [SESSION.release], revision: 3 }),
    card('board_wl_changelog', pick(locale, 'Draft the 0.4 changelog', '起草 0.4 更新日志'),
      { priority: 'P1', status: 'in_progress', category: 'docs', minutesAgo: 6, sessionIds: [SESSION.release, SESSION.documentation], revision: 5 }),
    card('board_wl_tests', pick(locale, 'Run the sample-app test suite', '运行 sample-app 测试套件'),
      { priority: 'P0', status: 'in_progress', category: 'quality', minutesAgo: 3, sessionIds: [SESSION.accessibility], revision: 4 }),
    card('board_wl_a11y', pick(locale, 'Consolidate the accessibility checklist', '整理无障碍检查清单'),
      { priority: 'P2', status: 'active', category: 'quality', minutesAgo: 46, sessionIds: [SESSION.accessibility], revision: 2 }),
    card('board_wl_upgrade', pick(locale, 'Rework the upgrade guide', '升级指南改版'),
      { priority: 'P2', status: 'paused', category: 'docs', minutesAgo: 320, revision: 2 }),
    card('board_wl_docs_warn', pick(locale, 'Fix the docs build warnings', '修复文档构建告警'),
      { priority: 'P2', status: 'done', category: 'docs', minutesAgo: 180, sessionIds: [SESSION.documentation], revision: 6, completed: true }),
    card('board_wl_a11y_scan', pick(locale, 'Re-check the accessibility scan', '无障碍扫描复核'),
      { priority: 'P3', status: 'done', category: 'quality', minutesAgo: 620, revision: 3, completed: true }),
  ];
  return {
    ...wl1,
    taskBoard: {
      storage: { root: PROJECT_ROOT, storageId: 'board_sample_app', kind: 'workspace' },
      cards,
      detail: {
        board_wl_changelog: {
          description: pick(
            locale,
            'Fold the 0.3 → 0.4 changes into changelog entries and add the upgrade note.',
            '把 0.3 → 0.4 的变更整理成更新日志条目，并补充升级说明。',
          ),
          prd: pick(
            locale,
            '## Goal\n\n- cover the new accessibility checks\n- call out both breaking changes\n- keep entries one line per merged PR\n',
            '## 目标\n\n- 覆盖新增的无障碍检查\n- 标注两处破坏性变更\n- 每条对应一个已合并 PR\n',
          ),
        },
        board_wl_tests: {
          description: pick(
            locale,
            'The suite green before the tag, and the arm64 smoke retry budget settled.',
            '打标前测试套件全绿，并确定 arm64 冒烟的重试预算。',
          ),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// WL6 — the goal and the queue, foregrounded
// ---------------------------------------------------------------------------

/**
 * The long-work page's first two claims in one window: a goal carrying across
 * turns, and the two queued messages with their own send timings. Same world as
 * WL1 — the frame is the same session with its dock elements opened, so the
 * hero, this frame, and the subagent frame cannot tell three different stories.
 */
export function buildWl6(locale) {
  return buildWl1(locale);
}

// ---------------------------------------------------------------------------
// WL7 — the context card, with Fresh as the selected strategy
// ---------------------------------------------------------------------------

/**
 * The context window card. The lead's own history has filled most of the window
 * and Fresh is the selected renewal strategy, so the frame shows the track
 * with a real used/compaction-point/ceiling relationship and the three-way
 * choice actually on Fresh.
 *
 * `contextStrategy.overrides` is the real seed key
 * (scripts/fixture-context-strategy.mjs:22): a session override wins over the
 * profile and the global value, which is what puts the source label on
 * "session" and gives the reader a scope they can see the value came from.
 */
export function buildWl7(locale) {
  const wl1 = buildWl1(locale);
  return {
    ...wl1,
    contextStrategy: { overrides: { [SESSION.release]: 'fresh' } },
    // `autoCompact.overrides[sessionId][agentId][modelId]` is the real seed
    // shape (scripts/fixture-auto-compact.mjs:104). It is keyed by MODEL id,
    // not the display alias the rail shows, so this lands as a session-level
    // compaction point of 212.1k and the track's used/point/ceiling becomes a
    // real relationship rather than a default.
    autoCompact: {
      overrides: { [SESSION.release]: { main: { [ROLE_BINDING.main.id]: 212_100 } } },
    },
  };
}
