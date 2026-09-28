/** Throwaway scenario: /new's continuation band with one row per life state. */
import { sessionRecord } from './helpers.mjs';

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export default {
  config: { default_model: 'fixture/model-a', default_permission_mode: 'auto', providers: {} },
  models: [
    { model: 'fixture/model-a', provider: 'fixture', max_context_size: 131072, support_efforts: ['low', 'high'], default_effort: 'high' },
  ],
  agentProfiles: [
    { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] },
    { name: 'workspace-main', source: 'workspace', main: true, disabled: false, routes: [] },
    { name: 'reviewer', source: 'workspace', main: false, disabled: false, routes: [] },
    { name: 'research', source: 'workspace', main: false, disabled: false, routes: [] },
  ],
  workspaces: [
    { id: 'wd_fixture_shop_00000000000a', name: 'workshop', root: 'C:/fixture/workshop', pinned: true, last_opened_at: iso(2), session_count: 4 },
  ],
  sessions: [
    sessionRecord('sess_waiting', { title: '等你批准这次写入', workspace_id: 'wd_fixture_shop_00000000000a',
      busy: true, pending_interaction: 'approval', updated_at: iso(1), metadata: { cwd: 'C:/fixture/workshop' } }),
    sessionRecord('sess_working', { title: 'Refactoring the transcript scroller', workspace_id: 'wd_fixture_shop_00000000000a',
      busy: true, pending_interaction: 'none', updated_at: iso(3), metadata: { cwd: 'C:/fixture/workshop' } }),
    sessionRecord('sess_done', { title: 'Shipped the usage dashboard', workspace_id: 'wd_fixture_shop_00000000000a',
      busy: false, last_turn_reason: 'completed', updated_at: iso(6), metadata: { cwd: 'C:/fixture/workshop' } }),
    sessionRecord('sess_idle', { title: 'A deliberately long session title that has to truncate somewhere sensible instead of wrapping onto a second line',
      workspace_id: 'wd_fixture_shop_00000000000a', busy: false, updated_at: iso(900), metadata: { cwd: 'C:/fixture/workshop' } }),
  ],
};
