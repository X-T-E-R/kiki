import { sessionRecord, streamSteps, turnEnd, workChanged } from './helpers.mjs';

const MAIN = 'session_fixture_steer';
const CHILD_SID = 'session_fixture_steer_child';
const HELPER = 'agent-helper';

/**
 * "Send now" into a running turn, for the main session and a native child.
 *
 * Both turns sit inside a long tool call (a release gate stands in for the
 * tool's runtime). A message sent now is accepted at once but only joins the
 * turn at its next step boundary — after the tool returns — which is where the
 * fixture delivers it (context.append_message), exactly like the engine. The
 * steer receipt is held briefly so the walker can see the in-flight phase.
 *
 * Walker gates: release #1 finishes the tool (delivery), release #2 ends the turn.
 */
const toolCall = (agentId, turnId, id) => ({
  frame: {
    type: 'tool.call.started',
    ...(agentId === undefined ? {} : { agentId }),
    payload: {
      turnId,
      toolCallId: id,
      name: 'Bash',
      args: { command: 'pnpm test --run' },
      description: 'Run the test suite',
      display: { kind: 'command', command: 'pnpm test --run' },
    },
  },
});
const toolResult = (agentId, turnId, id) => ({
  frame: {
    type: 'tool.result',
    ...(agentId === undefined ? {} : { agentId }),
    payload: { turnId, toolCallId: id, output: { kind: 'command_output', exit_code: 0, stdout: '161 passed\n' } },
  },
});
const agentFrame = (agentId, type, payload) => ({ frame: { type, ...(agentId === undefined ? {} : { agentId }), payload } });

const mainScript = [
  { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Run the tests and fix what fails.' } } },
  workChanged(true),
  { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
  ...streamSteps('assistant.delta', 1, 'Running the suite first.', { per: 24, delay: 20 }),
  toolCall(undefined, 1, 'call-steer-main'),
  { waitFor: 'release' },
  toolResult(undefined, 1, 'call-steer-main'),
  { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
  // The boundary where a message sent now becomes part of the turn.
  { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 2 } } },
  { delay: 200 },
  { frame: { type: 'assistant.delta', offset: 0, payload: { turnId: 1, delta: 'All green. Noted — I will also check the docs.' } } },
  { waitFor: 'release' },
  { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 2 } } },
  turnEnd(1),
  { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
  workChanged(false),
];

const childScript = [
  { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Delegate the test run.' } } },
  workChanged(true),
  {
    frame: {
      type: 'subagent.spawned',
      payload: {
        subagentId: HELPER, subagentName: 'Tester', parentToolCallId: 'call-agent-helper',
        description: 'Run the suite', runInBackground: false, model: 'fixture/kiki-pro', thinkingEffort: 'high',
      },
    },
  },
  { frame: { type: 'subagent.started', payload: { subagentId: HELPER } } },
  agentFrame(HELPER, 'turn.started', { turnId: 1, origin: { kind: 'user' }, prompt: 'Run the suite and report failures.' }),
  agentFrame(HELPER, 'turn.step.started', { turnId: 1, step: 1 }),
  agentFrame(HELPER, 'assistant.delta', { turnId: 1, delta: 'Running the suite first.' }),
  toolCall(HELPER, 1, 'call-steer-child'),
  { waitFor: 'release' },
  toolResult(HELPER, 1, 'call-steer-child'),
  agentFrame(HELPER, 'turn.step.completed', { turnId: 1, step: 1 }),
  agentFrame(HELPER, 'turn.step.started', { turnId: 1, step: 2 }),
  { delay: 200 },
  { frame: { type: 'assistant.delta', agentId: HELPER, offset: 0, payload: { turnId: 1, delta: 'All green. Noted — I will also check the docs.' } } },
  { waitFor: 'release' },
  agentFrame(HELPER, 'turn.ended', { turnId: 1, reason: 'completed', durationMs: 2400 }),
  { frame: { type: 'subagent.completed', payload: { subagentId: HELPER, resultSummary: 'All green.' } } },
  turnEnd(1),
  { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
  workChanged(false),
];

export default {
  sessions: [
    sessionRecord(MAIN, { title: 'Fixture: steer' }),
    sessionRecord(CHILD_SID, { title: 'Fixture: steer child' }),
  ],
  snapshots: {
    [MAIN]: { messages: [], has_more: false },
    [CHILD_SID]: { messages: [], has_more: false },
  },
  steerReplyDelayMs: 900,
  onPrompt: (text, sessionId) => (sessionId === CHILD_SID ? childScript : mainScript),
};
