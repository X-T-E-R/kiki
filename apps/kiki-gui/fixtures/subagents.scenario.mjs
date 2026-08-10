import { sessionRecord, turnEnd, workChanged } from './helpers.mjs';

const SID = 'session_fixture_subagents';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: subagents' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        'agent-research': {
          agent_id: 'agent-research',
          has_more: false,
          items: [
            {
              kind: 'turn',
              turnId: '1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'Inspect the protocol events and report concrete facts.',
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              steps: [
                {
                  kind: 'step',
                  stepId: 'research-step-1',
                  turnId: '1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: new Date().toISOString(),
                  endedAt: new Date().toISOString(),
                  frames: [
                    { kind: 'thinking', frameId: 'research-thinking', text: 'Tracing the event envelope and model binding fields.' },
                    {
                      kind: 'tool',
                      frameId: 'research-read-frame',
                      toolCallId: 'research-read',
                      name: 'Read',
                      state: 'done',
                      input: { path: 'packages/protocol/src/events.ts' },
                      output: 'Subagent events carry model and thinkingEffort.',
                    },
                    { kind: 'text', frameId: 'research-answer', role: 'assistant', text: 'Protocol map complete.' },
                    { kind: 'text', frameId: 'research-report', role: 'assistant', text: 'Protocol map complete. The child event stream is agent-scoped and the model binding is optional.' },
                  ],
                },
              ],
            },
          ],
        },
        'agent-review': {
          agent_id: 'agent-review',
          has_more: false,
          items: [
            {
              kind: 'turn',
              turnId: '1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'Review the proposed subagent UI.',
              steps: [
                {
                  kind: 'step',
                  stepId: 'review-step-1',
                  turnId: '1',
                  ordinal: 1,
                  state: 'completed',
                  frames: [
                    { kind: 'tool', frameId: 'review-check-frame', toolCallId: 'review-check', name: 'Check', state: 'done', input: { surface: 'main transcript' }, output: 'No inline subagent tools in the main thread.' },
                    { kind: 'text', frameId: 'review-report', role: 'assistant', text: 'Presentation contract verified with no inline child tool cards.' },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
    workChanged(true),
    {
      frame: {
        type: 'subagent.spawned',
        payload: {
          subagentId: 'agent-research',
          subagentName: 'Researcher',
          parentToolCallId: 'call-agent-research',
          description: 'Map the protocol surface',
          runInBackground: false,
          model: 'kimi-code/k3',
          thinkingEffort: 'high',
        },
      },
    },
    {
      frame: {
        type: 'subagent.spawned',
        payload: {
          subagentId: 'agent-review',
          subagentName: 'Reviewer',
          parentToolCallId: 'call-agent-review',
          description: 'Review the presentation contract',
          runInBackground: true,
        },
      },
    },
    { frame: { type: 'subagent.started', payload: { subagentId: 'agent-research' } } },
    { frame: { type: 'subagent.started', payload: { subagentId: 'agent-review' } } },
    {
      frame: {
        type: 'turn.started',
        agentId: 'agent-research',
        payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Inspect the protocol events and report concrete facts.' },
      },
    },
    {
      frame: {
        type: 'thinking.delta',
        agentId: 'agent-research',
        offset: 0,
        payload: { turnId: 1, delta: 'Tracing the event envelope and model binding fields.' },
      },
    },
    {
      frame: {
        type: 'tool.call.started',
        agentId: 'agent-research',
        payload: {
          turnId: 1,
          toolCallId: 'research-read',
          name: 'Read',
          args: { path: 'packages/protocol/src/events.ts' },
          description: 'Read protocol events',
        },
      },
    },
    {
      frame: {
        type: 'tool.result',
        agentId: 'agent-research',
        payload: { turnId: 1, toolCallId: 'research-read', output: 'Subagent events carry model and thinkingEffort.' },
      },
    },
    {
      frame: {
        type: 'assistant.delta',
        agentId: 'agent-research',
        offset: 0,
        payload: { turnId: 1, delta: 'Protocol map complete.' },
      },
    },
    { frame: { type: 'turn.ended', agentId: 'agent-research', payload: { turnId: 1, reason: 'completed', durationMs: 1450 } } },
    {
      frame: {
        type: 'turn.started',
        agentId: 'agent-review',
        payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Review the proposed subagent UI.' },
      },
    },
    {
      frame: {
        type: 'tool.call.started',
        agentId: 'agent-review',
        payload: {
          turnId: 1,
          toolCallId: 'review-check',
          name: 'Check',
          args: { surface: 'main transcript' },
          description: 'Check presentation',
        },
      },
    },
    {
      frame: {
        type: 'tool.result',
        agentId: 'agent-review',
        payload: { turnId: 1, toolCallId: 'review-check', output: 'No inline subagent tools in the main thread.' },
      },
    },
    {
      frame: {
        type: 'assistant.delta',
        agentId: 'agent-review',
        offset: 0,
        payload: { turnId: 1, delta: 'Presentation contract verified.' },
      },
    },
    { frame: { type: 'turn.ended', agentId: 'agent-review', payload: { turnId: 1, reason: 'completed', durationMs: 930 } } },
    {
      frame: {
        type: 'subagent.completed',
        payload: {
          subagentId: 'agent-research',
          resultSummary: 'Protocol map complete. The child event stream is agent-scoped and the model binding is optional.',
        },
      },
    },
    {
      frame: {
        type: 'subagent.completed',
        payload: {
          subagentId: 'agent-review',
          resultSummary: 'Presentation contract verified with no inline child tool cards.',
        },
      },
    },
    turnEnd(1),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
