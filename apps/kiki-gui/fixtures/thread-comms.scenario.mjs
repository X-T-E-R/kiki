/**
 * thread-comms — cross-thread messages (`GET /threads/messages`) for the
 * session rail's Thread messages chapter, the pair dialog and
 * Activity › Thread messages:
 *
 *   Frontend contract    ↔ Backend API (three rounds, one still pending)
 *                         ↔ Test sweep (one delivered each way)
 *                         ← Release notes (archived sender)
 *                         → Old spike (deleted; the message stays, no link)
 *   Backend API          → Docs (other workspace; undeliverable with reason)
 *
 * Two scan-budget empty pages precede the first rows, so every read proves
 * that an empty page with a cursor is not the end. The backend session holds
 * the delivered peer prompt (`user-msg_fx_c1`) the jump lands on.
 */

import { assistantMsg, originMsg, sessionRecord, ts } from './helpers.mjs';

const WS_APP = 'wd_fixture_000000000000';
const WS_DOCS = 'wd_docs_site_000000000000';
const HOST = 'host_fixture';

const FRONT = 'session_fixture_comms_front';
const BACK = 'session_fixture_comms_back';
const TESTS = 'session_fixture_comms_tests';
const NOTES = 'session_fixture_comms_notes';
const SPIKE = 'session_fixture_comms_spike';
const DOCS = 'session_fixture_comms_docs';

const ends = {
  [FRONT]: { ws: WS_APP, title: 'Frontend contract' },
  [BACK]: { ws: WS_APP, title: 'Backend API' },
  [TESTS]: { ws: WS_APP, title: 'Test sweep' },
  [NOTES]: { ws: WS_APP, title: 'Release notes', archived: true },
  [SPIKE]: { ws: WS_APP, deleted: true },
  [DOCS]: { ws: WS_DOCS, title: 'Docs site refresh' },
};

function endpoint(id) {
  const end = ends[id];
  return {
    ref: { host_id: HOST, workspace_id: end.ws, session_id: id },
    title: end.deleted ? undefined : end.title,
    deleted: end.deleted === true,
    archived: end.archived === true,
  };
}

const minutes = (value) => Date.now() - value * 60_000;
let seq = 0;
function message(id, from, to, minutesAgo, content, delivery = 'delivered', reason) {
  seq += 1;
  return {
    message_id: id,
    source: { kind: 'thread', thread: endpoint(from) },
    target: endpoint(to),
    content,
    accepted_at: minutes(minutesAgo),
    target_seq: seq,
    delivery,
    reason,
  };
}

const threadMessages = [
  message('msg_fx_c6', FRONT, BACK, 2, 'One more: can the list endpoint return next_cursor on an empty page? I need to know before I wire pagination.', 'pending'),
  message('msg_fx_d1', BACK, DOCS, 6, 'The pagination section needs the new cursor rule.', 'undeliverable', 'thread communication is disabled in workspace docs-site'),
  message('msg_fx_c5', BACK, FRONT, 9, 'Shipped. The shape is { items, next_cursor?, incomplete? } and the cursor is opaque — repeat the same filters when you continue.'),
  message('msg_fx_t2', TESTS, FRONT, 14, 'Sweep is green on the new fixtures. Two flaky retries in the rail tests, both timing.'),
  message('msg_fx_c1', FRONT, BACK, 18, 'Drafting the rail chapter. What does a message row carry, and how do I link to where it landed?\n\nI would rather not guess from target_seq.'),
  message('msg_fx_t1', FRONT, TESTS, 21, 'Please run the comms suite once the backend lands.'),
  message('msg_fx_n1', NOTES, FRONT, 55, 'Release notes need one line on thread messages; send me the final wording.'),
  message('msg_fx_s1', FRONT, SPIKE, 190, 'Closing the spike — the approach moved to the main branch.'),
].sort((a, b) => b.accepted_at - a.accepted_at);

const peerOrigin = (from, messageId) => ({
  kind: 'peer_thread', source: { hostId: HOST, workspaceId: WS_APP, sessionId: from }, messageId, acceptedAt: minutes(18),
});

export default {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(9_000), last_opened_at: ts(2), session_count: 4, pinned: true },
    { id: WS_DOCS, root: 'C:/fixture/docs-site', name: 'docs-site', created_at: ts(9_000), last_opened_at: ts(40), session_count: 1, pinned: false },
  ],
  sessions: [
    sessionRecord(FRONT, { title: 'Frontend contract', workspace_id: WS_APP, updated_at: ts(2), last_seq: 6 }),
    sessionRecord(BACK, { title: 'Backend API', workspace_id: WS_APP, updated_at: ts(6), last_seq: 8 }),
    sessionRecord(TESTS, { title: 'Test sweep', workspace_id: WS_APP, updated_at: ts(14), last_seq: 4 }),
    sessionRecord(DOCS, { title: 'Docs site refresh', workspace_id: WS_DOCS, metadata: { cwd: 'C:/fixture/docs-site' }, updated_at: ts(40), last_seq: 3 }),
  ],
  snapshots: {
    [FRONT]: {
      messages: [
        { ...originMsg(FRONT, 'Build the thread messages chapter for the session rail.', { kind: 'user' }, 25), id: 'msg_fx_front_u1' },
        assistantMsg(FRONT, ['I asked the backend thread for the row shape and will wire the chapter once it answers.'], 24),
      ],
    },
    [BACK]: {
      messages: [
        { ...originMsg(BACK, 'Message from thread Frontend contract:\n\nDrafting the rail chapter. What does a message row carry, and how do I link to where it landed?\n\nI would rather not guess from target_seq.', peerOrigin(FRONT, 'msg_fx_c1'), 18), id: 'msg_fx_c1' },
        assistantMsg(BACK, ['Each row carries message_id, both endpoints and delivery. Link by message_id in the target session.'], 17),
      ],
    },
  },
  threadMessages,
  threadMessagesEmptyPages: 2,
};
