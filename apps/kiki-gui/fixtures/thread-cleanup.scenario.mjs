import { sessionRecord } from './helpers.mjs';

const cleanup = sessionRecord('session_cleanup_fixture', {
  title: 'Completed root · cleanup unconfirmed', busy: true, executing: false,
  cleanup_pending: true, main_turn_active: false, last_turn_reason: 'completed',
});
const running = sessionRecord('session_running_fixture', {
  title: 'Working thread', busy: true, executing: true, main_turn_active: true,
});
const idle = sessionRecord('session_idle_fixture', {
  title: 'Reference draft', busy: false, executing: false, main_turn_active: false,
});
export default {
  sessions: [idle, cleanup, running],
  snapshots: Object.fromEntries([idle, cleanup, running].map((session) => [session.id, { messages: [], has_more: false }])),
};
