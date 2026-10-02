import { sessionRecord, streamSteps, workChanged } from './helpers.mjs';

const SID = 'session_fixture_send_timing';

/**
 * The composer's send-timing hover menu needs a session that stays busy: the
 * turn sits inside a held tool call (a release gate stands in for the tool's
 * runtime) until the walker lets it end. Unlike the steer fixture this one
 * seeds the agent-panel read with a profile, so the composer's model-domain
 * check passes and send stays enabled.
 *
 * Walker gates: release #1 finishes the tool and ends the turn.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: send timing' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  // The composer's frozen profile-domain read: without a seeded profile the
  // unseeded default leaves the model domain "unknown" and send disabled.
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
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, 'Running the suite first.', { per: 24, delay: 20 }),
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1,
          toolCallId: 'call-send-timing',
          name: 'Bash',
          args: { command: 'pnpm test --run' },
          description: 'Run the test suite',
          display: { kind: 'command', command: 'pnpm test --run' },
        },
      },
    },
    { waitFor: 'release' },
    {
      frame: {
        type: 'tool.result',
        payload: { turnId: 1, toolCallId: 'call-send-timing', output: { kind: 'command_output', exit_code: 0, stdout: '161 passed\n' } },
      },
    },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.ended', payload: { turnId: 1, reason: 'completed', durationMs: 2400 } } },
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
