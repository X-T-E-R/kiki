import { sessionRecord } from './helpers.mjs';

const stamp = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const parent = 'session_activity_parent';
const child = 'session_activity_child';
const records = [
  sessionRecord('session_activity_pinned', { title: 'Pinned reference', metadata: { cwd: 'C:/fixture', 'kiki.pinned': true }, updated_at: stamp(8) }),
  sessionRecord('session_activity_other', { title: 'Three days ago', updated_at: stamp(3) }),
  sessionRecord(parent, { title: 'Parent conversation', updated_at: stamp(4) }),
  sessionRecord(child, { title: 'Attached conversation', metadata: { cwd: 'C:/fixture', parent_session_id: parent, child_session_kind: 'child' }, updated_at: stamp(4) }),
  sessionRecord('session_activity_older', { title: 'Five days ago', updated_at: stamp(5) }),
];
export default {
  config: { thread_communication: { enabled: true } },
  sessions: records,
  snapshots: Object.fromEntries(records.map((record) => [record.id, { messages: [], has_more: false }])),
};
