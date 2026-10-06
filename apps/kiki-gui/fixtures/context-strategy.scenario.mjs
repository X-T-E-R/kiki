/**
 * context-strategy — the context-renewal strategy control in the ContextMeter
 * card and the strategy on compaction markers. Every session answers
 * `…/auto-compact` (scripts/fixture-auto-compact.mjs) and
 * `…/context-strategy` (scripts/fixture-context-strategy.mjs).
 *
 *   - "strategy timeline"  built-in default (auto); the timeline holds a
 *                          summarize, a fresh, a fresh→summarize fallback and
 *                          a summarize→fresh rescue compaction marker;
 *   - "from profile"       profile `builder` sets fresh;
 *   - "session override"   this session overrides to auto;
 *   - "executor"           an external executor: summarize, locked;
 *   - "older engine"       the strategy route 404s: the card has no block.
 */

import { sessionRecord, ts } from './helpers.mjs';

const WSID = 'wd_fixture_000000000000';
const SID = 'session_fixture_strategy_timeline';
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

const session = (id, title, context, profile = 'agent') => sessionRecord(id, {
  title,
  agent_config: { model: 'fixture/opus-5-5', profile },
  usage: usage(context, 550_000),
});

function turn(turnId, minutesAgo, prompt, answer) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state: 'completed',
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps: [{
      kind: 'step', stepId: `${turnId}.1`, turnId, ordinal: 1, state: 'completed',
      startedAt: ts(minutesAgo), endedAt: ts(minutesAgo - 1),
      frames: [{ kind: 'text', frameId: `t${turnId}-answer`, role: 'assistant', text: answer }],
    }],
  };
}

const compaction = (id, minutesAgo, payload) => ({ kind: 'marker', markerId: id, marker: 'compaction', at: ts(minutesAgo), payload });

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
  ],
  providers: [
    { id: 'fixture', type: 'anthropic', has_api_key: true, status: 'connected', models: ['fixture/opus-5-5'] },
  ],
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: new Date(Date.now() - 7_200_000).toISOString(), last_opened_at: new Date().toISOString(), session_count: 5, pinned: false },
  ],
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'builder', source: 'user', workspace_id: WSID, source_file: 'C:/fixture/home/agents/builder.md', description: 'Long-running implementation agent.', main: true, routes: [] },
  ],
  sessions: [
    session(SID, 'Fixture: strategy timeline', 312_000),
    session('session_fixture_strategy_profile', 'Fixture: from profile', 180_000, 'builder'),
    session('session_fixture_strategy_session', 'Fixture: session override', 240_000),
    session('session_fixture_strategy_executor', 'Fixture: executor', 90_000),
    session('session_fixture_strategy_legacy', 'Fixture: older engine', 120_000),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [
            turn('1', 90, 'Port the importer to the new schema.', 'Mapped the old columns; starting with the reader.'),
            compaction('m-compact-summarize', 80, { strategy: 'summarize', shapeVersion: 1 }),
            turn('2', 70, 'Keep going with the writer.', 'Writer ported; three fixtures still fail.'),
            compaction('m-compact-fresh', 60, { strategy: 'relay', shapeVersion: 1, reasonCodes: [] }),
            turn('3', 50, 'Fix the failing fixtures.', 'Two fixed; the third needs a date-format decision.'),
            compaction('m-compact-fallback', 40, { strategy: 'summarize', shapeVersion: 1, reasonCodes: ['notes_missing'], fallbackFrom: 'relay' }),
            turn('4', 30, 'Use ISO dates.', 'Switched to ISO 8601; all fixtures pass.'),
            compaction('m-compact-rescue', 20, { strategy: 'relay', shapeVersion: 1, reasonCodes: ['summarize_failed_relay_rescue'], fallbackFrom: 'summarize' }),
            turn('5', 10, 'Summarize what changed.', 'Reader, writer and fixtures now use the new schema.'),
          ],
        },
      },
    },
    session_fixture_strategy_profile: { messages: [], has_more: false },
    session_fixture_strategy_session: { messages: [], has_more: false },
    session_fixture_strategy_executor: { messages: [], has_more: false },
    session_fixture_strategy_legacy: { messages: [], has_more: false },
  },
  contextStrategy: {
    profiles: { builder: 'fresh' },
    overrides: { session_fixture_strategy_session: 'auto' },
    executor: ['session_fixture_strategy_executor'],
    disabled: ['session_fixture_strategy_legacy'],
  },
};
