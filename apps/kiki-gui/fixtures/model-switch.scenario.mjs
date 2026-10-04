import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_model_switch';
const FROM = 'legacy/kiki-pro';
const MODEL = 'fixture/kiki-lite';
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

function switchMarker(operationId, state, mode, from, to, minutesAgo, extra = {}) {
  return {
    kind: 'marker',
    markerId: `model-switch:${operationId}`,
    marker: 'model.switch',
    at: ts(minutesAgo),
    payload: { operationId, state, mode, from, to, ...extra },
  };
}

const pendingInput = {
  operationId: 'switch-fixture-pending',
  model: MODEL,
  mode: 'fresh',
  thinking: 'high',
  selectedFromModel: FROM,
};
const pendingReceipt = {
  operationId: pendingInput.operationId,
  agentId: 'main',
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
    title: 'Fixture: model switch',
    agent_config: { model: FROM, profile: 'agent' },
    message_count: 7,
  })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      queued_prompts: [{
        prompt_id: 'prompt-fixture-model-switch',
        user_message_id: 'um-fixture-model-switch',
        status: 'queued',
        content: [{ type: 'text', text: 'Queue the release-note review after the model switch.' }],
        created_at: ts(2),
        queue_position: 0,
        append_timing: 'agent_idle',
        revision: 1,
      }],
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [
            turn('t1', 80, 'What changed in the release workflow?', 'The release workflow now records a review checkpoint before publishing.'),
            switchMarker('switch-fixture-pending', 'pending', 'fresh', FROM, MODEL, 70),
            turn('t2', 58, 'Summarize the checkpoint evidence.', 'The checkpoint captures the model binding, reviewer note, and final artifact hash.'),
            switchMarker('switch-fixture-completed', 'completed', 'compact', 'fixture/kiki-lite', 'fixture/kiki-pro', 45, { summaryGenerated: true, windowEpoch: 3 }),
            turn('t3', 32, 'Why did the last handoff stop?', 'The handoff stopped before the new model could take ownership of the context window.'),
            switchMarker('switch-fixture-failed', 'failed', 'compact', 'fixture/kiki-pro', MODEL, 18, { error: { code: 'model_switch.prepare_failed', message: 'Fixture handoff could not prepare the compact context.' } }),
          ],
          prompts: [{
            promptId: 'prompt-fixture-model-switch',
            userMessageId: 'um-fixture-model-switch',
            status: 'queued',
            content: [{ type: 'text', text: 'Queue the release-note review after the model switch.' }],
            createdAt: ts(2),
            queuePosition: 0,
            appendTiming: 'agent_idle',
            revision: 1,
          }],
          meta: { activity: 'idle', agent: { model: FROM, thinkingEffort: 'high' } },
        },
      },
    },
  },
  modelSwitches: {
    [SID]: {
      main: [{
        input: pendingInput,
        receipt: pendingReceipt,
        revision: 0,
        originalBinding: { model: FROM, thinking: 'high' },
        queueIndex: 1,
      }],
    },
  },
};
