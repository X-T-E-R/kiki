import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_resume_notifications';
const endedAt = '2026-10-01T12:00:00.000Z';
const turn = (ordinal) => ({
  kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' },
  prompt: `Check restored work batch ${ordinal}.`, startedAt: endedAt, endedAt,
  steps: [{ kind: 'step', stepId: `t${ordinal}.1`, turnId: `t${ordinal}`, ordinal: 1, state: 'completed',
    frames: [{ kind: 'text', frameId: `answer-${ordinal}`, role: 'assistant',
      text: `Batch ${ordinal} is saved. The result remains available after reconnect.\n\nNo new request is needed to inspect this restored receipt.` }] }],
});
const children = Array.from({ length: 24 }, (_, index) => ({
  id: `task-restored-child-${index}`, session_id: SID, kind: 'subagent', agent_id: `child-${index}`,
  label: `Worker ${index + 1}`, parent_agent_id: 'main', status: 'completed',
  description: `Restored batch ${index + 1}`, created_at: endedAt, started_at: endedAt, completed_at: endedAt,
}));
const tasks = [
  ...children.map((child) => ({ taskId: child.id, kind: 'subagent', agentId: child.agent_id,
    name: child.label, description: child.description, state: 'completed', detached: true,
    startedAt: endedAt, endedAt, outputTail: 'Saved fixture result.' })),
  ...Array.from({ length: 16 }, (_, index) => ({ taskId: `task-restored-process-${index}`, kind: 'shell',
    name: `Check ${index + 1}`, description: `Saved process ${index + 1}`, state: 'completed', detached: true,
    startedAt: endedAt, endedAt, outputTail: 'Fixture process completed.', exitCode: 0 })),
];

export default {
  sessions: [
    sessionRecord(SID, { title: 'Resume notifications', last_turn_reason: 'completed', message_count: 60, last_seq: 60 }),
    sessionRecord('session_fixture_resume_other', { title: 'Other completed work', last_turn_reason: 'completed', message_count: 2, last_seq: 2 }),
  ],
  snapshots: {
    [SID]: {
      messages: [], has_more: false, subagents: children,
      agent_transcripts: {
        main: { agent_id: 'main', has_more: false, items: Array.from({ length: 30 }, (_, i) => turn(i + 1)), tasks },
        ...Object.fromEntries(children.map((child) => [child.agent_id, {
          agent_id: child.agent_id, has_more: false, items: [turn(1)], tasks: [],
        }])),
      },
    },
    session_fixture_resume_other: { messages: [], has_more: false },
  },
};
