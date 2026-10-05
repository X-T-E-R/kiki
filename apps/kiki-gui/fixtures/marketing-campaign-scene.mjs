/**
 * marketing-campaign-scene — the neutral world every public screenshot is shot
 * in, plus the per-surface builders the campaign runner drives.
 *
 * Why a separate module: the older marketing builders grew around one story
 * (the sample-app release). The Features series needed several more screens,
 * and the old `fixture` defaults — `C:/fixture`, `fixture/kiki-pro`, the
 * `Fixture: …` session titles — would be visible in a public frame. Every seed
 * below therefore names its own workspace, project, personas, and model
 * catalog, and nothing falls back to a server default that carries the word
 * "fixture" into the pixels.
 *
 * Locale discipline, same as marketing-scene.mjs: ids and structure are
 * identical between en and zh, only the visible copy is translated. A scenario
 * is chosen by `marketing-campaign-<id>-<locale>.scenario.mjs`, which calls
 * `build<Id>(locale)`.
 *
 * These are fixture-server wire shapes (see helpers.mjs and fixture-transcript.mjs).
 * No product code is involved.
 */

import { sessionRecord, ts } from './helpers.mjs';
import {
  ROLE_BINDING,
  SAMPLE_ROOT,
  SESSION,
  WORKSPACE_ID,
  runningMeta,
  sampleConfig,
  sampleModels,
  sampleProviders,
  sampleWorkspace,
  textFrame,
  toolFrame,
  turn,
} from './marketing-scene.mjs';
// The fictional project every frame shows. One name, one path shape, used by
// the workspace row, the board cards, the space entries and the agent files.
export const PROJECT_ROOT = SAMPLE_ROOT;
export const PROJECT = 'sample-app';

const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

// ---------------------------------------------------------------------------
// Shared roster
// ---------------------------------------------------------------------------

/** Three personas for the room frame and the sidebar group frame. */
function campaignPersonas(locale) {
  const LIN = {
    id: 'lin-lan',
    name: pick(locale, 'Lin Lan', '林岚'),
    title: pick(locale, 'Release coordinator', '发布协调'),
    job: pick(
      locale,
      'Runs the release rhythm: the checklist, the blockers, the release notes.',
      '负责每个版本的发布节奏：列清单、盯阻塞、写发布说明。',
    ),
    modelAlias: ROLE_BINDING.thinker.id,
    thinkingEffort: ROLE_BINDING.thinker.effort,
    delivery: 'message',
    greeting: pick(locale, "I'm here. Which release are we on?", '我在。这周要发哪个版本？'),
    description: pick(
      locale,
      [
        'You are Lin Lan, the release coordinator for sample-app.',
        '',
        '- Give the conclusion first, then the reasoning.',
        '- Never tag, push, or run a release action without the operator saying so.',
        '- When the operator says "ship", ship the changelog draft, not an announcement.',
      ].join('\n'),
      [
        '你是林岚，负责 sample-app 的发布协调。',
        '',
        '- 说话简短，先给结论。',
        '- 未经操作者批准，不推送、不打标、不执行发布动作。',
        '- 操作者说「发」时，只发 changelog 草稿，不发公告。',
      ].join('\n'),
    ),
  };
  const CHE = {
    id: 'a-che',
    name: pick(locale, 'A Che', '阿澈'),
    title: pick(locale, 'Writing partner', '写作搭子'),
    job: pick(locale, 'Drafts the changelog and the release notes.', '起草 changelog 与发布说明。'),
    modelAlias: ROLE_BINDING.builder.id,
    thinkingEffort: ROLE_BINDING.builder.effort,
    delivery: 'message',
    greeting: pick(locale, 'Send me the notes and I will draft it.', '把要点发我，我来起草。'),
    description: pick(
      locale,
      'You are A Che. Read what the notes actually say before writing, change one thing at a time, and say why each change was made.',
      '你是阿澈。先读清要点再动笔，一次只改一处，并说明为什么这样改。',
    ),
  };
  const LAN = {
    id: 'xiao-lan',
    name: pick(locale, 'Xiao Lan', '小蓝'),
    title: pick(locale, 'Researcher', '调研'),
    job: pick(locale, 'Looks things up and checks the facts.', '查资料、核对事实。'),
    modelAlias: ROLE_BINDING.explorer.id,
    thinkingEffort: ROLE_BINDING.explorer.effort,
    delivery: 'message',
    greeting: pick(locale, 'What should I look up?', '要我查什么？'),
    description: pick(
      locale,
      'You are Xiao Lan. Answer with the source, never a guess, and say plainly when something is unverified.',
      '你是小蓝。给出处，不猜；没有核实过的就说没核实。',
    ),
  };
  return [LIN, CHE, LAN];
}

// ---------------------------------------------------------------------------
// Base: config, catalog, workspace, sessions
// ---------------------------------------------------------------------------

const LOCALIZED_SESSIONS = {
  en: {
    release: 'Prepare the release',
    accessibility: 'Review accessibility',
    documentation: 'Update documentation',
    daily: 'Lin Lan · daily',
    design: 'Xiao Lan · research notes',
  },
  zh: {
    release: '准备 sample-app 发布',
    accessibility: '检查无障碍',
    documentation: '更新文档',
    daily: '林岚 · 日常',
    design: '小蓝 · 调研笔记',
  },
};

/** The sidebar sessions. `busy` only where a running turn is part of the frame. */
function campaignSessions(locale, { busy = false } = {}) {
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
    ...(row.busy ? { busy: true, main_turn_active: true, pending_interaction: 'none' } : {}),
    updated_at: ts(row.minutesAgo),
    created_at: ts(240),
  }));
}

/**
 * The persona-bound sessions: the daily entry each persona row points at, plus
 * the room-member sessions a room roster resolves against.
 */
function campaignPersonaSessions(locale) {
  const personas = campaignPersonas(locale);
  const byId = Object.fromEntries(personas.map((persona) => [persona.id, persona]));
  const daily = (persona) => sessionRecord(`session_campaign_daily_${persona.id}`, {
    title: `${persona.name} · ${pick(locale, 'daily', '日常')}`,
    workspace_id: WORKSPACE_ID,
    metadata: { cwd: PROJECT_ROOT, persona_id: persona.id },
    agent_config: { model: persona.modelAlias, persona: { id: persona.id, name: persona.name } },
    updated_at: ts(12),
    created_at: ts(2_000),
  });
  const room = (persona) => sessionRecord(`session_campaign_room_${persona.id}`, {
    title: `${persona.name}`,
    workspace_id: WORKSPACE_ID,
    delivery: 'message',
    metadata: { cwd: PROJECT_ROOT, room_member_of: ROOM_ID, room_persona_id: persona.id },
    agent_config: { model: persona.modelAlias, persona: { id: persona.id, name: persona.name } },
    updated_at: ts(9),
    created_at: ts(320),
  });
  return {
    personas,
    byId,
    sessions: [...personas.map(daily), ...personas.map(room)],
  };
}

export const ROOM_ID = 'release-031';

function base(locale, options = {}) {
  const personas = campaignPersonaSessions(locale);
  return {
    config: sampleConfig(),
    models: sampleModels(),
    providers: sampleProviders(),
    workspaces: [sampleWorkspace()],
    sessions: [...campaignSessions(locale, options), ...personas.sessions],
    agentPanel: campaignAgentPanel(locale),
    // The agent panel's "Injected rules" block reads this on every session.
    // One visible rule is better than an empty list here: the frame then shows
    // the feature doing what it says, and the row carries a real event and a
    // real cadence instead of standing in for nothing.
    agentHooks: {
      revision: 'hooks-campaign-1',
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
      ],
    },
  };
}

/**
 * The right rail reads its capability block from `agentPanelService.read`. When
 * a scenario seeds no panel, the fixture answers with `available: false` and a
 * hardcoded `fixture/kiki-pro` model — both of which land in a public frame as a
 * fixture artifact and an error state. Seeding it keeps the rail on the real
 * surface: working notes, the capability counts, and a session overview with
 * plausible numbers instead of a retry line.
 */
function campaignAgentPanel(locale, roles = ['explorer', 'builder', 'reviewer']) {
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
    explorer: { input: 42_100, output: 5_200, cacheRead: 31_000, contextTokens: 12_400, cost: 0.31 },
    builder: { input: 61_800, output: 9_400, cacheRead: 44_200, contextTokens: 18_900, cost: 0.58 },
    reviewer: { input: 33_500, output: 4_100, cacheRead: 22_800, contextTokens: 9_600, cost: 0.24 },
    thinker: { input: 54_200, output: 12_800, cacheRead: 38_000, contextTokens: 16_400, cost: 0.86 },
  };
  const rows = {
    main: metrics({ input: 128_400, output: 18_600, cacheRead: 96_400, contextTokens: 41_200, cost: 1.42, model: ROLE_BINDING.main.rail }),
  };
  for (const role of roles) {
    rows[role] = metrics({ ...perRole[role], model: ROLE_BINDING[role].rail });
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
    // The target shape is `agentCapabilityTargetSchema`
    // (packages/protocol/src/rest/agentProfile.ts:310). `dispatch_policy` is a
    // literal 'fixed' there, and the whole panel read is rejected when one
    // field fails — which is how the right rail came to render "Capabilities
    // can't be read right now" in a frame that has nothing wrong with it.
    targets: roles.map((role) => ({
      profile: role,
      route: role,
      description: pick(locale, `Dispatches the ${role} role.`, `派发 ${role} 角色。`),
      executor: 'native',
      model_alias: ROLE_BINDING[role].rail,
      model_source: 'profile',
      thinking_effort: ROLE_BINDING[role].effort,
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
    metrics: rows,
  };
}

// ---------------------------------------------------------------------------
// A19 — rooms: several personas, one topic
// ---------------------------------------------------------------------------

const msg = (id, minutesAgo, from, text, extra = {}) => ({
  id, at: ts(minutesAgo), kind: 'message', from, text, mentions: [], ...extra,
});
const sys = (id, minutesAgo, event, text, data) => ({
  id, at: ts(minutesAgo), kind: 'system', from: 'system', event, text, ...(data !== undefined ? { data } : {}),
});

/**
 * A three-member room mid-discussion: the operator asked a question, one member
 * answered and handed the next step to another, the third reported a checked
 * fact, and the host closed with a plan. The log is the shot's whole subject,
 * so it reads as a discussion rather than a system dump.
 */
function roomLog(locale) {
  return [
    msg('rc-1', 34, 'user', pick(
      locale,
      'Can we still ship 0.4 this week? @Lin Lan',
      '这周还能发 0.4 吗？@林岚',
    ), { mentions: ['lin-lan'] }),
    msg('rc-2', 33, 'lin-lan', pick(
      locale,
      'Yes, if two things land. @A Che — which changelog entries are still missing?\n@Xiao Lan — how long does the signing certificate renewal take?',
      '可以，差两件事。@阿澈 —— changelog 还缺哪几条？\n@小蓝 —— 签名证书续期要多久？',
    ), { mentions: ['a-che', 'xiao-lan'] }),
    msg('rc-3', 31, 'a-che', pick(
      locale,
      'Three: #812, #815, #820. I will draft them in CHANGELOG.md — give me ten minutes.',
      '三条：#812、#815、#820。我起草到 CHANGELOG.md 里，给我十分钟。',
    )),
    msg('rc-4', 27, 'xiao-lan', pick(
      locale,
      'The renewal takes one to two business days; the provider can accept the request this afternoon.',
      '续期要一到两个工作日；供应商今天下午能受理。',
    )),
    msg('rc-5', 25, 'a-che', pick(
      locale,
      'Draft is in. @Lin Lan it is yours to read before anything ships.',
      '草稿写好了。@林岚 你过一眼再发。',
    ), { mentions: ['lin-lan'] }),
    msg('rc-6', 22, 'lin-lan', pick(
      locale,
      'Then we ship Friday: certificate by Wednesday, freeze Thursday, tag Friday morning.',
      '那就按周五发来排：周三前续期，周四冻结，周五上午打 tag。',
    )),
    sys('rc-7', 20, 'member_joined', pick(
      locale,
      'A Che joined the room.',
      '阿澈加入了房间。',
    ), { memberId: 'a-che', kind: 'persona' }),
  ];
}

/**
 * A19. The persona roster, the room document with its three members, and the
 * room log. Persona members carry the discriminated `kind: 'persona'` shape,
 * which is what the room page resolves against.
 */
export function buildA19(locale) {
  const { personas, sessions } = campaignPersonaSessions(locale);
  const world = base(locale);
  const room = {
    version: 1,
    id: ROOM_ID,
    name: pick(locale, 'Release 0.4', '0.4 发布'),
    host: 'lin-lan',
    mode: 'mention',
    members: personas.map((persona) => ({
      kind: 'persona',
      personaId: persona.id,
      sessionId: `session_campaign_room_${persona.id}`,
      muted: false,
    })),
    budget: { botMessagesPerUserMessage: 12 },
    workspace: PROJECT_ROOT,
    createdAt: ts(320),
    generation: 0,
    paused: false,
    budgetUsed: 6,
    userMessageCount: 1,
    cursors: {},
  };
  return {
    ...world,
    personas: personas.map((definition) => ({ definition })),
    bots: personas.map((persona, index) => ({
      personaId: persona.id,
      homeSessionId: `session_campaign_daily_${persona.id}`,
      pinned: index === 0,
      hidden: false,
    })),
    sessions: world.sessions,
    rooms: [{ room, log: roomLog(locale), usage: { members: {} } }],
    roomRunning: { [ROOM_ID]: true },
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
    },
    personaSessions: sessions.map((session) => session.id),
  };
}

// ---------------------------------------------------------------------------
// A18 — a persona's fixed daily conversation
// ---------------------------------------------------------------------------

/** A18. The daily entry plus the persona's other conversations. */
export function buildA18(locale) {
  const { personas } = campaignPersonaSessions(locale);
  const world = base(locale);
  const extra = sessionRecord('session_campaign_daily_lin-lan_docs', {
    title: pick(locale, 'Lin Lan · 0.4 upgrade notes', '林岚 · 0.4 升级说明'),
    workspace_id: WORKSPACE_ID,
    metadata: { cwd: PROJECT_ROOT, persona_id: 'lin-lan' },
    agent_config: { model: ROLE_BINDING.thinker.id, persona: { id: 'lin-lan', name: personas[0].name } },
    updated_at: ts(180),
    created_at: ts(600),
  });
  const third = sessionRecord('session_campaign_daily_a-che', {
    title: pick(locale, 'A Che · changelog voice', '阿澈 · changelog 语气'),
    workspace_id: WORKSPACE_ID,
    metadata: { cwd: PROJECT_ROOT, persona_id: 'a-che' },
    agent_config: { model: ROLE_BINDING.builder.id, persona: { id: 'a-che', name: personas[1].name } },
    updated_at: ts(240),
    created_at: ts(700),
  });
  return {
    ...world,
    personas: personas.map((definition) => ({ definition })),
    bots: personas.map((persona) => ({
      personaId: persona.id,
      homeSessionId: `session_campaign_daily_${persona.id}`,
      pinned: false,
      hidden: false,
    })),
    sessions: [...world.sessions, extra, third],
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
      'session_campaign_daily_lin-lan': {
        messages: [
          { id: 'msg_campaign_daily_u1', session_id: 'session_campaign_daily_lin-lan', role: 'user', content: [{ type: 'text', text: pick(locale, 'Which blockers are left for 0.4?', '0.4 还剩哪些阻塞？') }], created_at: ts(20) },
          { id: 'msg_campaign_daily_a1', session_id: 'session_campaign_daily_lin-lan', role: 'assistant', content: [{ type: 'text', text: pick(locale, 'Two: the changelog entries A Che is drafting, and the signing certificate renewal.', '两件：阿澈在起草的 changelog 条目，和签名证书续期。') }], created_at: ts(19) },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A14 — the persona card
// ---------------------------------------------------------------------------

/** A14. The roster with the first card open in the editor. */
export function buildA14(locale) {
  return buildA18(locale);
}

// ---------------------------------------------------------------------------
// A16 — the context meter with Fresh selected
// ---------------------------------------------------------------------------

/**
 * A16. The session's own renewal strategy is `fresh`, so the detail card opens
 * with Fresh selected rather than the default. The context window track and the
 * cumulative block both render from the same session's usage.
 */
export function buildA16(locale) {
  const world = base(locale, { busy: true });
  const sid = SESSION.release;
  return {
    ...world,
    contextStrategy: {
      profiles: { agent: 'fresh' },
      overrides: { [sid]: 'fresh' },
    },
    snapshots: {
      [sid]: {
        messages: [],
        has_more: false,
        agent_transcripts: {
          main: {
            agent_id: 'main',
            has_more: false,
            items: [
              turn({
                turnId: 't1',
                ordinal: 1,
                prompt: pick(locale, 'Map the 0.4 upgrade path and keep the notes tidy.', '梳理 0.4 升级路径，并把笔记整理好。'),
                minutesAgo: 26,
                frames: [
                  toolFrame({ frameId: 'cp-read-upgrade', toolCallId: 'call_cp_upgrade', name: 'Read', input: { path: 'docs/upgrade-0.4.md' }, output: pick(locale, 'Upgrade guide, 118 lines.', '升级指南，118 行。') }),
                  toolFrame({ frameId: 'cp-grep-breaking', toolCallId: 'call_cp_breaking', name: 'Grep', input: { pattern: 'BREAKING' }, output: pick(locale, '2 breaking changes to flag.', '需标注 2 处破坏性变更。') }),
                  textFrame({ frameId: 'cp-note', text: pick(locale, 'The path is clear. When the history fills up, restart from these notes instead of summarizing them.', '路径已经清楚。上下文满了时，从这些笔记重启，而不是把它们压成摘要。') }),
                ],
              }),
              turn({
                turnId: 't2',
                ordinal: 2,
                prompt: pick(locale, 'Draft the upgrade note for the changelog.', '为更新日志起草升级说明。'),
                minutesAgo: 4,
                state: 'running',
                frames: [{ kind: 'thinking', frameId: 'cp-think', text: pick(locale, 'The upgrade note is being drafted.', '升级说明正在起草。') }],
              }),
            ],
            meta: { activity: 'turn', agent: runningMeta({ turnId: 2, role: 'main' }) },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A17 — memory: three scopes, and a change you can undo
// ---------------------------------------------------------------------------

function memoryEntry(fields) {
  return {
    status: 'active',
    pinned: false,
    created: ts(2_000),
    updated: ts(200),
    source: { writer: 'user' },
    reason: '',
    ...fields,
  };
}

/**
 * A17. Memory on, in the persona scope so the scope switcher shows which body
 * of memory is open, with a journal row that can still be undone. Entries are
 * neutral: no fixture wording, no machine paths.
 */
export function buildA17(locale) {
  const world = base(locale);
  const worldId = WORKSPACE_ID;
  // The persona scope does not resolve on its own: it waits for the persona's
  // bot home session and for that session's workspace to be in the directory
  // (useMemorySources). Without both, the persona scope opens to an empty list
  // and the frame would show a scope with nothing in it.
  const { personas } = campaignPersonaSessions(locale);
  return {
    ...world,
    personas: personas.map((definition) => ({ definition })),
    bots: personas.map((persona) => ({
      personaId: persona.id,
      homeSessionId: `session_campaign_daily_${persona.id}`,
      pinned: false,
      hidden: false,
    })),
    memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: { [worldId]: true } },
    memoryEntries: {
      global: [
        memoryEntry({
          id: 'mem_campaign_lang',
          type: 'user',
          title: pick(locale, 'Answer in Chinese, keep code comments in English', '回答用中文，代码注释保持英文'),
          body: pick(locale, 'Prose in Chinese; code, commit messages, and identifiers in English.', '正文用中文；代码、提交信息和标识符用英文。'),
          updated: ts(600),
        }),
        memoryEntry({
          id: 'mem_campaign_commits',
          type: 'feedback',
          title: pick(locale, 'Prefer reviewable commits over one large one', '提交拆小，不要合成一个大提交'),
          body: pick(locale, 'Split a landing into commits per coherent change.', '按一处连贯改动拆成一次提交。'),
          pinned: true,
          updated: ts(1_200),
        }),
      ],
      [`workspace:${worldId}`]: [
        memoryEntry({
          id: 'mem_campaign_ci',
          type: 'project',
          title: pick(locale, 'The workspace sync check runs in CI only', '工作区同步检查只在 CI 跑'),
          body: pick(locale, 'Keep the flake file in sync by hand in the same change.', '在同一次改动里手工保持 flake 文件同步。'),
          updated: ts(90),
        }),
      ],
      'persona:lin-lan': [
        memoryEntry({
          id: 'mem_campaign_list_first',
          type: 'feedback',
          title: pick(locale, 'Show the checklist before any release action', '发布动作前先给清单'),
          body: pick(locale, 'The operator wants the release checklist shown and confirmed before any release action runs.', '操作者希望在执行任何发布动作前先看到发布清单并确认。'),
          pinned: true,
          updated: ts(30),
        }),
        memoryEntry({
          id: 'mem_campaign_conclusion',
          type: 'user',
          title: pick(locale, 'Conclusion first, then the reasoning', '先给结论，再给理由'),
          body: pick(locale, 'Keep answers to five points or fewer.', '回答不超过五条。'),
          updated: ts(900),
        }),
      ],
    },
    memoryJournal: {
      // The journal is queried per entry id, so a record only shows in the
      // history of the entry it belongs to. The frame opens the pinned
      // persona entry, so the record is filed against that one.
      'persona:lin-lan': [
        {
          operationId: 'op_campaign_memory_1',
          action: 'update',
          id: 'mem_campaign_list_first',
          at: ts(30),
          writer: 'user',
          beforeRevision: 'rev_campaign_before',
          afterRevision: 'rev_campaign_after',
          before: [
            '---',
            JSON.stringify({ id: 'mem_campaign_list_first', type: 'feedback', title: 'Release actions', pinned: false }),
            '---',
            pick(locale, 'Show a checklist before a release.', '发布前给出清单。'),
            '',
          ].join('\n'),
        },
      ],
    },
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
    },
  };
}

// ---------------------------------------------------------------------------
// A20 — spaces: the main space and two spaces with different credentials
// ---------------------------------------------------------------------------

/** A20. Two spaces side by side, one sharing credentials and running. */
export function buildA20(locale) {
  const world = base(locale);
  return {
    ...world,
    config: {
      ...world.config,
      default_model: ROLE_BINDING.main.id,
      providers: {},
    },
    spaces: {
      mainPath: 'C:\\Users\\you\\.kiki',
      mainPrefs: { theme: 'light' },
      items: [
        {
          id: 'h-campaign000000001',
          name: pick(locale, 'sample-app', 'sample-app'),
          color: '#0f766e',
          path: PROJECT_ROOT,
          credentials: 'shared',
          live: true,
          overrides: {},
          prefs: { theme: 'light', defaultAppendTiming: 'subagents_done' },
          selections: { 'pref:theme': { mode: 'fixed', reason: 'edited' }, 'group:config': { mode: 'follow' } },
        },
        {
          id: 'h-campaign000000002',
          name: pick(locale, 'Docs site', '文档站'),
          color: '#7e22ce',
          path: 'C:\\Projects\\docs-site',
          credentials: 'isolated',
        },
      ],
      sshCandidates: [
        { hostId: 'build-box', name: pick(locale, 'Build box', '构建机'), credential_kinds: ['password'] },
        { hostId: 'docs-box', name: pick(locale, 'Docs box', '文档机'), credential_kinds: ['passphrase'] },
      ],
      active: 'main',
    },
    ssh: {
      hosts: [
        { id: 'build-box', name: pick(locale, 'Build box', '构建机'), hostname: 'build.example.com', user: 'deploy', agentAccess: 'offered' },
      ],
    },
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
    },
  };
}

// ---------------------------------------------------------------------------
// A09 — the web access card
// ---------------------------------------------------------------------------

/** A09 (web access): an always-on entry with two browsers already signed in. */
export function buildWebAccess(locale) {
  const world = buildA20(locale);
  return {
    ...world,
    webAccess: {
      enabled: true,
      mode: 'persistent',
      url: 'http://192.168.1.20:8614/',
      host: '192.168.1.20',
      port: 8614,
      insecure: false,
      sessions: [
        { id: '11111111-2222-4333-8444-555555555555', label: 'Pixel · Chrome', createdAgoMs: 7_200_000, lastUsedAgoMs: 45_000, expiresInMs: 30 * 86_400_000 },
        { id: '66666666-7777-4888-8999-aaaaaaaaaaaa', label: 'Office iPad · Safari', createdAgoMs: 172_800_000, lastUsedAgoMs: 5_400_000, expiresInMs: 28 * 86_400_000 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// A21 — remote connections
// ---------------------------------------------------------------------------

/**
 * A21 is intentionally not seeded here. `/api/remote-connections` has no
 * fixture-server route: the only proven source of rows is the browser-level
 * interception in scripts/visual-proof-remote-spaces.mjs, which is proof state
 * rather than a scenario key. The campaign runner drives that interception
 * itself for the two remote frames, so the row data lives with the runner.
 * A handoff line is written instead of a fake seed.
 */

// ---------------------------------------------------------------------------
// A10 — the usage page
// ---------------------------------------------------------------------------

const tok = (input_other, output, input_cache_read, input_cache_creation) => ({
  input_other, output, input_cache_read, input_cache_creation,
});
const sumOf = (...rows) => rows.reduce((total, row) => ({
  input_other: total.input_other + row.input_other,
  output: total.output + row.output,
  input_cache_read: total.input_cache_read + row.input_cache_read,
  input_cache_creation: total.input_cache_creation + row.input_cache_creation,
}), tok(0, 0, 0, 0));
/** One aggregate block over rows that each already carry a derived cost. */
const aggregate = (rows) => ({
  tokens: sumOf(...rows),
  cost_usd_estimated: Number(rows.reduce((n, row) => n + row.cost_usd_estimated, 0).toFixed(4)),
  cost_unknown: false,
});

/**
 * A day of work across three sessions and four models. The figures are
 * internally consistent on purpose: the summary is the sum of the buckets, the
 * buckets are the sum of the sessions, and today's slice is a subset of the
 * range — a reader who adds up the table lands on the number above it.
 *
 * This is EXAMPLE data. Nothing here bills a provider, and no request is made.
 */
const USAGE_MODELS = [
  { key: 'kimi-code/k3', provider: 'kimi-code', model_alias: 'Kimi K3', price: 0.0412 },
  { key: 'anthropic/claude-fable-5', provider: 'anthropic', model_alias: 'Claude Fable', price: 0.0874 },
  { key: 'deepseek/deepseek-v4-flash', provider: 'deepseek', model_alias: 'DeepSeek V4 Flash', price: 0.0193 },
  { key: 'zhipu/glm-5.3-flash', provider: 'zhipu', model_alias: 'GLM 5.3 Flash', price: 0.0126 },
];

/** Per-model per-day rows. `cost_usd_estimated` is derived, never hand-typed. */
const USAGE_DAILY = [
  // day offset 0 = today
  { day: 0, model: 0, input_other: 18_400, output: 6_920, input_cache_read: 61_300, input_cache_creation: 22_400, turns: 14, requests: 31 },
  { day: 0, model: 1, input_other: 7_250, output: 3_180, input_cache_read: 24_100, input_cache_creation: 0, turns: 6, requests: 12 },
  { day: 0, model: 2, input_other: 9_800, output: 4_420, input_cache_read: 0, input_cache_creation: 0, turns: 9, requests: 19 },
  { day: 0, model: 3, input_other: 4_100, output: 1_960, input_cache_read: 8_400, input_cache_creation: 0, turns: 5, requests: 8 },
  { day: 1, model: 0, input_other: 24_600, output: 9_120, input_cache_read: 88_900, input_cache_creation: 31_200, turns: 19, requests: 44 },
  { day: 1, model: 1, input_other: 11_300, output: 5_240, input_cache_read: 41_700, input_cache_creation: 0, turns: 9, requests: 17 },
  { day: 1, model: 2, input_other: 14_100, output: 6_050, input_cache_read: 12_800, input_cache_creation: 0, turns: 12, requests: 26 },
  { day: 2, model: 0, input_other: 21_900, output: 8_240, input_cache_read: 74_600, input_cache_creation: 26_800, turns: 17, requests: 38 },
  { day: 2, model: 2, input_other: 12_400, output: 5_310, input_cache_read: 0, input_cache_creation: 0, turns: 11, requests: 23 },
  { day: 2, model: 3, input_other: 6_700, output: 2_840, input_cache_read: 15_200, input_cache_creation: 0, turns: 7, requests: 14 },
  { day: 3, model: 0, input_other: 16_800, output: 6_400, input_cache_read: 52_100, input_cache_creation: 18_900, turns: 12, requests: 27 },
  { day: 3, model: 1, input_other: 8_900, output: 3_960, input_cache_read: 29_400, input_cache_creation: 0, turns: 7, requests: 15 },
  { day: 3, model: 3, input_other: 5_200, output: 2_100, input_cache_read: 11_300, input_cache_creation: 0, turns: 6, requests: 11 },
  { day: 4, model: 0, input_other: 28_300, output: 10_600, input_cache_read: 96_200, input_cache_creation: 34_500, turns: 21, requests: 49 },
  { day: 4, model: 2, input_other: 15_800, output: 6_940, input_cache_read: 0, input_cache_creation: 0, turns: 13, requests: 28 },
  { day: 5, model: 0, input_other: 19_700, output: 7_380, input_cache_read: 67_400, input_cache_creation: 21_600, turns: 15, requests: 34 },
  { day: 5, model: 1, input_other: 6_400, output: 2_720, input_cache_read: 19_800, input_cache_creation: 0, turns: 5, requests: 10 },
  { day: 6, model: 0, input_other: 14_200, output: 5_180, input_cache_read: 45_700, input_cache_creation: 16_300, turns: 11, requests: 24 },
  { day: 6, model: 2, input_other: 10_300, output: 4_120, input_cache_read: 8_900, input_cache_creation: 0, turns: 9, requests: 18 },
];

/** One hour in ms — the day buckets are pinned to the fixture clock's midnight. */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const dayStart = (daysAgo) => Math.floor(Date.parse(ts(0)) / DAY) * DAY - daysAgo * DAY;

const usageGroup = (model, row) => ({
  key: model.key,
  provider: model.provider,
  model_alias: model.model_alias,
  agent_id: null,
  parent_agent_id: null,
  profile_name: null,
  tokens: tok(row.input_other, row.output, row.input_cache_read, row.input_cache_creation),
  cost_usd_estimated: Number(((row.input_other * 3 + row.output * 12) * model.price / 1_000_000).toFixed(6)),
  cost_unknown: false,
});

/** A10. Seven days of a real-shaped working week, aggregated by model. */
export function buildA10(locale) {
  const world = base(locale);
  const sid = SESSION.release;
  const titles = LOCALIZED_SESSIONS[locale] ?? LOCALIZED_SESSIONS.en;

  const trend = { day: [], week: [] };
  for (let day = 0; day <= 6; day += 1) {
    const rows = USAGE_DAILY.filter((row) => row.day === day);
    const start = dayStart(day);
    const groups = rows.map((row) => usageGroup(USAGE_MODELS[row.model], row));
    trend.day.push({
      key: `d${day}`,
      start_at: start,
      end_at: start + DAY,
      turn_count: rows.reduce((n, row) => n + row.turns, 0),
      request_count: rows.reduce((n, row) => n + row.requests, 0),
      groups,
      drilldown: { sessions: [], sessions_truncated: false },
    });
  }
  for (let week = 0; week <= 1; week += 1) {
    const rows = USAGE_DAILY.filter((row) => row.day <= week * 7);
    const start = dayStart(week * 7);
    trend.week.push({
      key: `w${week}`,
      start_at: start,
      end_at: start + 7 * DAY,
      turn_count: rows.reduce((n, row) => n + row.turns, 0),
      request_count: rows.reduce((n, row) => n + row.requests, 0),
      groups: USAGE_MODELS
        .map((model) => ({ model, rows: rows.filter((row) => row.model === USAGE_MODELS.indexOf(model)) }))
        .filter((entry) => entry.rows.length > 0)
        .map((entry) => {
          const merged = entry.rows.reduce((acc, row) => ({
            input_other: acc.input_other + row.input_other,
            output: acc.output + row.output,
            input_cache_read: acc.input_cache_read + row.input_cache_read,
            input_cache_creation: acc.input_cache_creation + row.input_cache_creation,
            turns: acc.turns + row.turns,
            requests: acc.requests + row.requests,
          }), { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0, turns: 0, requests: 0 });
          return usageGroup(entry.model, merged);
        }),
      drilldown: { sessions: [], sessions_truncated: false },
    });
  }

  const allRows = USAGE_DAILY.map((row) => ({ row, model: USAGE_MODELS[row.model] }));
  const todayRows = allRows.filter((entry) => entry.row.day === 0);

  // A session's cost is its own weighted slice of today's rows, each priced at
  // that row's model. The weights form a matrix whose columns sum to 1, so the
  // three costs add up to the today total a reader sees in the header, and each
  // session gets a genuinely different leading model — which is the thing the
  // table is for.
  const sessionUsage = (id, title, minutesAgo, weights) => {
    const groups = todayRows.map((entry) => usageGroup(entry.model, entry.row));
    const tokens = tok(
      groups.reduce((n, g, i) => n + g.tokens.input_other * weights[i], 0),
      groups.reduce((n, g, i) => n + g.tokens.output * weights[i], 0),
      groups.reduce((n, g, i) => n + g.tokens.input_cache_read * weights[i], 0),
      groups.reduce((n, g, i) => n + g.tokens.input_cache_creation * weights[i], 0),
    );
    const cost = Number(groups
      .reduce((n, g, i) => n + g.cost_usd_estimated * weights[i], 0)
      .toFixed(8));
    const primary = groups
      .map((g, i) => ({ g, weighted: g.cost_usd_estimated * weights[i] }))
      .toSorted((a, b) => b.weighted - a.weighted)[0]?.g;
    return {
      id,
      workspace_id: WORKSPACE_ID,
      title,
      created_at: Date.parse(ts(minutesAgo + 240)),
      updated_at: Date.parse(ts(minutesAgo)),
      archived: false,
      deleted: false,
      usage: { tokens, cost_usd_estimated: cost, cost_unknown: false },
      primary_model: primary?.key ?? USAGE_MODELS[0].key,
      profile_names: ['agent'],
      unknown_price_models: [],
    };
  };

  // Weight per (session, model). Each column is normalised to 1, so the three
  // session costs sum to the same total as today's model rows — the identity a
  // reader checks first on a page about accounting. Each session leans on a
  // different model, which is what the table is actually for.
  // Weight per (session, model). Each COLUMN sums to 1, so summing the three
  // session costs reproduces the same total as today's model rows — the
  // identity a reader checks first on a page about accounting. Each row leans
  // on a different model, which is what the table is actually for.
  const weights = [
    [0.55, 0.20, 0.30, 0.25],
    [0.25, 0.15, 0.50, 0.35],
    [0.20, 0.65, 0.20, 0.40],
  ];
  const sessions = [
    sessionUsage(SESSION.release, titles.release, 1, weights[0]),
    sessionUsage(SESSION.accessibility, titles.accessibility, 95, weights[1]),
    sessionUsage(SESSION.documentation, titles.documentation, 150, weights[2]),
  ];

  // The range summary is the sum of the same rows the trend buckets were built
  // from, so a reader who adds the chart up lands on the number above it.
  const summaryOf = (entries) => aggregate(entries.map((entry) => {
    const { cost_usd_estimated } = usageGroup(entry.model, entry.row);
    return { ...entry.row, cost_usd_estimated };
  }));

  // TODAY's summary comes from the session table instead, so the three row
  // costs add up to the header's figure instead of differing from it in the
  // last decimal — the difference a reader spots first on a spending page.
  const todaySummary = {
    tokens: sumOf(...sessions.map((item) => item.usage.tokens)),
    cost_usd_estimated: Number(sessions
      .reduce((n, item) => n + item.usage.cost_usd_estimated, 0)
      .toFixed(6)),
    cost_unknown: false,
  };

  return {
    ...world,
    usageV2: {
      trend,
      summary: { ...summaryOf(allRows), session_count: sessions.length },
      summaryToday: { ...todaySummary, session_count: sessions.length },
      sessions,
      sessionsToday: sessions,
      reliability: {
        complete: true,
        usage_coverage: { known_records: 418, missing_records: 0, legacy_zero_records: 0 },
        coverage: { earliest_at: dayStart(6), latest_at: Date.parse(ts(1)) },
        scanned_sessions: 12,
        incomplete_sessions: 0,
        unknown_price_models: [],
        includes_deleted_sessions: false,
        incomplete_reason: null,
      },
    },
    snapshots: {
      [sid]: { messages: [], has_more: false },
    },
  };
}

// ---------------------------------------------------------------------------
// A12 — history import: six sources, and a preview that says what it keeps
// ---------------------------------------------------------------------------

const HISTORY_PLUGIN = 'kiki-history';
const CLAUDE_HOME = 'C:/Users/you/.claude';
const NATIVE_WORK_DIR = 'C:/Projects/sample-app';

const IMPORT_SOURCE = (id, label) => ({
  pluginId: HISTORY_PLUGIN, id, label, formatVersion: `${id}.history.v1`,
});

const importRecord = (id, part, role, text) => ({ id, part, role, text });

/** The loss shape is strict: `count` is required, not optional. */
const importLoss = (locale, code, detail) => ({ code, count: 1, detail });

/**
 * A12. The six sources the host ships with, one of them holding a readable
 * conversation. The preview's status is `partial` on purpose and carries a
 * loss list: a preview that reports "everything imported" is the claim a reader
 * would rightly distrust, and the plan asks this frame to show what is kept and
 * what is dropped.
 *
 * Every path here is a neutral placeholder. The shipped `plugin-import`
 * scenario carries `C:/Users/fixture/...` and a workspace literally named
 * `fixture`, which cannot appear in a public frame.
 */
export function buildA12(locale) {
  const world = base(locale);
  const conversationTitle = pick(locale, 'Migrate the search index to the new analyzer', '把搜索索引迁到新的分析器');
  const turnText = [
    pick(locale, 'The old analyzer splits on whitespace; the new one needs a custom tokenizer.', '旧分析器按空白切分，新分析器需要自定义分词器。'),
    pick(locale, 'I will add the tokenizer behind a flag so the old path still works.', '我会把新分词器放在开关后面，旧路径仍然可用。'),
    pick(locale, 'Benchmarked both on the sample corpus: the new path is about 30% faster.', '在样本集上对比过：新路径快约 30%。'),
  ];
  return {
    ...world,
    pluginImport: {
      hostShipped: { [HISTORY_PLUGIN]: true },
      sources: [
        IMPORT_SOURCE('claude-code', 'Claude Code'),
        IMPORT_SOURCE('codex', 'Codex'),
        IMPORT_SOURCE('pi', 'Pi'),
        IMPORT_SOURCE('grok', 'Grok'),
        IMPORT_SOURCE('opencode', 'OpenCode'),
        IMPORT_SOURCE('custom', pick(locale, 'Custom script', '自定义脚本')),
      ],
      homes: {
        [`${HISTORY_PLUGIN}:claude-code:${CLAUDE_HOME}`]: {
          probe: {
            revision: 'rev_import_1',
            title: conversationTitle,
            formatVersion: 'claude-code.history.v1',
            status: 'partial',
            losses: [importLoss(
              locale,
              'reasoning_omitted',
              pick(
                locale,
                'Reasoning steps are not carried over; the conclusion is.',
                '推理步骤不迁移，只保留结论。',
              ),
            )],
            totalBytes: 184_200,
            sourceHome: CLAUDE_HOME,
          },
          entries: [
            { externalId: 'conv_search_index', title: conversationTitle },
            { externalId: 'conv_docs', title: pick(locale, 'Rewrite the docs landing page', '重写文档首页') },
          ],
          pages: [
            {
              records: [
                importRecord('r1', 0, 'user', pick(locale, 'Can we migrate the search index to the new analyzer?', '能把搜索索引迁到新分析器吗？')),
                importRecord('r2', 1, 'assistant', turnText[0]),
                importRecord('r3', 2, 'user', pick(locale, 'Do it, but keep the old path working.', '做吧，但旧路径要保持可用。')),
                importRecord('r4', 3, 'assistant', turnText[1]),
                importRecord('r5', 4, 'tool_call', pick(locale, 'Bash: pnpm bench --filter search', 'Bash: pnpm bench --filter search')),
                importRecord('r6', 5, 'assistant', turnText[2]),
              ],
              cursor: null,
              losses: [importLoss(
                locale,
                'reasoning_omitted',
                pick(locale, 'Reasoning steps are not carried over; the conclusion is.', '推理步骤不迁移，只保留结论。'),
              )],
              bytesRead: 12_400,
            },
          ],
        },
      },
      destination: { kind: 'native-session', workDir: NATIVE_WORK_DIR },
    },
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
    },
  };
}

// ---------------------------------------------------------------------------
// A05 — connections: one list, one row each
// ---------------------------------------------------------------------------

const CONNECTION_MODELS = {
  kimi: [
    { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2', display_name: 'Kimi K2', max_context_size: 262_144, capabilities: ['chat', 'reasoning'] },
  ],
  grok: [
    { provider: 'managed:grok-build', model: 'grok-build/grok-code', display_name: 'Grok Code', max_context_size: 256_000, capabilities: ['chat', 'reasoning'] },
  ],
};

/**
 * A05. The connections list is the subject: one row per connection, and
 * authentication is a property of the row rather than a separate table. Three
 * states sit together so the reader sees them as states of one list — a
 * working account, one whose credential the provider will no longer accept,
 * and one not signed in — beside a key-based connection so the two kinds stay
 * distinguishable.
 *
 * The shipped `oauth-connections` seed inherits provider rows literally named
 * `fixture` and `alt`, which cannot ship. These are neutral names with
 * example.com endpoints and no credential anywhere.
 */
export function buildA05(locale) {
  const world = base(locale);
  return {
    ...world,
    models: [...world.models, ...CONNECTION_MODELS.kimi, ...CONNECTION_MODELS.grok],
    providers: [
      {
        id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1',
        has_api_key: false, status: 'connected', default_model: 'kimi-code/kimi-k2',
        models: ['kimi-code/kimi-k2'],
      },
      {
        // Signed in once; the provider will not accept this credential again.
        // Recovered in place rather than added as a new row.
        id: 'managed:grok-build', type: 'openai', base_url: 'https://api.grok.example.test/v1',
        has_api_key: false, status: 'unconfigured', models: [],
      },
      {
        id: 'byo-endpoint', type: 'openai', base_url: 'https://api.example.test/v1',
        has_api_key: true, status: 'connected', default_model: ROLE_BINDING.explorer.id,
        models: [ROLE_BINDING.explorer.id],
      },
    ],
    oauthMethods: [
      { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'you@example.test' } },
      { id: 'grok-build', label: 'Grok Build', provider: 'managed:grok-build', protocol: 'openai', signed_in: true, connection_state: 'reconnect_required', account: { state: 'known', id: 'team@example.test' } },
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' } },
    ],
    config: {
      ...world.config,
      providers: {
        'managed:kimi-code': { type: 'kimi', has_api_key: false },
        'managed:grok-build': { type: 'openai', has_api_key: false },
      },
    },
    oauthStart: {
      flow_id: 'oauth_campaign_codex',
      provider: 'managed:openai-codex',
      status: 'pending',
      verification_uri: 'https://auth.example.test/device',
      verification_uri_complete: 'https://auth.example.test/device?user_code=WXYZ-1234',
      user_code: 'WXYZ-1234',
      expires_in: 900,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      interval: 5,
    },
    auth: { ready: true, providers_count: 3, default_model: 'kimi-code/kimi-k2', managed_provider: null },
  };
}

// ---------------------------------------------------------------------------
// A22 — the relationship diagram, not a UI frame
// ---------------------------------------------------------------------------

/**
 * A22 is the one non-screenshot in the campaign. It is a labelled relationship
 * diagram (external harness → Kiki / editor drives Kiki / Kiki provides tools
 * to an external harness), drawn from the same ink-and-paper palette as the
 * app. It must always carry the "relationship diagram, not a UI screenshot"
 * note, and must never be presented as a frame of the product.
 */
export const A22_DIAGRAM_ONLY = true;

// ---------------------------------------------------------------------------
// A02 — prompt field overrides
// ---------------------------------------------------------------------------

/**
 * A02. The prompt config is read from `config.prompt`: named variables plus
 * `overrides.fields`, whose keys are dot-separated lowercase field ids — the
 * editor validates them against /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/, so a
 * camelCase id renders as a red validation error and the preview stays closed.
 * A tool-description override is the deepest level the prompt can be edited
 * at, so the seed carries one beside the agent identity.
 */
export function buildA02(locale) {
  const world = base(locale);
  return {
    ...world,
    config: {
      ...world.config,
      prompt: {
        variables: {
          product: pick(locale, 'sample-app', 'sample-app'),
          audience: pick(locale, 'the release team', '发布团队'),
        },
        overrides: {
          files: ['prompts/release-checklist.md'],
          fields: {
            'tool.grep.description': pick(
              locale,
              'Search the sample-app workspace for text. Pass a path to narrow it.',
              '在 sample-app 工作区里搜索文本；传入 path 可以缩小范围。',
            ),
            'agent.identity': pick(
              locale,
              'You are working on ${product} with ${audience}.',
              '你正在与 ${audience} 一起做 ${product}。',
            ),
          },
        },
      },
    },
    snapshots: {
      [SESSION.release]: { messages: [], has_more: false },
    },
  };
}

// ---------------------------------------------------------------------------
// A08 — appearance: the skins a user can actually pick
// ---------------------------------------------------------------------------

/**
 * The appearance page. It previously reused the `skins` proof scenario, which
 * put three things a reader can see into a public frame: a sidebar workspace
 * named `fixture`, two user skins described as "Fixture skin: …", and a themes
 * directory printed as a `/home/fixture/...` path.
 *
 * The built-in skins are already real product data (`src/lib/skins/builtin.ts`),
 * so the honest move is to show those and seed only what a user's OWN themes
 * directory would add: nothing. A user who has installed nothing sees exactly
 * this list, which is the state the page is meant to be read in.
 */
export function buildA08(locale) {
  const world = base(locale);
  return {
    ...world,
    // No `skinFiles` and no `skinsDirectory`: the directory string is printed
    // on the page, so a fixture path there is a visible artifact. The route
    // answers an empty list, and the picker falls back to the built-ins.
    skinsDirectory: 'C:/Users/you/.kiki/themes',
  };
}

// ---------------------------------------------------------------------------
// A04 — agent profiles: the settings page and the new-session picker
// ---------------------------------------------------------------------------

const PROFILE_HOME = 'C:/Users/you/.kiki/agents';

/**
 * A04. Three named roles over the same neutral world the rest of the frames
 * use, so the profiles page reads as the same install as the workbench.
 *
 * The shape is the one `fixtures/profile-editor.scenario.mjs` uses — the
 * seeded rows are the real `/agents` contract, not a lookalike — but the
 * provider ids are the campaign's, so no `fixture/` string reaches a frame.
 */
export function buildA04(locale) {
  const world = base(locale);
  const profile = (name, fields) => ({
    name,
    source: 'user',
    workspace_id: WORKSPACE_ID,
    source_file: `${PROFILE_HOME}/${name}.md`,
    main: false,
    disabled: false,
    routes: [],
    ...fields,
  });

  return {
    ...world,
    agentProfiles: [
      {
        name: 'agent',
        source: 'builtin',
        description: pick(locale, 'Drives a session end to end.', '端到端推进一个会话。'),
        main: true,
        disabled: false,
        routes: [],
        allowed_subagents: ['explore', 'general'],
        preferred_subagents: ['explore'],
      },
      {
        name: 'explore',
        source: 'builtin',
        description: pick(locale, 'Read-only explorer for unfamiliar code.', '只读探索陌生代码。'),
        main: false,
        disabled: false,
        routes: [],
        prompt: pick(locale, 'Find the facts the caller asked for and cite where they are.', '找出调用方要的事实，并指出出处。'),
      },
      {
        // `agent` dispatches `general` by default, so that row is a real
        // profile in the catalog: a dispatch naming a profile that does not
        // exist raises a warning on the page, and a public frame shows none.
        name: 'general',
        source: 'builtin',
        description: pick(locale, 'General-purpose subagent for a scoped task.', '处理明确任务的通用子智能体。'),
        main: false,
        disabled: false,
        routes: [],
        prompt: pick(
          locale,
          'Do the task you were given and report what you did, what you found, and what you could not verify.',
          '把交给你的活做完，并报告你做了什么、发现了什么、哪些没能验证。',
        ),
      },
      profile('release-lead', {
        main: true,
        description: pick(
          locale,
          'Frames a release, delegates the work, and accepts the result.',
          '拆解一次发布、把活派出去、并验收结果。',
        ),
        when_to_use: pick(
          locale,
          'Open a session for multi-step work that has to ship.',
          '为要交付的多步工作开一个会话。',
        ),
        prompt: pick(
          locale,
          'State the goal in one line, then decide what to delegate. Accept a result only against its stated acceptance.',
          '先用一句话说清目标，再决定派什么。只有对着验收标准才接受结果。',
        ),
        pinned_model_alias: 'Kimi K3',
        thinking_effort: 'max',
        can_spawn_subagents: true,
        allowed_subagents: [
          'explore',
          { name: 'implementer', model_alias: 'deepseek-v4-flash', thinking_effort: 'max' },
          { name: 'reviewer', thinking_effort: 'high' },
        ],
        preferred_subagents: ['implementer', 'explore'],
      }),
      profile('implementer', {
        description: pick(
          locale,
          'Owns one engineering objective from reading to verification.',
          '独立负责一个工程目标，从读到验。',
        ),
        when_to_use: pick(
          locale,
          'A scoped change that needs editing and checking.',
          '需要动手改并自查的一处明确改动。',
        ),
        prompt: pick(
          locale,
          'Do the whole objective, then show the check that proves it. Report what you could not verify.',
          '把目标做完，并给出证明它做完了的自查。说明哪些没能验证。',
        ),
        pinned_model_alias: 'deepseek-v4-flash',
        thinking_effort: 'max',
        allowed_subagents: ['explore'],
        model_profiles: [
          {
            alias: 'Kimi K3',
            when: pick(locale, 'The change is small and fits the context.', '改动很小、放得进上下文时。'),
            thinking_effort: 'max',
          },
          {
            alias: 'glm-5.3-flash',
            when: pick(locale, 'Many mechanical edits across files.', '跨文件的机械性改动很多时。'),
            thinking_effort: 'high',
          },
        ],
      }),
      profile('reviewer', {
        description: pick(
          locale,
          'Independent review at a candidate boundary.',
          '在候选边界上做独立审查。',
        ),
        when_to_use: pick(
          locale,
          'A wrong call here is expensive.',
          '这一步判断错了代价很大时。',
        ),
        prompt: pick(
          locale,
          'Review the candidate against the stated acceptance and report findings with evidence.',
          '对着验收标准审候选，带证据报发现。',
        ),
        pinned_model_alias: 'claude-fable-5',
        thinking_effort: 'high',
        allowed_subagents: ['explore'],
      }),
    ],
  };
}
