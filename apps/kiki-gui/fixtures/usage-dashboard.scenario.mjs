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
};
