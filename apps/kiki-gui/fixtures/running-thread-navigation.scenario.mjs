import { sessionRecord } from './helpers.mjs';

const sessions = [
  sessionRecord('idle-pinned', { title: 'Pinned reference', metadata: { cwd: 'C:/fixture', 'kiki.pinned': true }, updated_at: '2026-10-06T12:00:00Z' }),
  sessionRecord('running-b', { title: 'Running B', busy: true, created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-06T10:00:00Z' }),
  sessionRecord('running-c', { title: 'Running C', busy: true, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-06T11:00:00Z' }),
  sessionRecord('running-a', { title: 'Running A', busy: true, created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-06T09:00:00Z' }),
];
export default {
  sessions,
  snapshots: Object.fromEntries(sessions.map((session) => [session.id, { messages: [], has_more: false }])),
  shortcutPreferences: { version: 1, overrides: { windows: {
    'next-session': [{ key: 'F6', modifier: 'ctrl' }],
    'previous-session': [{ key: 'F6', modifier: 'ctrl', shift: true }],
  }, linux: {
    'next-session': [{ key: 'F6', modifier: 'ctrl' }],
    'previous-session': [{ key: 'F6', modifier: 'ctrl', shift: true }],
  } } },
};
