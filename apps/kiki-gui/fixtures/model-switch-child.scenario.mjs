/**
 * Child (subagent) workspace with a model switch: the same switch contract as
 * `model-switch.scenario.mjs`, but the session carries a real child agent so
 * the child chrome's own entries (its menu, its composer line) can be seen and
 * photographed. The child transcript is seeded, so the workspace renders with
 * history and no prompt has to be sent first.
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_switch_child';
const FROM = 'legacy/kiki-pro';
const MODEL = 'fixture/kiki-lite';
const CHILD = 'agent-research';
const WSID = 'wd_fixture_000000000000';

function turn(turnId, minutesAgo, prompt, answer) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId.slice(1)),
    state: 'completed',
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps: [{
      kind: 'step',
      stepId: `${turnId}.1`,
      turnId,
      ordinal: 1,
      state: 'completed',
      startedAt: ts(minutesAgo),
      endedAt: ts(minutesAgo - 1),
      frames: [{ kind: 'text', frameId: `${turnId}-answer`, role: 'assistant', text: answer }],
    }],
  };
}

const pendingInput = {
  operationId: 'switch-child-pending',
  model: MODEL,
  mode: 'fresh',
  thinking: 'high',
  selectedFromModel: FROM,
};
const pendingReceipt = {
  operationId: pendingInput.operationId,
  agentId: CHILD,
  state: 'pending',
  fromModel: FROM,
  toModel: MODEL,
  mode: 'fresh',
};

export default {
  config: {
    default_provider: 'fixture',
    default_model: 'fixture/kiki-pro',
    default_permission_mode: 'manual',
    providers: { fixture: { type: 'openai', has_api_key: true } },
    model_switch: {
      default_mode: 'direct',
      confirm: true,
      rules: [{
        id: 'prefer-fresh',
        enabled: true,
        from_models: ['fixture/*'],
        to_models: ['fixture/*'],
        mode: 'fresh',
        confirm: false,
      }],
    },
  },
  models: [
    { provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
    { provider: 'fixture', model: MODEL, display_name: 'Kiki Lite', max_context_size: 131072, support_efforts: ['low'], default_effort: 'low' },
    { id: FROM, provider_id: 'legacy', remote_id: 'kiki-pro', display_name: 'Legacy Kiki Pro', max_context_size: 131072, support_efforts: ['high'], default_effort: 'high' },
  ],
  providers: [
    { id: 'fixture', type: 'openai', has_api_key: true, status: 'connected', models: ['fixture/kiki-pro', MODEL] },
    { id: 'legacy', type: 'openai', has_api_key: true, status: 'connected', models: [FROM] },
  ],
  workspaces: [{
    id: WSID,
    root: 'C:/fixture/workshop',
    name: 'workshop',
    created_at: ts(120),
    last_opened_at: ts(1),
    session_count: 1,
    pinned: false,
  }],
  agentProfiles: [{ name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] }],
  sessions: [sessionRecord(SID, {
    title: 'Fixture: child model switch',
    agent_config: { model: FROM, profile: 'agent' },
    message_count: 4,
  })],
  subagents: [{
    agentId: CHILD,
    name: 'research',
    label: 'Researcher',
    parentAgentId: 'main',
    status: 'running',
    busy: false,
    toolCallCount: 3,
    childIds: [],
  }],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [turn('t1', 40, 'Map the protocol surface with a researcher.', 'The researcher is mapping the protocol surface.')],
          meta: { activity: 'idle', agent: { model: FROM, thinkingEffort: 'high' } },
        },
        [CHILD]: {
          agent_id: CHILD,
          has_more: false,
          items: [
            turn('t1', 30, 'Map the protocol surface.', 'The child event stream is agent-scoped and the model binding is optional.'),
            turn('t2', 20, 'Report the switch contract.', 'A queued switch is accepted, then runs when the agent goes idle.'),
          ],
          meta: { activity: 'idle', agent: { model: FROM, thinkingEffort: 'high' } },
        },
      },
    },
  },
  modelSwitches: {
    [SID]: {
      [CHILD]: [{
        input: pendingInput,
        receipt: pendingReceipt,
        revision: 0,
        originalBinding: { model: FROM, thinking: 'high' },
        queueIndex: 1,
      }],
    },
  },
};
