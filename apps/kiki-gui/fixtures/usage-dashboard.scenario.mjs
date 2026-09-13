/**
 * usage-dashboard — a multi-session fleet for the /usage dashboard and the
 * sidebar activity panel:
 *
 *   - three busy sessions: zeta (running turn + queued prompts + a running
 *     background task), eta (running turn blocked on an approval), theta
 *     (background lease only — no main turn);
 *   - six idle sessions across two models and the server default, with
 *     lifetime usage spread across today / yesterday / 5d / 9d (archived) /
 *     24d so every range toggle and day bucket has something to show.
 *
 * No prompt script: the point is the aggregate views, not a turn.
 */

import { fid, sessionRecord, ts, userMsg, assistantMsg } from './helpers.mjs';

const DAY_MIN = 24 * 60;

function usage(input, output, cacheRead, cacheWrite, cost, turns) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
    total_cost_usd: cost,
    context_tokens: Math.round(input * 0.4),
    context_limit: 262_144,
    turn_count: turns,
  };
}

function prompt(id, text, minutesAgo, status) {
  return {
    prompt_id: id,
    user_message_id: `msg_${id}`,
    status,
    content: [{ type: 'text', text }],
    created_at: ts(minutesAgo),
    text,
  };
}

const ZETA = 'session_fixture_usage_zeta';
const ETA = 'session_fixture_usage_eta';
const THETA = 'session_fixture_usage_theta';

// ---------------------------------------------------------------------------
// /api/usage seed (consumed by the unified advanced route in fixture-server.mjs). Times are
// epoch ms computed at load so screenshots always look fresh. The day trend
// spreads three model groups across two weeks; the five_hour trend covers
// today with drilldown into the busy sessions; the agent-dimension day trend
// demonstrates the parent/child tree (main + researcher subagent).
// ---------------------------------------------------------------------------

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function msAgo(minutes) {
  return Date.now() - minutes * 60_000;
}

function tok(inputOther, output, cacheRead, cacheWrite) {
  return {
    input_other: inputOther,
    output,
    input_cache_read: cacheRead,
    input_cache_creation: cacheWrite,
  };
}

function group(key, tokens, cost, fields = {}) {
  return {
    key,
    tokens,
    cost_usd_estimated: cost,
    cost_unknown: fields.cost_unknown ?? false,
    provider: fields.provider ?? null,
    model_alias: fields.model_alias ?? null,
    agent_id: fields.agent_id ?? null,
    parent_agent_id: fields.parent_agent_id ?? null,
    profile_name: fields.profile_name ?? null,
  };
}

function drilldown(entries, truncated = false) {
  return {
    sessions: entries.map(([sessionId, turnIds, unknown = 0]) => ({
      session_id: sessionId,
      turn_ids: turnIds,
      turn_count: turnIds.length,
      unknown_turn_records: unknown,
      turn_ids_truncated: false,
    })),
    sessions_truncated: truncated,
  };
}

function dayStart(daysBack) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime() - daysBack * DAY_MS;
}

function dayBucket(daysBack, groups, drill) {
  const start = dayStart(daysBack);
  return { key: String(start), start_at: start, end_at: start + DAY_MS, groups, drilldown: drill };
}

const K2 = 'k2-thinking';
const SONNET = 'claude-sonnet-4.5';

const dayTrend = [
  dayBucket(13, [group(K2, tok(96_000, 7_100, 210_000, 14_000), 0.42, { provider: 'kimi', model_alias: K2 })], drilldown([['session_fixture_usage_iota', [1, 2]]])),
  dayBucket(11, [group(K2, tok(140_000, 9_800, 305_000, 19_000), 0.61, { provider: 'kimi', model_alias: K2 })], drilldown([['session_fixture_usage_iota', [3]]])),
  dayBucket(9, [
    group(SONNET, tok(310_000, 21_400, 640_000, 41_000), 1.48, { provider: 'anthropic', model_alias: SONNET }),
  ], drilldown([['session_fixture_usage_epsilon', [1, 2, 3]]])),
  dayBucket(6, [
    group(SONNET, tok(904_000, 61_200, 1_690_000, 158_000), 3.11, { provider: 'anthropic', model_alias: SONNET }),
    group(K2, tok(120_000, 8_400, 250_000, 9_000), 0.52, { provider: 'kimi', model_alias: K2 }),
  ], drilldown([['session_fixture_usage_gamma', [1, 2, 3, 4, 5]], ['session_fixture_usage_beta', [1]]])),
  dayBucket(5, [
    group(K2, tok(202_000, 14_900, 430_000, 22_000), 0.88, { provider: 'kimi', model_alias: K2 }),
    group('unknown', tok(31_000, 2_400, 0, 1_800), 0.07, { cost_unknown: true }),
  ], drilldown([['session_fixture_usage_beta', [2, 3]], ['session_fixture_usage_delta', [1], 1]])),
  dayBucket(2, [
    group(K2, tok(640_000, 44_100, 1_520_000, 96_000), 2.74, { provider: 'kimi', model_alias: K2 }),
    group(SONNET, tok(188_000, 13_300, 402_000, 26_000), 0.91, { provider: 'anthropic', model_alias: SONNET }),
  ], drilldown([['session_fixture_usage_alpha', [1, 2, 3]], [ETA, [1]]])),
  dayBucket(0, [
    group(K2, tok(58_200, 4_300, 138_000, 9_600), 0.27, { provider: 'kimi', model_alias: K2 }),
    group(SONNET, tok(96_400, 6_900, 224_000, 15_200), 0.46, { provider: 'anthropic', model_alias: SONNET }),
    group('mystery-9', tok(8_100, 640, 0, 0), 0, { cost_unknown: true, provider: 'local', model_alias: 'mystery-9' }),
  ], drilldown([[ZETA, [1, 2, 3, 4]], [ETA, [2, 3]], [THETA, [1]]])),
];

function fiveHourStart(windowsBack) {
  const now = Date.now();
  return Math.floor(now / (5 * HOUR_MS)) * 5 * HOUR_MS - windowsBack * 5 * HOUR_MS;
}

function fiveHourBucket(windowsBack, groups, drill) {
  const start = fiveHourStart(windowsBack);
  return { key: String(start), start_at: start, end_at: start + 5 * HOUR_MS, groups, drilldown: drill };
}

const fiveHourTrend = [
  fiveHourBucket(2, [
    group(SONNET, tok(41_000, 2_900, 96_000, 6_400), 0.19, { provider: 'anthropic', model_alias: SONNET }),
  ], drilldown([[ETA, [2]]])),
  fiveHourBucket(1, [
    group(K2, tok(22_800, 1_700, 54_000, 3_800), 0.11, { provider: 'kimi', model_alias: K2 }),
    group(SONNET, tok(18_200, 1_300, 41_000, 2_700), 0.09, { provider: 'anthropic', model_alias: SONNET }),
  ], drilldown([[ZETA, [1, 2]], [ETA, [3]], [THETA, [1]]])),
  fiveHourBucket(0, [
    group(K2, tok(35_400, 2_600, 84_000, 5_800), 0.16, { provider: 'kimi', model_alias: K2 }),
    group('mystery-9', tok(8_100, 640, 0, 0), 0, { cost_unknown: true, provider: 'local', model_alias: 'mystery-9' }),
  ], drilldown([[ZETA, [3, 4]]])),
];

const agentDayTrend = dayTrend.map((bucket) => ({
  ...bucket,
  groups: bucket.groups.flatMap((entry) => {
    const mainShare = Math.round(entry.cost_usd_estimated * 0.7 * 100) / 100;
    const subShare = Math.round((entry.cost_usd_estimated - mainShare) * 100) / 100;
    const mainTokens = tok(
      Math.round(entry.tokens.input_other * 0.7),
      Math.round(entry.tokens.output * 0.7),
      Math.round(entry.tokens.input_cache_read * 0.7),
      Math.round(entry.tokens.input_cache_creation * 0.7),
    );
    const subTokens = tok(
      entry.tokens.input_other - mainTokens.input_other,
      entry.tokens.output - mainTokens.output,
      entry.tokens.input_cache_read - mainTokens.input_cache_read,
      entry.tokens.input_cache_creation - mainTokens.input_cache_creation,
    );
    const main = group(`agent-main-${entry.key}`, mainTokens, mainShare, {
      provider: entry.provider,
      model_alias: entry.model_alias,
      agent_id: 'agent_main',
      profile_name: 'default',
      cost_unknown: entry.cost_unknown,
    });
    if (subShare <= 0 && entry.cost_unknown !== true) return [main];
    return [
      main,
      group(`agent-sub-${entry.key}`, subTokens, subShare, {
        provider: entry.provider,
        model_alias: entry.model_alias,
        agent_id: 'agent_researcher',
        parent_agent_id: 'agent_main',
        profile_name: 'researcher',
        cost_unknown: entry.cost_unknown,
      }),
    ];
  }),
}));

function sessionItem(id, title, minutesUpdated, usageEntry, fields = {}) {
  return {
    id,
    workspace_id: 'wd_fixture_000000000000',
    title,
    created_at: msAgo(minutesUpdated + 60 * 24),
    updated_at: msAgo(minutesUpdated),
    archived: fields.archived ?? false,
    deleted: false,
    usage: {
      tokens: tok(usageEntry[0], usageEntry[1], usageEntry[2], usageEntry[3]),
      cost_usd_estimated: usageEntry[4],
      cost_unknown: fields.cost_unknown ?? false,
    },
    unknown_price_models: fields.unknown_price_models ?? [],
  };
}

const sessionItems = [
  sessionItem('session_fixture_usage_gamma', 'Fixture: protocol audit', 26 * 60, [2_844_000, 190_300, 5_120_000, 488_000, 8.977]),
  sessionItem('session_fixture_usage_alpha', 'Fixture: bench harness', 45, [1_204_000, 88_100, 3_410_000, 240_000, 4.8213]),
  sessionItem('session_fixture_usage_epsilon', 'Fixture: archived spike', 9 * 24 * 60, [701_000, 44_800, 1_204_000, 96_000, 2.662], { archived: true }),
  sessionItem(ETA, 'Fixture: production migration', 8, [412_800, 31_500, 980_000, 77_400, 2.1044]),
  sessionItem('session_fixture_usage_beta', 'Fixture: stylesheet polish', 300, [320_400, 21_700, 910_000, 61_000, 1.2044]),
  sessionItem('session_fixture_usage_iota', 'Fixture: month-old draft', 24 * 24 * 60, [210_500, 12_300, 402_000, 31_000, 0.9421]),
  sessionItem(ZETA, 'Fixture: usage aggregation rework', 3, [84_300, 9_400, 210_000, 18_200, 0.5312]),
  sessionItem('session_fixture_usage_delta', 'Fixture: notes cleanup', 5 * 24 * 60, [61_200, 8_900, 0, 0, 0.1871], { cost_unknown: true, unknown_price_models: ['mystery-9'] }),
  sessionItem(THETA, 'Fixture: reference corpus index', 16, [12_900, 1_800, 0, 4_100, 0.0871]),
];

function sumTokens(items) {
  return items.reduce(
    (acc, item) => ({
      input_other: acc.input_other + item.usage.tokens.input_other,
      output: acc.output + item.usage.tokens.output,
      input_cache_read: acc.input_cache_read + item.usage.tokens.input_cache_read,
      input_cache_creation: acc.input_cache_creation + item.usage.tokens.input_cache_creation,
    }),
    { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
  );
}

const usageV2 = {
  trend: { day: dayTrend, five_hour: fiveHourTrend },
  trendByDimension: { agent: { day: agentDayTrend } },
  summary: {
    tokens: sumTokens(sessionItems),
    cost_usd_estimated: Math.round(sessionItems.reduce((sum, item) => sum + item.usage.cost_usd_estimated, 0) * 10000) / 10000,
    cost_unknown: true,
    session_count: sessionItems.length,
  },
  summaryToday: {
    tokens: tok(162_700, 11_840, 362_000, 24_800),
    cost_usd_estimated: 0.73,
    cost_unknown: true,
    session_count: 3,
  },
  sessions: sessionItems,
  sessionsToday: [
    sessionItem(ETA, 'Fixture: production migration', 8, [96_400, 6_900, 224_000, 15_200, 0.46]),
    sessionItem(ZETA, 'Fixture: usage aggregation rework', 3, [58_200, 4_300, 138_000, 9_600, 0.27]),
    sessionItem(THETA, 'Fixture: reference corpus index', 16, [8_100, 640, 0, 0, 0], {
      cost_unknown: true,
      unknown_price_models: ['mystery-9'],
    }),
  ],
  reliability: {
    coverage: { earliest_at: dayStart(31), latest_at: msAgo(2) },
    scanned_sessions: sessionItems.length,
    incomplete_sessions: 0,
    unknown_price_models: ['mystery-9'],
    includes_deleted_sessions: false,
    incomplete_reason: null,
  },
};

export default {
  sessions: [
    sessionRecord(ZETA, {
      title: 'Fixture: usage aggregation rework',
      busy: true,
      main_turn_active: true,
      current_prompt_id: 'prompt_fx_zeta_active',
      last_prompt: 'Refactor the usage aggregation into pure functions',
      agent_config: { model: 'kimi/k2-thinking' },
      usage: usage(84_300, 9_400, 210_000, 18_200, 0.5312, 6),
      message_count: 2,
      created_at: ts(300),
      updated_at: ts(3),
    }),
    sessionRecord(ETA, {
      title: 'Fixture: production migration',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'approval',
      current_prompt_id: 'prompt_fx_eta_active',
      last_prompt: 'Apply the migration to the production database',
      agent_config: { model: 'anthropic/claude-sonnet-4.5' },
      usage: usage(412_800, 31_500, 980_000, 77_400, 2.1044, 14),
      created_at: ts(2 * DAY_MIN),
      updated_at: ts(8),
    }),
    sessionRecord(THETA, {
      title: 'Fixture: reference corpus index',
      busy: true,
      main_turn_active: false,
      last_prompt: 'Index the reference corpus in the background',
      agent_config: { model: 'kimi/k2-thinking' },
      usage: usage(12_900, 1_800, 0, 4_100, 0.0871, 2),
      created_at: ts(DAY_MIN),
      updated_at: ts(16),
    }),
    sessionRecord('session_fixture_usage_alpha', {
      title: 'Fixture: bench harness',
      agent_config: { model: 'kimi/k2-thinking' },
      usage: usage(1_204_000, 88_100, 3_410_000, 240_000, 4.8213, 42),
      created_at: ts(2 * DAY_MIN + 100),
      updated_at: ts(45),
    }),
    sessionRecord('session_fixture_usage_beta', {
      title: 'Fixture: stylesheet polish',
      agent_config: { model: 'kimi/k2-thinking' },
      usage: usage(320_400, 21_700, 910_000, 61_000, 1.2044, 11),
      created_at: ts(3 * DAY_MIN),
      updated_at: ts(300),
    }),
    sessionRecord('session_fixture_usage_gamma', {
      title: 'Fixture: protocol audit',
      agent_config: { model: 'anthropic/claude-sonnet-4.5' },
      usage: usage(2_844_000, 190_300, 5_120_000, 488_000, 8.977, 63),
      created_at: ts(6 * DAY_MIN),
      updated_at: ts(26 * 60),
    }),
    sessionRecord('session_fixture_usage_delta', {
      title: 'Fixture: notes cleanup',
      agent_config: { model: '' },
      usage: usage(61_200, 8_900, 0, 0, 0.1871, 5),
      created_at: ts(12 * DAY_MIN),
      updated_at: ts(5 * DAY_MIN),
    }),
    sessionRecord('session_fixture_usage_epsilon', {
      title: 'Fixture: archived spike',
      archived: true,
      agent_config: { model: 'anthropic/claude-sonnet-4.5' },
      usage: usage(701_000, 44_800, 1_204_000, 96_000, 2.662, 18),
      created_at: ts(15 * DAY_MIN),
      updated_at: ts(9 * DAY_MIN),
    }),
    sessionRecord('session_fixture_usage_iota', {
      title: 'Fixture: month-old draft',
      agent_config: { model: 'kimi/k2-thinking' },
      usage: usage(210_500, 12_300, 402_000, 31_000, 0.9421, 7),
      created_at: ts(31 * DAY_MIN),
      updated_at: ts(24 * DAY_MIN),
    }),
  ],
  snapshots: {
    [ZETA]: {
      messages: [
        { ...userMsg(ZETA, 'Refactor the usage aggregation into pure functions', 4), prompt_id: 'prompt_fx_zeta_active' },
        assistantMsg(ZETA, ['Splitting the rollup math out of the page component now.'], 3),
      ],
      active_prompt: prompt(
        'prompt_fx_zeta_active',
        'Refactor the usage aggregation into pure functions',
        4,
        'running',
      ),
      queued_prompts: [
        prompt(fid('prompt'), 'Add unit tests for the cache hit rate', 2, 'queued'),
        prompt(fid('prompt'), 'Run the full lint gate afterwards', 1, 'queued'),
      ],
      tasks: [
        {
          id: fid('task'),
          session_id: ZETA,
          kind: 'bash',
          description: 'fixture build (vite)',
          status: 'running',
          command: 'pnpm build --watch',
          created_at: ts(9),
          started_at: ts(9),
          output_preview: 'vite v6.4.2 building for production…\ntransforming…',
          output_bytes: 2048,
        },
        {
          id: fid('task'),
          session_id: ZETA,
          kind: 'bash',
          description: 'seed dry-run',
          status: 'completed',
          command: 'node scripts/seed.mjs --dry-run',
          created_at: ts(40),
          started_at: ts(40),
          completed_at: ts(35),
        },
      ],
    },
    [ETA]: {
      messages: [
        { ...userMsg(ETA, 'Apply the migration to the production database', 12), prompt_id: 'prompt_fx_eta_active' },
      ],
      active_prompt: prompt(
        'prompt_fx_eta_active',
        'Apply the migration to the production database',
        12,
        'running',
      ),
      pending_approvals: [
        {
          approval_id: fid('approval'),
          session_id: ETA,
          turn_id: 1,
          tool_call_id: fid('call'),
          tool_name: 'Bash',
          action: 'Running: psql -f migrate.sql',
          tool_input_display: { kind: 'command', command: 'psql -f migrate.sql' },
          created_at: ts(6),
          expires_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
        },
      ],
    },
    [THETA]: {
      messages: [
        userMsg(THETA, 'Index the reference corpus in the background', 45),
      ],
      tasks: [
        {
          id: fid('task'),
          session_id: THETA,
          kind: 'bash',
          description: 'corpus indexer',
          status: 'running',
          command: 'node indexer.mjs --watch references/',
          created_at: ts(40),
          started_at: ts(40),
        },
      ],
    },
  },
  usageV2,
};
