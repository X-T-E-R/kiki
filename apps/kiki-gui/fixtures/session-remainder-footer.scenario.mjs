/**
 * session-remainder-footer — a session whose window carried only part of its own
 * structures, so the composer's footer has something to offer: the snapshot
 * fields the header shows (a cut title) and the agent roster the list is built
 * from. Both are bounded in the real wire shape, through the same
 * `ContentRef` contract the reading column reads.
 *
 * The point is the *placement*: the entry belongs on the composer's own footer
 * row, beside the working sentence, not buried after the last transcript row.
 * A second session in the same fixture has nothing outstanding, so the entry
 * disappears there rather than claiming the transcript is complete.
 */

import base from './settings.scenario.mjs';
import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_remainder';
const BUSY_SID = 'session_fixture_remainder_busy';
const COMPLETE_SID = 'session_fixture_remainder_complete';

const SNAPSHOT = { kind: 'snapshot', id: '' };

export default {
  ...base,
  sessions: [
    ...base.sessions,
    sessionRecord(SID, { title: 'Fixture: session remainder' }),
    // Mid-turn: `busy` plus the in-flight turn is what makes the composer show
    // its working sentence and its Stop, which is the row the entry shares.
    sessionRecord(BUSY_SID, { title: 'Fixture: remainder while working', busy: true, main_turn_active: true }),
    sessionRecord(COMPLETE_SID, { title: 'Fixture: fully carried' }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      // A cut title and a roster array, both mid-read: the two structures the
      // outlet splits into its own rows.
      contentRefs: [
        { source: SNAPSHOT, revision: 'rev-1', path: ['session', 'title'], kind: 'text', offset: 24, total: 320 },
        { source: { kind: 'roster', id: 'child-1' }, revision: 'rev-1', path: ['label'], kind: 'text', offset: 8, total: 64 },
      ],
    },
    // Same outstanding structures, on a session that is mid-turn — the row the
    // entry has to share with the working sentence. The exchange is here
    // because a mid-turn projection needs a turn to project: with an empty
    // history there is nothing running and the composer correctly reads idle.
    [BUSY_SID]: {
      messages: [
        {
          id: 'msg_busy_user',
          session_id: BUSY_SID,
          role: 'user',
          content: [{ type: 'text', text: 'Compile the fixture bundle.' }],
          created_at: new Date(Date.now() - 180_000).toISOString(),
        },
        {
          id: 'msg_busy_assistant',
          session_id: BUSY_SID,
          role: 'assistant',
          content: [{ type: 'text', text: 'Working through it.' }],
          created_at: new Date(Date.now() - 120_000).toISOString(),
        },
      ],
      has_more: false,
      contentRefs: [
        { source: SNAPSHOT, revision: 'rev-1', path: ['session', 'title'], kind: 'text', offset: 24, total: 320 },
      ],
      in_flight_turn: {
        turn_id: 1,
        assistant_text: 'Compiling the fixture bundle…',
        thinking_text: '',
        running_tools: [],
      },
      tasks: [
        // A running background task: the footer used to state how many, and
        // that sentence is what this batch removes.
        {
          id: 'task_fixture_bg',
          session_id: BUSY_SID,
          kind: 'bash',
          description: 'background fixture check',
          status: 'running',
          command: 'pnpm test --watch',
          created_at: new Date(Date.now() - 120_000).toISOString(),
          started_at: new Date(Date.now() - 120_000).toISOString(),
          output_preview: 'running…',
          output_bytes: 128,
        },
      ],
    },
    [COMPLETE_SID]: {
      messages: [],
      has_more: false,
      // Nothing outstanding: the entry must not appear for this one.
    },
  },
  // A turn that stays open, so the composer's working row can be observed
  // without racing a turn that ends in the same tick. Waits on the release
  // control rather than a timer, so the scene decides when it ends.
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    { waitFor: 'release' },
  ],
};