import threadLinks from './thread-links.scenario.mjs';

const QUEUED = 'session_fixture_tl_queued';
const UNTITLED = 'session_7c1d9e02-5a44-4b0e-9f7d-3e2a1b0c9d8e';

export default {
  ...threadLinks,
  sessions: threadLinks.sessions.map((record) => {
    if (record.id === QUEUED) {
      return { ...record, metadata: { ...record.metadata, 'kiki.pinned': true } };
    }
    if (record.id === UNTITLED) {
      return {
        ...record,
        workspace_id: 'wd_fixture_unregistered',
        metadata: { ...record.metadata, cwd: 'C:/fixture/orphan' },
      };
    }
    return record;
  }),
};
