/**
 * marketing-builders — locale-aware builders for the promotional scenarios.
 *
 * The design brief requires the zh images to be the SAME screen translated:
 * identical ids and structure, translated titles and body copy. Each
 * `buildX(locale)` therefore returns the whole fixture-server scenario object
 * for `en` or `zh`; the thin `marketing-*.scenario.mjs` files in this directory
 * are just `<composition>-<locale>` entry points.
 *
 * These are fixture-server data shapes only (see helpers.mjs and
 * fixture-transcript.mjs). No product code is involved.
 */

import { ts } from './helpers.mjs';
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
  sampleSessions,
  sampleWorkspace,
  textFrame,
  toolFrame,
  turn,
} from './marketing-scene.mjs';

const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);
const LOCALIZED_SESSIONS = {
  en: { release: 'Prepare the release', accessibility: 'Review accessibility', documentation: 'Update documentation' },
  zh: { release: '准备 sample-app 发布', accessibility: '检查无障碍', documentation: '更新文档' },
};

function localizedSessions(locale, { busy = true } = {}) {
  const titles = LOCALIZED_SESSIONS[locale] ?? LOCALIZED_SESSIONS.en;
  return sampleSessions().map((session) => {
    const title = session.id === SESSION.release
      ? titles.release
      : session.id === SESSION.accessibility
        ? titles.accessibility
        : titles.documentation;
    const next = { ...session, title };
    // Settings-only shots have no live turn; a busy release session would show
    // a resting 0:00 run timer in the sidebar for no reason.
    if (!busy && session.id === SESSION.release) {
      next.busy = false;
      next.main_turn_active = false;
      next.pending_interaction = 'none';
    }
    return next;
  });
}

const AGENT_LABEL = {
  en: { explorer: 'Explorer', builder: 'Builder', reviewer: 'Reviewer', thinker: 'Thinker' },
  zh: { explorer: '探索者', builder: '构建者', reviewer: '审阅者', thinker: '思考者' },
};

function subagentsCopy(locale) {
  const label = AGENT_LABEL[locale] ?? AGENT_LABEL.en;
  return {
    explorer: {
      label: label.explorer,
      description: pick(locale, 'Isolate context and gather sources', '隔离上下文并收集来源'),
      summary: pick(locale, 'Docs tree and release scripts mapped; no version drift found.', '文档结构与发布脚本已梳理完毕，未发现版本漂移。'),
      prompt: pick(locale, 'Map the docs tree and the release scripts.', '梳理文档结构与发布脚本。'),
    },
    thinker: {
      label: label.thinker,
      description: pick(locale, 'Weigh the upgrade path and call the trade-offs', '评估升级路径并给出取舍结论'),
      summary: pick(locale, 'Recommended a staged rollout; listed the two breaking changes to flag.', '建议分阶段发布，并列出需标注的两处破坏性变更。'),
      prompt: pick(locale, 'Think through the upgrade path for 0.4 and name the trade-offs.', '思考 0.4 的升级路径，并指出取舍。'),
    },
    builder: {
      label: label.builder,
      description: pick(locale, 'Draft the 0.4 changelog', '起草 0.4 更新日志'),
      prompt: pick(locale, 'Draft the 0.4 changelog.', '起草 0.4 更新日志。'),
    },
    reviewer: {
      label: label.reviewer,
      description: pick(locale, 'Run the sample-app test suite', '运行 sample-app 测试套件'),
      prompt: pick(locale, 'Run the sample-app test suite.', '运行 sample-app 测试套件。'),
    },
  };
}

/** Per-agent transcript turn content (tool frames give the rail real counts). */
function subagentTurns(locale) {
  const copy = subagentsCopy(locale);
  return {
    thinker: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.thinker.prompt,
      minutesAgo: 11,
      frames: [
        toolFrame({ frameId: 'mk-th-read-releasing', toolCallId: 'call_th_releasing', name: 'Read', input: { path: 'docs/RELEASING.md' }, output: pick(locale, 'Staged-rollout checklist, 9 steps.', '分阶段发布清单，共 9 步。') }),
        toolFrame({ frameId: 'mk-th-grep-breaking', toolCallId: 'call_th_breaking', name: 'Grep', input: { pattern: 'BREAKING' }, output: pick(locale, '2 breaking changes to flag.', '需标注 2 处破坏性变更。') }),
        textFrame({ frameId: 'mk-th-summary', text: copy.thinker.summary }),
      ],
    }),
    explorer: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.explorer.prompt,
      minutesAgo: 9,
      frames: [
        toolFrame({ frameId: 'mk-ex-read-releasing', toolCallId: 'call_ex_releasing', name: 'Read', input: { path: 'docs/RELEASING.md' }, output: pick(locale, 'Release checklist with 9 steps.', '发布检查清单，共 9 步。') }),
        toolFrame({ frameId: 'mk-ex-grep-version', toolCallId: 'call_ex_version', name: 'Grep', input: { pattern: 'version', path: 'package.json' }, output: pick(locale, '3 matches; current 0.4.0-rc.1.', '3 处匹配；当前 0.4.0-rc.1。') }),
        toolFrame({ frameId: 'mk-ex-read-a11y', toolCallId: 'call_ex_a11y', name: 'Read', input: { path: 'docs/accessibility.md' }, output: pick(locale, 'Checklist carried over from 0.3.', '检查清单沿用 0.3 版本。') }),
        toolFrame({ frameId: 'mk-ex-gitlog', toolCallId: 'call_ex_gitlog', name: 'Bash', input: { command: 'git log --oneline -20' }, output: pick(locale, '20 commits since 0.3.0.', '自 0.3.0 起共 20 次提交。') }),
        textFrame({ frameId: 'mk-ex-summary', text: copy.explorer.summary }),
      ],
    }),
    builder: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.builder.prompt,
      minutesAgo: 5,
      state: 'running',
      frames: [
        toolFrame({ frameId: 'mk-bu-read-changelog', toolCallId: 'call_bu_changelog', name: 'Read', input: { path: 'CHANGELOG.md' }, output: pick(locale, 'Latest entry: 0.3.0.', '最新条目：0.3.0。') }),
        toolFrame({ frameId: 'mk-bu-grep-feat', toolCallId: 'call_bu_feat', name: 'Grep', input: { pattern: 'feat\\(' }, output: pick(locale, '6 feature commits to fold in.', '需并入 6 条 feature 提交。') }),
        toolFrame({ frameId: 'mk-bu-read-upgrade', toolCallId: 'call_bu_upgrade', name: 'Read', input: { path: 'docs/upgrade-0.4.md' }, output: undefined, state: 'running' }),
      ],
    }),
    reviewer: turn({
      turnId: 't1',
      ordinal: 1,
      prompt: copy.reviewer.prompt,
      minutesAgo: 4,
      state: 'running',
      frames: [
        toolFrame({ frameId: 'mk-rv-read-a11y', toolCallId: 'call_rv_a11y', name: 'Read', input: { path: 'docs/accessibility.md' }, output: pick(locale, 'Checklist restored.', '检查清单已恢复。') }),
        toolFrame({ frameId: 'mk-rv-bash-test', toolCallId: 'call_rv_test', name: 'Bash', input: { command: 'pnpm test --filter sample-app' }, output: undefined, state: 'running' }),
      ],
    }),
  };
}

/**
 * Snapshot roster rows for the dispatch tree. Each row carries its role's
 * model binding (the REAL wire field is a display-normalized alias, so the
 * rail label is the alias and `thinking_effort` the role's effort).
 */
function subagentRoster(locale, rows = DEFAULT_ROSTER) {
  const copy = subagentsCopy(locale);
  return rows.map(({ role, status, created, started, completed, toolCalls }) => ({
    id: `task_mk_${role}`,
    session_id: SESSION.release,
    kind: 'subagent',
    status,
    description: copy[role].description,
    agent_id: AGENT[role],
    label: copy[role].label,
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

/** H01/R02 fleet: exploration done, execution + review still running. */
const DEFAULT_ROSTER = [
  { role: 'explorer', status: 'completed', created: 10, started: 9, completed: 6, toolCalls: 4 },
  { role: 'builder', status: 'running', created: 6, started: 5, toolCalls: 3 },
  { role: 'reviewer', status: 'running', created: 5, started: 4, toolCalls: 2 },
];

/** R05 fleet: judgement + execution landed, review and exploration in flight. */
const R05_ROSTER = [
  { role: 'thinker', status: 'completed', created: 14, started: 13, completed: 10, toolCalls: 5 },
  { role: 'builder', status: 'completed', created: 11, started: 10, completed: 7, toolCalls: 4 },
  { role: 'reviewer', status: 'running', created: 6, started: 5, toolCalls: 2 },
  { role: 'explorer', status: 'running', created: 4, started: 3, toolCalls: 2 },
];

function runningBuildTask(locale, sessionId) {
  return {
    id: 'task_mk_docs_preview',
    session_id: sessionId,
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

function goalMeta(locale, budgetUsed = 8_400) {
  return {
    objective: pick(locale, 'Prepare the sample-app release', '准备 sample-app 发布'),
    status: 'active',
    completionCriterion: pick(locale, 'Docs build green, tests approved, changelog drafted', '文档构建通过、测试完成、更新日志起草完毕'),
    followUpTiming: 'subagents_done',
    controlRevision: 4,
    budgetUsed,
    budgetLimit: 40_000,
  };
}

function goalDocument(locale, tokensUsed) {
  return {
    goalId: 'goal_mk_release',
    objective: pick(locale, 'Prepare the sample-app release', '准备 sample-app 发布'),
    completionCriterion: pick(locale, 'Docs build green, tests approved, changelog drafted', '文档构建通过、测试完成、更新日志起草完毕'),
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

/**
 * Agent-panel metrics keyed by agent id. `metrics` MUST cover every rostered
 * agent (main + the roles the shot shows) or the tree totals fall back to
 * "Unknown"; `targets` must carry the same per-role model aliases the dispatch
 * tree shows.
 */
function agentPanel(locale, roles) {
  const metrics = ({ input, output, cacheRead, contextTokens, cost, compactions = 0, model }) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: input + output,
    totalCostUsd: cost,
    contextTokens,
    contextLimit: 262_144,
    compactionCount: compactions,
    usageSource: 'live',
    model,
  });
  const copy = subagentsCopy(locale);
  const label = AGENT_LABEL[locale] ?? AGENT_LABEL.en;
  const target = (role, status) => ({
    profile: role,
    route: role,
    description: `${copy[role].description}.`,
    executor: 'native',
    model_alias: ROLE_BINDING[role].rail,
    model_source: 'profile',
    thinking_effort: ROLE_BINDING[role].effort,
    effort_source: 'profile',
    dispatch_policy: 'advisory',
    recommendation_status: status,
    advisory_deviation: false,
    defaults_available: true,
    launch_allowed: true,
  });
  const perRoleUsage = {
    thinker: { input: 54_200, output: 12_800, cacheRead: 38_000, contextTokens: 16_400, cost: 0.86 },
    explorer: { input: 42_100, output: 5_200, cacheRead: 31_000, contextTokens: 12_400, cost: 0.31 },
    builder: { input: 61_800, output: 9_400, cacheRead: 44_200, contextTokens: 18_900, cost: 0.58 },
    reviewer: { input: 33_500, output: 4_100, cacheRead: 22_800, contextTokens: 9_600, cost: 0.24 },
  };
  const metricRows = {
    main: metrics({ input: 128_400, output: 18_600, cacheRead: 96_400, contextTokens: 41_200, cost: 1.42, compactions: 1, model: ROLE_BINDING.main.rail }),
  };
  for (const role of roles) {
    metricRows[AGENT[role]] = metrics({ ...perRoleUsage[role], model: ROLE_BINDING[role].rail });
  }
  return {
    context: 'live',
    live: true,
    owner: { profile: 'agent', agent_id: 'main' },
    available: true,
    profile: {
      name: 'agent',
      description: pick(locale, 'Coordinates the release and routes each role to a model.', '统筹发布，并为每个角色选择模型。'),
      source: 'builtin',
      model: ROLE_BINDING.main.rail,
      thinking_effort: ROLE_BINDING.main.effort,
      thinking_effort_source: 'forced',
      profile_source: 'registered',
      subagent_policy: 'advisory',
      tools: ['Read', 'Grep', 'Bash', 'Edit', 'AgentRun'],
    },
    targets: roles.map((role) => target(role, role === 'reviewer' ? 'allowed_nonpreferred' : 'preferred')),
    tools: [
      { name: 'Read', source: 'builtin', category: 'filesystem', state: 'enabled' },
      { name: 'Grep', source: 'builtin', category: 'filesystem', state: 'enabled' },
      { name: 'Bash', source: 'builtin', category: 'shell', state: 'enabled' },
      { name: 'Edit', source: 'builtin', category: 'filesystem', state: 'enabled' },
      { name: 'AgentRun', source: 'builtin', category: 'orchestration', state: 'enabled' },
    ],
    skills: [],
    metrics: metricRows,
    labels: label,
  };
}

function base(locale, options) {
  const roles = options?.roles ?? ['explorer', 'builder', 'reviewer'];
  return {
    config: sampleConfig(),
    models: sampleModels(),
    providers: sampleProviders(),
    agentPanel: agentPanel(locale, roles),
    workspaces: [sampleWorkspace()],
    sessions: localizedSessions(locale, options),
  };
}

// ---------------------------------------------------------------------------
// H01 — fleet workbench (transcript + dispatch tree + goal/queue dock)
// ---------------------------------------------------------------------------

export function buildH01(locale) {
  const turns = subagentTurns(locale);
  const queued = {
    promptId: 'prompt_mk_notes_pdf',
    userMessageId: 'um_mk_notes_pdf',
    status: 'queued',
    content: [{ type: 'text', text: pick(locale, 'Once the tests settle, regenerate the release notes PDF.', '等测试稳定后，重新生成发布说明 PDF。') }],
    createdAt: ts(2),
    queuePosition: 0,
    appendTiming: 'subagents_done',
    revision: 1,
  };
  return {
    ...base(locale),
    snapshots: {
      [SESSION.release]: {
        messages: [],
        has_more: false,
        tasks: [runningBuildTask(locale, SESSION.release)],
        subagents: subagentRoster(locale),
        queued_prompts: [queued],
        goal: goalDocument(locale, 8_400),
        agent_transcripts: {
          main: {
            agent_id: 'main',
            has_more: false,
            items: [
              turn({
                turnId: 't1',
                ordinal: 1,
                prompt: pick(locale, 'Cut the sample-app 0.4 release: verify the docs build and draft the changelog.', '切出 sample-app 0.4 发布：确认文档构建，并起草更新日志。'),
                minutesAgo: 12,
                frames: [
                  toolFrame({ frameId: 'mk-h-read-readme', toolCallId: 'call_h_readme', name: 'Read', input: { path: 'docs/README.md' }, output: pick(locale, 'Docs landing page, 214 lines.', '文档首页，214 行。') }),
                  toolFrame({ frameId: 'mk-h-grep-checklist', toolCallId: 'call_h_grep', name: 'Grep', input: { pattern: 'release checklist' }, output: pick(locale, '3 matches in docs/RELEASING.md.', 'docs/RELEASING.md 中 3 处匹配。') }),
                  toolFrame({ frameId: 'mk-h-read-pkg', toolCallId: 'call_h_pkg', name: 'Read', input: { path: 'package.json' }, output: pick(locale, 'version 0.4.0-rc.1; workspace scripts intact.', '版本 0.4.0-rc.1；工作区脚本完整。') }),
                  toolFrame({ frameId: 'mk-h-bash-docs', toolCallId: 'call_h_docs', name: 'Bash', input: { command: 'pnpm -r build docs' }, output: pick(locale, 'docs: build succeeded in 12.4s.', 'docs: 构建成功，用时 12.4s。') }),
                  textFrame({ frameId: 'mk-h-note', text: pick(locale, 'Docs build is healthy. Routing the judgement work to Fable and the mechanical passes to DeepSeek and GLM.', '文档构建正常。判断类工作交给 Fable，机械改动交给 DeepSeek 与 GLM。') }),
                ],
              }),
              turn({
                turnId: 't2',
                ordinal: 2,
                prompt: pick(locale, 'Have the reviewer run the sample-app test suite before we tag.', '让审阅者在打标前跑一遍 sample-app 测试套件。'),
                minutesAgo: 3,
                state: 'running',
                frames: [{ kind: 'thinking', frameId: 'mk-h-think', text: pick(locale, 'The changelog draft and the test run are both in flight.', '更新日志草稿和测试都在进行中。') }],
              }),
            ],
            prompts: [queued],
            meta: { activity: 'turn', goal: goalMeta(locale), agent: runningMeta({ turnId: 2, role: 'main' }) },
          },
          [AGENT.explorer]: { agent_id: AGENT.explorer, has_more: false, tool_call_count: 4, items: [turns.explorer], meta: { activity: 'idle', agent: completedMeta({ turnId: 1, role: 'explorer' }) } },
          [AGENT.builder]: { agent_id: AGENT.builder, has_more: false, tool_call_count: 3, items: [turns.builder], meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'builder' }) } },
          [AGENT.reviewer]: { agent_id: AGENT.reviewer, has_more: false, tool_call_count: 2, items: [turns.reviewer], meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'reviewer' }) } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// R02 — goal card + expanded two-row queue strip
// ---------------------------------------------------------------------------

export function buildR02(locale) {
  const turns = subagentTurns(locale);
  const queued = [
    {
      promptId: 'prompt_mk_changelog',
      userMessageId: 'um_mk_changelog',
      status: 'queued',
      content: [{ type: 'text', text: pick(locale, 'Draft the changelog entries once the subagents are done.', '子智能体完成后，起草更新日志条目。') }],
      createdAt: ts(7),
      queuePosition: 0,
      appendTiming: 'subagents_done',
      revision: 1,
    },
    {
      promptId: 'prompt_mk_artifacts',
      userMessageId: 'um_mk_artifacts',
      status: 'queued',
      content: [{ type: 'text', text: pick(locale, 'Sweep the release artifacts into the evidence bundle after the build task finishes.', '构建任务结束后，把发布产物归入证据包。') }],
      createdAt: ts(5),
      queuePosition: 1,
      appendTiming: 'tasks_done',
      revision: 2,
    },
  ];
  const roster = subagentRoster(locale).filter((row) => row.agent_id !== AGENT.explorer);
  return {
    ...base(locale, { roles: ['builder', 'reviewer'] }),
    snapshots: {
      [SESSION.release]: {
        messages: [],
        has_more: false,
        tasks: [runningBuildTask(locale, SESSION.release)],
        subagents: roster,
        queued_prompts: queued,
        goal: goalDocument(locale, 9_600),
        agent_transcripts: {
          main: {
            agent_id: 'main',
            has_more: false,
            items: [
              turn({
                turnId: 't1',
                ordinal: 1,
                prompt: pick(locale, 'Cut the sample-app 0.4 release and keep the evidence together.', '切出 sample-app 0.4 发布，并把证据收拢在一起。'),
                minutesAgo: 14,
                frames: [
                  toolFrame({ frameId: 'mk-r2-read-readme', toolCallId: 'call_r2_read', name: 'Read', input: { path: 'docs/README.md' }, output: pick(locale, 'Docs landing page, 214 lines.', '文档首页，214 行。') }),
                  toolFrame({ frameId: 'mk-r2-bash-docs', toolCallId: 'call_r2_build', name: 'Bash', input: { command: 'pnpm -r build docs' }, output: pick(locale, 'docs: build succeeded in 12.4s.', 'docs: 构建成功，用时 12.4s。') }),
                  textFrame({ frameId: 'mk-r2-note', text: pick(locale, 'Docs build is healthy. Changelog runs on DeepSeek, review on Fable.', '文档构建正常。更新日志交给 DeepSeek，评审交给 Fable。') }),
                ],
              }),
              turn({
                turnId: 't2',
                ordinal: 2,
                prompt: pick(locale, 'Draft the changelog and run the test suite before we tag.', '先起草更新日志并跑测试套件，然后再打标。'),
                minutesAgo: 4,
                state: 'running',
                frames: [{ kind: 'thinking', frameId: 'mk-r2-think', text: pick(locale, 'Waiting for the draft and the test run.', '等待草稿与测试结果。') }],
              }),
            ],
            prompts: queued,
            meta: { activity: 'turn', goal: goalMeta(locale, 9_600), agent: runningMeta({ turnId: 2, role: 'main' }) },
          },
          [AGENT.builder]: { agent_id: AGENT.builder, has_more: false, tool_call_count: 3, items: [turns.builder], meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'builder' }) } },
          [AGENT.reviewer]: { agent_id: AGENT.reviewer, has_more: false, tool_call_count: 2, items: [turns.reviewer], meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'reviewer' }) } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// R05 — the multi-model fleet (dispatch tree close-up)
// ---------------------------------------------------------------------------

/**
 * Five nodes, four roles, four model bindings: judgement on the strong models
 * (Astra xhigh for thinking, Fable for review), execution/exploration on the
 * fast ones (DeepSeek, GLM). Mixed states — two landed, two in flight.
 */
export function buildR05(locale) {
  const turns = subagentTurns(locale);
  const roster = subagentRoster(locale, R05_ROSTER);
  return {
    ...base(locale, { roles: ['thinker', 'reviewer', 'builder', 'explorer'] }),
    snapshots: {
      [SESSION.release]: {
        messages: [],
        has_more: false,
        subagents: roster,
        agent_transcripts: {
          main: {
            agent_id: 'main',
            has_more: false,
            items: [
              turn({
                turnId: 't1',
                ordinal: 1,
                prompt: pick(locale, 'Prepare the sample-app 0.4 release; give each role the model it deserves.', '准备 sample-app 0.4 发布，并为每个角色选好模型。'),
                minutesAgo: 15,
                frames: [
                  toolFrame({ frameId: 'mk-r5-read', toolCallId: 'call_r5_read', name: 'Read', input: { path: 'docs/RELEASING.md' }, output: pick(locale, 'Release checklist with 9 steps.', '发布检查清单，共 9 步。') }),
                  textFrame({ frameId: 'mk-r5-note', text: pick(locale, 'Routing the upgrade call to Astra at xhigh, review to Fable, and the mechanical passes to DeepSeek and GLM.', '升级取舍交给 xhigh 的 Astra，评审交给 Fable，机械改动交给 DeepSeek 与 GLM。') }),
                ],
              }),
              turn({
                turnId: 't2',
                ordinal: 2,
                prompt: pick(locale, 'Land the changelog, then have the reviewer confirm the tests.', '把更新日志落地，再让审阅者确认测试。'),
                minutesAgo: 4,
                state: 'running',
                frames: [{ kind: 'thinking', frameId: 'mk-r5-think', text: pick(locale, 'Review and the source sweep are still running.', '评审与来源梳理仍在进行。') }],
              }),
            ],
            meta: { activity: 'turn', agent: runningMeta({ turnId: 2, role: 'main' }) },
          },
          [AGENT.thinker]: { agent_id: AGENT.thinker, has_more: false, tool_call_count: 5, items: [turns.thinker], meta: { activity: 'idle', agent: completedMeta({ turnId: 1, role: 'thinker' }) } },
          [AGENT.builder]: { agent_id: AGENT.builder, has_more: false, tool_call_count: 4, items: [turns.builder], meta: { activity: 'idle', agent: completedMeta({ turnId: 1, role: 'builder' }) } },
          [AGENT.reviewer]: { agent_id: AGENT.reviewer, has_more: false, tool_call_count: 2, items: [turns.reviewer], meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'reviewer' }) } },
          [AGENT.explorer]: { agent_id: AGENT.explorer, has_more: false, tool_call_count: 2, items: [turns.explorer], meta: { activity: 'turn', agent: runningMeta({ turnId: 1, role: 'explorer' }) } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// R01 — Settings → Subagents, file-backed reviewer profile raw editor
// ---------------------------------------------------------------------------

const REVIEWER_FILE = 'C:/Projects/sample-app/.kiki/agents/reviewer.md';

function reviewerMarkdown(locale) {
  const description = pick(locale, 'Review code changes and run the sample-app test suite.', '审阅代码改动并运行 sample-app 测试套件。');
  const body = pick(
    locale,
    [
      'You are the sample-app reviewer.',
      '',
      '- Read the diff and the failing spec before commenting.',
      '- Run `pnpm test --filter sample-app` and report the exact output.',
      "- Never push, tag, or run a release action without the operator's approval.",
    ].join('\n'),
    [
      '你是 sample-app 的审阅者。',
      '',
      '- 先读改动与失败的用例，再给出结论。',
      '- 运行 `pnpm test --filter sample-app`，并原样报告输出。',
      '- 未经操作者批准，不推送、不打标、不执行发布动作。',
    ].join('\n'),
  );
  return `---\nname: reviewer\ndescription: ${description}\nmodel: ${ROLE_BINDING.reviewer.id}\nthinking_effort: ${ROLE_BINDING.reviewer.effort}\ntools:\n  - Read\n  - Grep\n  - Bash\n---\n\n${body}\n`;
}

export function buildR01(locale) {
  const reviewerDescription = pick(locale, 'Review code changes and run the sample-app test suite.', '审阅代码改动并运行 sample-app 测试套件。');
  return {
    ...base(locale, { busy: false }),
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
    },
    fsFiles: {
      [REVIEWER_FILE]: { content: reviewerMarkdown(locale), mime: 'text/markdown' },
    },
    agentProfiles: [
      {
        name: 'agent',
        source: 'builtin',
        description: pick(locale, 'General-purpose built-in assistant.', '通用内置助手。'),
        main: true,
        subagent_policy: 'advisory',
        pinned_model_alias: ROLE_BINDING.main.id,
        thinking_effort: ROLE_BINDING.main.effort,
        subagents: ['explore', 'reviewer', 'builder'],
        routes: [],
      },
      {
        name: 'explore',
        source: 'builtin',
        description: pick(locale, 'Read-only codebase exploration agent.', '只读的代码库探索智能体。'),
        main: false,
        subagent_policy: 'advisory',
        pinned_model_alias: ROLE_BINDING.explorer.id,
        thinking_effort: ROLE_BINDING.explorer.effort,
        routes: [],
      },
      {
        name: 'builder',
        source: 'builtin',
        description: pick(locale, 'Implements scoped changes and runs the build.', '实现范围内改动并运行构建。'),
        main: false,
        subagent_policy: 'advisory',
        pinned_model_alias: ROLE_BINDING.builder.id,
        thinking_effort: ROLE_BINDING.builder.effort,
        routes: [],
      },
      {
        name: 'reviewer',
        source: 'workspace',
        workspace_id: WORKSPACE_ID,
        source_file: REVIEWER_FILE,
        description: reviewerDescription,
        main: false,
        subagent_policy: 'strict',
        pinned_model_alias: ROLE_BINDING.reviewer.id,
        thinking_effort: ROLE_BINDING.reviewer.effort,
        routes: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// R04 — global task board (deferred until the board is localized)
// ---------------------------------------------------------------------------

function boardCard(locale, { id, title, priority, status, category, sessionIds = [], executionIds = [], minutesAgo, revision = 1, completed = false }) {
  const updatedAt = ts(minutesAgo);
  return {
    id,
    workspaceId: WORKSPACE_ID,
    storage: { root: SAMPLE_ROOT, storageId: 'board_sample_app', kind: 'workspace' },
    title: pick(locale, title.en, title.zh),
    priority,
    status,
    revision,
    createdAt: ts(minutesAgo + 240),
    updatedAt,
    completedAt: completed ? updatedAt : null,
    archived: false,
    category,
    sessionIds,
    executionIds,
  };
}

/**
 * A quiet, finished main-agent transcript for one session: no turns, but a
 * completed phase + todos so the session's agent panel and any todo checklist
 * read as real work, not as an "unknown" placeholder.
 */
function quietSession(agentId, todos) {
  return {
    messages: [],
    has_more: false,
    agent_transcripts: {
      main: {
        agent_id: 'main',
        has_more: false,
        items: [],
        todos: [{ todoId: `todo_mk_${agentId}`, items: todos, updatedAt: ts(20) }],
        meta: { activity: 'idle', agent: completedMeta({ turnId: 1 }) },
      },
    },
  };
}

export function buildR04(locale) {
  const cards = [
    boardCard(locale, { id: 'board_mk_release', title: { en: 'Prepare the sample-app 0.4 release', zh: '准备 sample-app 0.4 发布' }, priority: 'P1', status: 'active', category: 'release', minutesAgo: 4, sessionIds: [SESSION.release], revision: 3 }),
    boardCard(locale, { id: 'board_mk_a11y_list', title: { en: 'Consolidate the accessibility checklist', zh: '整理无障碍检查清单' }, priority: 'P2', status: 'active', category: 'quality', minutesAgo: 46, sessionIds: [SESSION.accessibility], revision: 2 }),
    boardCard(locale, { id: 'board_mk_changelog', title: { en: 'Draft the 0.4 changelog', zh: '起草 0.4 更新日志' }, priority: 'P1', status: 'in_progress', category: 'docs', minutesAgo: 6, sessionIds: [SESSION.release, SESSION.documentation], revision: 5 }),
    boardCard(locale, { id: 'board_mk_tests', title: { en: 'Run the sample-app test suite', zh: '运行 sample-app 测试套件' }, priority: 'P0', status: 'in_progress', category: 'quality', minutesAgo: 3, sessionIds: [SESSION.accessibility], revision: 4 }),
    boardCard(locale, { id: 'board_mk_upgrade_guide', title: { en: 'Rework the upgrade guide', zh: '升级指南改版' }, priority: 'P2', status: 'paused', category: 'docs', minutesAgo: 320, revision: 2 }),
    boardCard(locale, { id: 'board_mk_docs_build', title: { en: 'Fix the docs build warnings', zh: '修复文档构建告警' }, priority: 'P2', status: 'done', category: 'docs', minutesAgo: 180, sessionIds: [SESSION.documentation], revision: 6, completed: true }),
    boardCard(locale, { id: 'board_mk_a11y_scan', title: { en: 'Re-check the accessibility scan', zh: '无障碍扫描复核' }, priority: 'P3', status: 'done', category: 'quality', minutesAgo: 620, revision: 3, completed: true }),
  ];
  const sessions = base(locale, { busy: false }).sessions.map((session) => ({
    ...session,
    agent_config: { ...session.agent_config, profile: 'agent' },
  }));
  return {
    ...base(locale, { busy: false }),
    sessions,
    snapshots: {
      [SESSION.release]: quietSession('release', [
        { title: pick(locale, 'Docs build green', '文档构建通过'), status: 'done' },
        { title: pick(locale, 'Changelog drafted', '更新日志已起草'), status: 'in_progress' },
        { title: pick(locale, 'Tests approved', '测试已确认'), status: 'pending' },
      ]),
      [SESSION.accessibility]: quietSession('a11y', [
        { title: pick(locale, 'Checklist consolidated', '检查清单已整理'), status: 'done' },
        { title: pick(locale, 'Contrast fixes verified', '对比度修复已验证'), status: 'in_progress' },
      ]),
      [SESSION.documentation]: quietSession('docs', [
        { title: pick(locale, 'Upgrade guide drafted', '升级指南已起草'), status: 'pending' },
      ]),
    },
    taskBoard: {
      storage: { root: SAMPLE_ROOT, storageId: 'board_sample_app', kind: 'workspace' },
      cards,
      detail: {
        board_mk_changelog: {
          description: pick(locale, 'Fold the 0.3 → 0.4 changes into changelog entries and add an upgrade note.', '把 0.3 → 0.4 的变更整理成更新日志条目，并补充升级说明。'),
          prd: pick(locale, '## Goal\n\n- cover the new accessibility checks\n- call out breaking changes\n', '## 目标\n\n- 覆盖新增的无障碍检查\n- 标注破坏性变更\n'),
        },
      },
    },
  };
}

export { REVIEWER_FILE };
