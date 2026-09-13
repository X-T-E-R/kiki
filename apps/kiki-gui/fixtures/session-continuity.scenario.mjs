import { sessionRecord, assistantMsg, userMsg } from './helpers.mjs';

export const SID = 'session_fixture_continuity';
export const profiles = [
  { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] },
  { name: 'workspace-main', source: 'workspace', main: true, disabled: false, pinned_model_alias: 'fixture/model-b', thinking_effort: 'high', routes: [] },
  { name: 'alternate-main', source: 'workspace', main: true, disabled: false, pinned_model_alias: 'fixture/model-a', thinking_effort: 'low', routes: [] },
  { name: 'disabled-main', source: 'workspace', main: true, disabled: true, routes: [] },
  { name: 'research', source: 'workspace', main: false, disabled: false, routes: [] },
];
export const capabilityTargets = [
  { profile: 'research', route: 'bounded', description: '有界证据检索', executor: 'native', model_alias: 'fixture/model-b', model_source: 'caller-lease', thinking_effort: 'high', effort_source: 'model-profile', defaults_available: true },
  { profile: 'executor', executor: 'external', model_alias: 'fixture/missing', model_source: 'profile', defaults_available: false, unavailable_reason: 'model alias is not configured' },
];

export default {
  config: { default_model: 'fixture/model-a', default_permission_mode: 'manual', providers: {} },
  models: [
    { model: 'fixture/model-a', provider: 'fixture', support_efforts: ['low'], default_effort: 'low' },
    { model: 'fixture/model-b', provider: 'fixture', support_efforts: ['low', 'high'], default_effort: 'low' },
  ],
  workspaces: [
    { id: 'wd_fixture_alpha', name: 'Alpha', root: 'C:/fixture/alpha', pinned: true, last_opened_at: '2026-09-06T00:00:00Z', session_count: 1 },
    { id: 'wd_fixture_beta', name: 'Beta', root: 'C:/fixture/beta', pinned: false, last_opened_at: '2026-09-05T00:00:00Z', session_count: 0 },
  ],
  agentProfiles: profiles,
  sessions: [sessionRecord(SID, {
    title: '连续性验证会话', workspace_id: 'wd_fixture_alpha', metadata: { cwd: 'C:/fixture/alpha' },
    agent_config: { profile: 'workspace-main', model: 'fixture/model-b', thinking: 'high', plan_mode: true, swarm_mode: true },
  })],
  snapshots: { [SID]: { messages: [userMsg(SID, '保留此历史记录'), assistantMsg(SID, ['历史记录保持不变。'])] } },
  onPrompt: [
    { frame: { type: 'turn.end', payload: { turnId: 1, reason: 'completed' } } },
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: '2026-09-06T00:01:00Z', reason: 'completed' } } },
    { frame: { type: 'session.work.changed', payload: { busy: false, pendingInteraction: 'none' } } },
  ],
};
