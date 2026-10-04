/**
 * bridged-origin — a message that crossed a machine (`origin.kind` =
 * `bridged_peer`), so the transcript's source line has something to say:
 *
 *   Docs room  ← relayed over the network from the ACME home
 *   Front      ← relayed on this machine from the same source
 *
 * The two differ in `location` and in `sourceHomeId`, which is what the row
 * reads; neither is a peer persona, so nothing here may render as a handoff
 * between local threads.
 */

import { assistantMsg, originMsg, sessionRecord, ts } from './helpers.mjs';

const WS = 'wd_fixture_000000000000';
const SOURCE_HOME = '1a5b2f0e-6c1d-4a2f-9b3e-2f0c1d2e3f40';
const LOCAL_HOME = '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301';

const DOCS = 'session_fixture_bridge_docs';
const FRONT = 'session_fixture_bridge_front';

const networkOrigin = {
  kind: 'bridged_peer',
  source: { hostId: 'acme-box', workspaceId: WS, sessionId: 'session_acme_reviews' },
  sourceHomeId: SOURCE_HOME,
  targetHomeId: LOCAL_HOME,
  bridgeId: 'bridge-1',
  revision: 4,
  location: 'network',
  messageId: 'msg_bridge_net_1',
};

const localOrigin = { ...networkOrigin, location: 'local', sourceHomeId: LOCAL_HOME, messageId: 'msg_bridge_local_1' };

export default {
  experimentalFlags: {},
  workspaces: [{ id: WS, name: 'workshop', root: 'C:/fixture/workshop', pinned: false }],
  sessions: [
    sessionRecord(DOCS, { title: 'Docs room', updated_at: ts(30), last_seq: 2 }),
    sessionRecord(FRONT, { title: 'Frontend contract', updated_at: ts(20), last_seq: 2 }),
  ],
  snapshots: {
    [DOCS]: {
      messages: [
        { ...originMsg(DOCS, 'Release notes are ready for review on the other machine.', networkOrigin, 30), id: 'msg_bridge_net_1' },
        assistantMsg(DOCS, ['Relayed to the docs room; the source stays on the ACME home.'], 29),
      ],
    },
    [FRONT]: {
      messages: [
        { ...originMsg(FRONT, 'Moved the build to the shared runner.', localOrigin, 20), id: 'msg_bridge_local_1' },
        assistantMsg(FRONT, ['Noted — the runner is the same box.'], 19),
      ],
    },
  },
};
