/**
 * search — three sessions; two carry seeded global-search hits for the query
 * "persimmon" (grouped display + click-through), one has none. Hits use the
 * real wire shape (session_id + turn, no message id).
 */

import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID_A = 'session_fixture_search_a';
const SID_B = 'session_fixture_search_b';
const SID_C = 'session_fixture_search_c';

export default {
  sessions: [
    sessionRecord(SID_A, { title: 'Fixture: search alpha' }),
    sessionRecord(SID_B, { title: 'Fixture: search beta' }),
    sessionRecord(SID_C, { title: 'Fixture: search gamma' }),
  ],
  snapshots: {
    [SID_A]: {
      messages: [
        userMsg(SID_A, 'How do I rotate the persimmon cache without downtime?', 60),
        assistantMsg(SID_A, ['Rotate the persimmon cache by draining the queue first.'], 59),
      ],
      has_more: false,
    },
    [SID_B]: {
      messages: [
        userMsg(SID_B, 'Persimmon cache sizing for the workshop cluster?', 120),
        assistantMsg(SID_B, ['Keep the persimmon cache under half of the heap.'], 119),
      ],
      has_more: false,
    },
    [SID_C]: {
      messages: [
        userMsg(SID_C, 'Nothing about the query term lives here.', 200),
        assistantMsg(SID_C, ['Right — this session never mentions it.'], 199),
      ],
      has_more: false,
    },
  },
  searchHits: [
    {
      session_id: SID_A,
      workspace_id: 'wd_fixture_000000000000',
      session_title: 'Fixture: search alpha',
      agent_id: 'main',
      role: 'user',
      snippet: '…how do I rotate the persimmon cache without downtime…',
      time: Date.now() - 5 * 60_000,
      turn: 1,
      score: 0.92,
    },
    {
      session_id: SID_B,
      workspace_id: 'wd_fixture_000000000000',
      session_title: 'Fixture: search beta',
      agent_id: 'main',
      role: 'user',
      snippet: '…persimmon cache sizing for the workshop cluster…',
      time: Date.now() - 90 * 60_000,
      turn: 1,
      score: 0.85,
    },
    {
      session_id: SID_A,
      workspace_id: 'wd_fixture_000000000000',
      session_title: 'Fixture: search alpha',
      agent_id: 'main',
      role: 'assistant',
      snippet: '…rotate the persimmon cache by draining the queue first…',
      time: Date.now() - 4 * 60_000,
      turn: 1,
      score: 0.81,
    },
    {
      session_id: SID_B,
      workspace_id: 'wd_fixture_000000000000',
      session_title: 'Fixture: search beta',
      agent_id: 'main',
      role: 'assistant',
      snippet: '…keep the persimmon cache under half of the heap…',
      time: Date.now() - 89 * 60_000,
      turn: 1,
      score: 0.55,
    },
  ],
  // The first page returns 2 hits; a page_token advances to the remaining hits.
  searchPageSize: 2,
};
