/**
 * external-model-picker — two sessions bound to external engines, exercising
 * the composer's engine-model picker against the engine's own catalog:
 *
 *   - "Fixture: external model picker" runs claude-acp with a saved override
 *     whose id the engine no longer lists. The catalog read is fresh and
 *     ready, so the picker lists the engine's own ids, keeps the saved one
 *     selectable, and flags it — without blocking send. Refresh re-reads the
 *     engine and the refreshed list knows the id again, so the flag clears.
 *     The same catalog declares manual compaction unsupported, which the
 *     context meter must say instead of offering a button that cannot work.
 *   - "Fixture: external engine silent" runs grok-acp, whose catalog read
 *     fails. The picker shows the follow-the-engine choice, and pressing
 *     Refresh surfaces the failure as a line, not a dead button.
 *
 * All ids and versions are the fixture's own; no real engine is contacted.
 */

import { sessionRecord } from './helpers.mjs';

const SID_A = 'session_fixture_external_model_picker';
const SID_B = 'session_fixture_external_engine_silent';

const RETIRED_MODEL = 'claude-3-7-sonnet-20250224';

function catalog({ revision, values }) {
  return {
    executor_id: 'claude-acp',
    source: 'cli_probe',
    provenance: 'read_only_cli_probe',
    revision,
    apply_state: 'ready',
    observed_at: Date.now(),
    executor_version: '2.1.4',
    catalog_command: 'claude models --json',
    effective: {
      models: { state: 'ready', values },
      thinking_levels: { state: 'ready', values: ['low', 'medium', 'high'] },
      context: { state: 'ready', context_window: 200_000 },
      controls: {
        model_switch: { advertised: true, applicability: 'live', apply_state: 'applied' },
        thinking_switch: { applicability: 'unknown', apply_state: 'unknown' },
        manual_compact: {
          advertised: false,
          applicability: 'unsupported',
          apply_state: 'unsupported',
          diagnostic: 'Claude Code compacts on its own schedule.',
        },
      },
    },
  };
}

function boundTo(executor, overrides) {
  return {
    model: '',
    execution: {
      version: 1,
      selection: { executor, ...(overrides === undefined ? {} : { overrides }) },
      effective: {
        ...(overrides?.model == null ? {} : { model: overrides.model }),
        kiki_context: ['memory'],
        allow_kiki_subagents: false,
      },
      sources: {
        ...(overrides?.model == null ? {} : { model: 'session' }),
        kiki_context: 'session',
        allow_kiki_subagents: 'harness-default',
      },
      generation: 1,
    },
  };
}

export default {
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
  ],
  // GET /executors: the native engine plus the two external ones the sessions
  // are bound to.
  executors: [
    { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    { id: 'claude-acp', label: 'Claude Code', protocol: 'acp', status: 'ready', version: '2.1.4', model_binding: 'mapped', thinking_binding: 'unavailable' },
    { id: 'grok-acp', label: 'Grok Build', protocol: 'acp', status: 'ready', version: '0.9.0', model_binding: 'mapped', thinking_binding: 'unavailable' },
  ],
  // GET /executors/{id}/models: claude-acp answers a fresh, ready catalog;
  // grok-acp's read fails the way a dead engine does.
  executorModels: {
    'claude-acp': catalog({ revision: 'rev-2026-10-08.1', values: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'] }),
    'grok-acp': 'error',
  },
  // POST /executors/claude-acp/models:refresh: the engine re-listing now knows
  // the id the session had saved, so the "not in this engine's list" flag
  // clears on the refreshed read.
  executorModelsRefresh: {
    'claude-acp': catalog({
      revision: 'rev-2026-10-08.2',
      values: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', RETIRED_MODEL],
    }),
  },
  sessions: [
    sessionRecord(SID_A, {
      title: 'Fixture: external model picker',
      // A committed binding to the external engine, with a saved model
      // override the engine's current list no longer names.
      agent_config: boundTo('claude-acp', { model: RETIRED_MODEL }),
    }),
    sessionRecord(SID_B, {
      title: 'Fixture: external engine silent',
      agent_config: boundTo('grok-acp'),
    }),
  ],
  agentPanel: {
    context: 'live',
    owner: { profile: 'agent', agent_id: 'main' },
    available: true,
    profile: {
      name: 'agent',
      description: 'Fixture general-purpose agent.',
      source: 'builtin',
      model: 'fixture/kiki-pro',
      thinking_effort: 'high',
      profile_source: 'registered',
      subagent_policy: 'advisory',
    },
    targets: [],
  },
  snapshots: {
    [SID_A]: { messages: [], has_more: false },
    [SID_B]: { messages: [], has_more: false },
  },
};
