/**
 * settings-workspaces — two registered workspaces for the Settings workspace
 * card's rename / unregister walker. The fixture server keeps `workspaces`
 * mutable across PATCH/DELETE, so the walker mutates these two rows.
 */

const WS_A = 'wd_fixture_000000000000';
const WS_B = 'wd_fixture_000000000001';
const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export default {
  sessions: [],
  snapshots: {},
  workspaces: [
    {
      id: WS_A,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: ts(120),
      last_opened_at: ts(2),
      session_count: 1,
    },
    {
      id: WS_B,
      root: 'C:/fixture/other',
      name: 'other',
      created_at: ts(120),
      last_opened_at: ts(60),
      session_count: 0,
    },
  ],
};