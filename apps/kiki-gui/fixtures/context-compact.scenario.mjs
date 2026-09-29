/**
 * context-compact — the automatic-compaction point across its states. Every
 * session answers `GET/PATCH …/agents/{agent}/auto-compact` through
 * scripts/fixture-auto-compact.mjs, so the panel, the model editor and the
 * profile editor read and write one shared state.
 *
 *   - "window 550k"   legacy default 467.5k, 312k used (room left);
 *   - "past point"    session override 400k with 430k used (compacts next step);
 *   - "usable < window" a 300k usable limit on a 550k window (context_budget);
 *   - "tiny window"   a 96k window: floor above ceil, the point cannot move;
 *   - "older engine"  the route 404s: the meter keeps its plain rows.
 */

import { sessionRecord } from './helpers.mjs';

const WSID = 'wd_fixture_000000000000';
const usage = (context, limit) => ({
  input_tokens: 182_000,
  output_tokens: 21_400,
  cache_read_tokens: 140_000,
  cache_creation_tokens: 18_000,
  total_cost_usd: 1.284,
  context_tokens: context,
  context_limit: limit,
  turn_count: 14,
});

const session = (id, title, model, context, limit, profile = 'agent') => sessionRecord(id, {
  title,
  agent_config: { model, profile },
  usage: usage(context, limit),
});

export default {
  config: {
    default_provider: 'fixture',
    default_model: 'fixture/opus-5-5',
    default_permission_mode: 'manual',
    providers: { fixture: { type: 'anthropic', has_api_key: true } },
    loop_control: { compactionTriggerRatio: 0.85 },
  },
  models: [
    { provider: 'fixture', model: 'fixture/opus-5-5', display_name: 'Opus 5.5', max_context_size: 550_000, support_efforts: ['low', 'high'], default_effort: 'high' },
    { provider: 'fixture', model: 'fixture/gateway-550', display_name: 'Gateway 550k', max_context_size: 550_000 },
    { provider: 'fixture', model: 'fixture/tiny-96k', display_name: 'Tiny 96k', max_context_size: 96_000 },
    { provider: 'fixture', model: 'fixture/kiki-lite', display_name: 'Kiki Lite', max_context_size: 200_000, auto_compact: 140_000 },
  ],
  providers: [
    { id: 'fixture', type: 'anthropic', has_api_key: true, status: 'connected', models: ['fixture/opus-5-5', 'fixture/gateway-550', 'fixture/tiny-96k', 'fixture/kiki-lite'] },
  ],
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: new Date(Date.now() - 7_200_000).toISOString(), last_opened_at: new Date().toISOString(), session_count: 5, pinned: false },
  ],
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    {
      name: 'builder',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/home/agents/builder.md',
      description: 'Long-running implementation agent.',
      prompt: 'Own the implementation end to end.',
      pinned_model_alias: 'fixture/opus-5-5',
      main: true,
      routes: [],
    },
  ],
  sessions: [
    session('session_fixture_compact_room', 'Fixture: window 550k', 'fixture/opus-5-5', 312_000, 550_000, 'builder'),
    session('session_fixture_compact_past', 'Fixture: past point', 'fixture/opus-5-5', 430_000, 550_000),
    session('session_fixture_compact_budget', 'Fixture: usable < window', 'fixture/gateway-550', 180_000, 550_000),
    session('session_fixture_compact_tiny', 'Fixture: tiny window', 'fixture/tiny-96k', 41_000, 96_000),
    session('session_fixture_compact_legacy', 'Fixture: older engine', 'fixture/opus-5-5', 120_000, 550_000),
  ],
  snapshots: {
    session_fixture_compact_room: { messages: [], has_more: false },
    session_fixture_compact_past: { messages: [], has_more: false },
    session_fixture_compact_budget: { messages: [], has_more: false },
    session_fixture_compact_tiny: { messages: [], has_more: false },
    session_fixture_compact_legacy: { messages: [], has_more: false },
  },
  autoCompact: {
    windows: {
      'fixture/gateway-550': { usable: 300_000 },
      'fixture/tiny-96k': { reserved: 50_000 },
    },
    overrides: {
      session_fixture_compact_past: { main: { 'fixture/opus-5-5': 400_000 } },
    },
    disabled: ['session_fixture_compact_legacy'],
  },
};
