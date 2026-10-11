import { sessionRecord } from './helpers.mjs';

const sessions = [
  sessionRecord('conversation-a', { title: 'Conversation A', last_seq: 10, last_turn_reason: 'completed' }),
  sessionRecord('conversation-b', { title: 'Conversation B', last_seq: 10, busy: true, main_turn_active: false, last_turn_reason: 'completed' }),
];

export default {
  sessions,
  snapshots: Object.fromEntries(sessions.map((session) => [session.id, { messages: [], has_more: false }])),
};
