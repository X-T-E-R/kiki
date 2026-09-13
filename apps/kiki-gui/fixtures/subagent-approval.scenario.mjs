import { sessionRecord, turnEnd, workChanged } from './helpers.mjs';

const SID = 'session_fixture_subagent_approval';

/**
 * Subagent-origin approval: a child agent requests approval for a gated Bash
 * call. The main transcript must render an actionable card tagged with the
 * subagent's name (the resolve route is session-scoped), and the agent page
 * must surface the same interaction from the transcript response's
 * `interactions` array. The script parks on the approval like a real agent.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: subagent approval' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        'agent-worker': {
          agent_id: 'agent-worker',
          has_more: false,
          items: [
            {
              kind: 'turn',
              turnId: 't2',
              ordinal: 2,
              state: 'running',
              origin: { kind: 'user' },
              prompt: 'Clean the build output.',
              steps: [
                {
                  kind: 'step',
                  stepId: 't2.1',
                  turnId: 't2',
                  ordinal: 1,
                  state: 'running',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'tool-child-rm',
                      toolCallId: 'child-rm',
                      name: 'Bash',
                      state: 'running',
                      input: { command: 'rm -rf build' },
                      display: { kind: 'command', command: 'rm -rf build' },
                    },
                  ],
                },
              ],
            },
          ],
          interactions: [
            {
              interactionId: 'approval_fixture_child',
              interactionKind: 'approval',
              toolCallId: 'child-rm',
              state: 'pending',
              request: {
                turnId: 2,
                toolCallId: 'child-rm',
                toolName: 'Bash',
                action: 'Run: rm -rf build',
                display: { kind: 'command', command: 'rm -rf build' },
              },
            },
          ],
        },
      },
    },
  },
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Clean the build output.' } } },
    workChanged(true),
    {
      frame: {
        type: 'subagent.spawned',
        payload: {
          subagentId: 'agent-worker',
          subagentName: 'Approver',
          parentToolCallId: 'call-agent-worker',
          description: 'Clean the build output',
          runInBackground: false,
          model: 'kimi-code/k3',
        },
      },
    },
    { frame: { type: 'subagent.started', payload: { subagentId: 'agent-worker' } } },
    {
      frame: {
        type: 'turn.started',
        agentId: 'agent-worker',
        payload: { turnId: 2, origin: { kind: 'user' }, prompt: 'Clean the build output.' },
      },
    },
    {
      frame: {
        type: 'tool.call.started',
        agentId: 'agent-worker',
        payload: {
          turnId: 2,
          toolCallId: 'child-rm',
          name: 'Bash',
          args: { command: 'rm -rf build' },
          display: { kind: 'command', command: 'rm -rf build' },
          description: 'Remove the build directory',
        },
      },
    },
    {
      frame: {
        type: 'event.approval.requested',
        agentId: 'agent-worker',
        payload: {
          approval_id: 'approval_fixture_child',
          agentId: 'agent-worker',
          session_id: '$SID',
          turn_id: 2,
          tool_call_id: 'child-rm',
          tool_name: 'Bash',
          action: 'Run: rm -rf build',
          tool_input_display: { kind: 'command', command: 'rm -rf build' },
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
        },
      },
    },
    { waitFor: 'approval' },
    {
      frame: {
        type: 'tool.result',
        agentId: 'agent-worker',
        payload: { turnId: 2, toolCallId: 'child-rm', output: 'removed 41MB of build output' },
      },
    },
    // Child deltas ride the honest no-offset path (the real tracker annotates
    // cumulative offsets on main-agent deltas only).
    {
      frame: {
        type: 'assistant.delta',
        agentId: 'agent-worker',
        payload: { turnId: 2, delta: 'Cleanup approved and done.' },
      },
    },
    { frame: { type: 'turn.ended', agentId: 'agent-worker', payload: { turnId: 2, reason: 'completed', durationMs: 800 } } },
    {
      frame: {
        type: 'subagent.completed',
        payload: { subagentId: 'agent-worker', resultSummary: 'Cleanup approved and done.' },
      },
    },
    {
      frame: {
        type: 'assistant.delta',
        offset: 0,
        payload: { turnId: 1, delta: 'The gated cleanup finished.' },
      },
    },
    turnEnd(1),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
