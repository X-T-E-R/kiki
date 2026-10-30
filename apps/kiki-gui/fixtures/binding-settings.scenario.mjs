import modelSwitch from './model-switch.scenario.mjs';

const SID = 'session_fixture_model_switch';
const source = structuredClone(modelSwitch);
const snapshot = source.snapshots[SID];
const transcript = snapshot.agent_transcripts.main;
source.config.model_switch = { default_mode: 'direct', confirm: false, rules: [] };
source.sessions[0].title = 'Fixture: direct model settings';
source.sessions[0].agent_config.model = 'fixture/kiki-pro';
source.models[0].support_efforts = ['high', 'xhigh', 'max'];
source.models[0].default_effort = 'high';
snapshot.queued_prompts = [];
transcript.items = [transcript.items[0]];
transcript.prompts = [];
transcript.meta = { activity: 'idle', agent: { model: 'fixture/kiki-pro', thinkingEffort: 'high' } };
source.modelSwitches = {};
source.onPrompt = [
  { frame: { type: 'turn.started', payload: { turnId: 4, origin: { kind: 'user' } } } },
  { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
  { frame: { type: 'turn.step.started', payload: { turnId: 4, step: 1 } } },
  { frame: { type: 'assistant.delta', payload: { turnId: 4, step: 1, delta: '正在逐项检查迁移结果。' } } },
  { waitFor: 'release' },
  { frame: { type: 'turn.step.finished', payload: { turnId: 4, step: 1 } } },
  { frame: { type: 'turn.step.started', payload: { turnId: 4, step: 2 } } },
  { frame: { type: 'assistant.delta', payload: { turnId: 4, step: 2, delta: '继续下一步检查。' } } },
  { frame: { type: 'turn.step.finished', payload: { turnId: 4, step: 2 } } },
  { frame: { type: 'turn.ended', payload: { turnId: 4, result: { type: 'completed', steps: 2 } } } },
  { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
];
export default source;
