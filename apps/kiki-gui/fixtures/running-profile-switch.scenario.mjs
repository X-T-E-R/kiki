/**
 * running-profile-switch — a session with a turn in flight and a catalog of
 * more than one main profile, so the profile chip can be opened, browsed and
 * switched while the composer is busy. The turn stays running throughout; the
 * point of the scenario is the composer, not the transcript.
 */

import { sessionRecord, streamSteps, userMsg } from './helpers.mjs';

const SID = 'session_fixture_profile_switch';

export default {
  // Two switchable main profiles: without a second one the picker has nothing
  // to switch to and the whole path is untestable.
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'reviewer', source: 'workspace', description: 'Reviews changes before they land.', main: true, routes: [] },
  ],
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: running profile switch',
      // `model` is a required string in agent_config; the default record keeps
      // it, so only the profile is overridden here.
      agent_config: { model: '', profile: 'agent' },
    }),
  ],
  // The composer's frozen profile-domain read: without a seeded profile the
  // model domain reads "unknown" and sending is disabled.
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
      // A complete snapshot: without this the seat stays in its settling phase
      // and the whole composer is mounted hidden.
      messages: [userMsg(SID, 'Start the long job.', 12)],
      has_more: false,
    },
  },
  // A turn that starts and never ends. The transcript derives "busy" and the
  // abortable ids from a running turn item, so a seeded record alone is not
  // enough — the composer would sit idle and the whole path would be untested.
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, 'Still working through the migration…', { per: 40, delay: 60 }),
  ],
};
