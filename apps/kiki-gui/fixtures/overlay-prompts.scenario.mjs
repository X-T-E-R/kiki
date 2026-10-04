import { sessionRecord, userMsg, assistantMsg } from './helpers.mjs';

const SID = 'session_fixture_overlay_prompts';
const WSID = 'wd_fixture_000000000000';
const MODEL = 'fixture/model-a';
const SOURCE = 'C:/fixture/home/agents/lead.md';
const cognition = {
  overlay: 'cognition/common.md', steering: 'cognition/reminder.md',
  main: { overlay: 'cognition/main.md', overlay_mode: 'append' }, independent: 'off',
};

export default {
  config: {
    default_model: MODEL, providers: { fixture: { type: 'openai', has_api_key: true } },
    prompt: { variables: {}, overrides: { fields: { 'system.shared': 'Verify the result before reporting it.' }, main: 'off' } },
  },
  models: [{ provider: 'fixture', model: MODEL, display_name: 'Workspace model', max_context_size: 131072, cognition }],
  providers: [{ id: 'fixture', type: 'openai', has_api_key: true, status: 'connected', models: [MODEL] }],
  workspaces: [{ id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: '2026-01-01T10:00:00Z', last_opened_at: '2026-01-01T12:00:00Z', session_count: 1 }],
  agentProfiles: [{ name: 'lead', main: true, source: 'user', workspace_id: WSID, source_file: SOURCE, disabled: false, routes: [],
    description: 'Coordinate the work and review the result.', prompt: 'Help the user complete the task. Use evidence to verify the result.', pinned_model_alias: MODEL,
    prompt_overrides: { fields: { 'system.shared': 'Verify the result before reporting it.' }, main: { fields: { 'system.shared': 'Coordinate the work, then check the evidence.' } } },
    model_profiles: [{ alias: MODEL, prompt_mode: 'append', prompt: 'Complete the assigned work and report the evidence.', main: { prompt_mode: 'append', prompt: 'Keep the whole task in view and give the user a clear result.' } }],
  }, { name: 'shared', main: false, source: 'user', workspace_id: WSID, source_file: 'C:/fixture/home/agents/shared.md', disabled: false, routes: [],
    description: 'Check shared instructions.', prompt: 'Check the result.', pinned_model_alias: MODEL,
    prompt_overrides: { fields: { 'system.shared': 'Keep the shared instructions.' }, main: 'same', independent: 'off' },
  }],
  sessions: [sessionRecord(SID, { title: 'Review the release checklist', workspace_id: WSID, model: MODEL, profile: 'lead' })],
  snapshots: { [SID]: { messages: [userMsg(SID, 'Check the release checklist and tell me what is ready.'), assistantMsg(SID, ['The tests are complete. I am checking the remaining release notes.'])], has_more: false } },
  agentPanel: {
    context: 'live', live: true, owner: { profile: 'lead', agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    profile: { name: 'lead', description: 'Coordinate the work and review the result.', source: 'user', source_file: SOURCE, model: MODEL, executor: 'native' },
    prompt: {
      identity: { delegation_position: 'main', profile: 'lead', model_alias: MODEL, executor: 'native' },
      binding_revision: 'binding-7f93a2', disk_revision: 'disk-961b4e', disk_changed: true, apply_on: 'next-binding-or-context-rebuild', lease_model_prompts: 'preserve',
      channels: [
        { id: 'system.shared', channel: 'system', state: 'effective', selection: 'main', sources: [{ surface: 'global', kind: 'inline', path: 'C:/fixture/home/config.toml', line: 18, order: 1 }, { surface: 'profile', kind: 'inline', path: SOURCE, line: 12, order: 2 }] },
        { id: 'profile.model-prompt', channel: 'model_profile', state: 'effective', selection: 'main', sources: [{ surface: 'profile-model', kind: 'inline', path: SOURCE, line: 26, order: 1 }] },
        { id: 'cognition.overlay', channel: 'cognition_overlay', state: 'effective', selection: 'main', sources: [{ surface: 'model', kind: 'file', path: 'C:/fixture/home/cognition/main.md', order: 1 }] },
        { id: 'tool.read.guidance', channel: 'tool', state: 'effective', selection: 'common', sources: [{ surface: 'global', kind: 'file', path: 'C:/fixture/home/prompt/tools.toml', line: 8, order: 1 }] },
        { id: 'cognition.steering', channel: 'cognition_steering', state: 'inactive', selection: 'main', reason: 'The separate main-agent group does not include a per-turn reminder.', sources: [] },
        { id: 'cognition.anchor', channel: 'cognition_anchor', state: 'inactive', selection: 'main', reason: 'The separate main-agent group does not include a request anchor.', sources: [] },
      ],
      request: { system_prompt_hash: 'sha256:1ce952fac7a1bf6daa30921c982806e421c2b08d7f3b96bdf3e220f9a84ed31c', tools_hash: 'sha256:34d0b518aa7f1b8d318f28d1c0fa02c583a410bb2e60139a4cb1cbad209387b2', model_alias: MODEL, turn_step: 't2.1', attempt: 'attempt-1', anchor_applied: false, at: 1790979200000, cognition_revision: 3, binding_revision: 'binding-7f93a2' },
    },
  },
  fsFiles: { [SOURCE]: { content: '---\nname: lead\nmain: true\n---\n\nHelp the user complete the task.' } },
};
