/**
 * busy-rail — a busy session whose snapshot carries a todo_list tool call
 * (drives the Todos rail) and two running background tasks (drives the
 * Background tasks rail, one with an output preview). No prompt script:
 * the point is the rail + sidebar busy dot, not a turn.
 */

import { assistantMsg, fid, sessionRecord, toolResultMsg, userMsg } from './helpers.mjs';

const SID = 'session_fixture_busy';
const TODO_CALL = fid('call');

const TODO_ITEMS = [
  { title: 'Map the protocol surface', status: 'completed' },
  { title: 'Build the fixture harness', status: 'completed' },
  { title: 'Prove every UI state visually', status: 'in_progress' },
  { title: 'Write the batch report', status: 'pending' },
  { title: 'Archive throwaway sessions', status: 'pending' },
];

const messages = [
  userMsg(SID, 'Track the batch work as todos, then run the two long jobs in the background.', 12),
  assistantMsg(SID, [
    { toolUse: { id: TODO_CALL, name: 'TodoWrite', input: { todos: TODO_ITEMS } } },
    'Both jobs are running in the background — I will report when they land.',
  ], 11),
  toolResultMsg(SID, TODO_CALL, { kind: 'todo_list', items: TODO_ITEMS }, 11),
];

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: busy rail',
      busy: true,
      main_turn_active: true,
    }),
  ],
  snapshots: {
    [SID]: {
      messages,
      in_flight_turn: {
        turn_id: 3,
        assistant_text: 'Compiling the fixture bundle…',
        thinking_text: '',
        running_tools: [],
      },
      tasks: [
        {
          id: fid('task'),
          session_id: SID,
          kind: 'bash',
          description: 'fixture build (vite)',
          status: 'running',
          command: 'pnpm build --watch',
          created_at: new Date(Date.now() - 9 * 60_000).toISOString(),
          started_at: new Date(Date.now() - 9 * 60_000).toISOString(),
          output_preview: 'vite v6.4.2 building for production…\ntransforming…',
          output_bytes: 2048,
        },
        {
          id: fid('task'),
          session_id: SID,
          kind: 'subagent',
          description: 'scour references for patterns',
          status: 'running',
          created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
          started_at: new Date(Date.now() - 4 * 60_000).toISOString(),
        },
      ],
    },
  },
};
