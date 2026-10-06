/**
 * bare-harness — a session that a Kiki profile normally drives, next to two
 * external engines: one with a profile of its own, one with none. The point of
 * the scenario is the composer's execution control, so the catalog, the panel
 * and the switch confirmation all have something to say; the transcript stays
 * short.
 */

import { sessionRecord, streamSteps, userMsg } from './helpers.mjs';

const SID = 'session_fixture_bare_harness';

export default {
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'claude-reviewer', source: 'workspace', description: 'Reviews a diff before it lands.', main: true, executor: 'claude-acp', routes: [] },
  ],
  // GET /executors: the native engine plus two external ones.
  executors: [
    { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    { id: 'claude-acp', label: 'Claude Code', protocol: 'acp', status: 'ready', version: '2.1.4', model_binding: 'mapped', thinking_binding: 'unavailable' },
    { id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.58.0', model_binding: 'mapped', thinking_binding: 'mapped' },
  ],
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: bare harness execution',
      agent_config: {
        model: '',
        profile: 'agent',
        // A committed binding, so the chip can show what this session runs and
        // the panel can mark the current row.
        execution: {
          version: 1,
          selection: { executor: 'native', profile: 'agent' },
          effective: { model: 'fixture/kiki-pro', thinking: 'high', kiki_context: ['memory'], allow_kiki_subagents: false },
          sources: { model: 'session', thinking: 'profile', kiki_context: 'session', allow_kiki_subagents: 'harness-default' },
          generation: 1,
        },
      },
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
    [SID]: {
      messages: [userMsg(SID, 'Start the migration.', 12)],
      has_more: false,
    },
  },
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, 'Still working through the migration…', { per: 40, delay: 60 }),
  ],
};
