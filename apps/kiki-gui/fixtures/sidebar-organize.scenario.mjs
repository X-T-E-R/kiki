/**
 * sidebar-organize — workspace filtering + time grouping + pin on the sidebar.
 *
 * Two workspaces, three sessions: a pinned row floats into its own "Pinned"
 * group, the two "fixture" sessions belong to workspace A, and one session
 * belongs to workspace B so the view menu's workspace rows can prove
 * server-side `workspace_id` filtering in the UI.
 */

import { sessionRecord } from './helpers.mjs';

const WS_A = 'wd_fixture_000000000000';
const WS_B = 'wd_fixture_000000000001';

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

export default {
  sessions: [
    sessionRecord('session_fixture_ws_a1', {
      title: 'Fixture: ws-a alpha',
      workspace_id: WS_A,
      updated_at: iso(2),
    }),
    sessionRecord('session_fixture_ws_pinned', {
      title: 'Fixture: ws-a pinned',
      workspace_id: WS_A,
      updated_at: iso(5),
      metadata: { cwd: 'C:/fixture/workshop', 'kiki.pinned': true },
    }),
    sessionRecord('session_fixture_ws_b1', {
      title: 'Fixture: ws-b beta',
      workspace_id: WS_B,
      updated_at: iso(30),
    }),
  ],
  workspaces: [
    {
      id: WS_A,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: iso(120),
      last_opened_at: iso(2),
      session_count: 2,
      pinned: false,
    },
    {
      id: WS_B,
      root: 'C:/fixture/other',
      name: 'other',
      created_at: iso(120),
      last_opened_at: iso(60),
      session_count: 1,
      pinned: true,
    },
  ],
  snapshots: {},
};