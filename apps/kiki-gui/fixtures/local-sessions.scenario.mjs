/**
 * local-sessions — Claude Code and Codex history already on this machine,
 * for the /new "Continue a local session" entry, Settings › external engine
 * rows, and the dialog: a resumable session with a partial preview and
 * warnings, one already attached (continuing opens the same Kiki session), one
 * without a working folder (reason shown, still previewable), one whose
 * engine cannot resume, and a Codex list that the server truncated.
 *
 * Shapes mirror packages/protocol/src/rest/executor.ts; values are mock data.
 */

import engines from './external-engines.scenario.mjs';
import { sessionRecord, ts } from './helpers.mjs';

const CLAUDE_HOME = 'C:/Users/fixture/.claude';
const CODEX_HOME = 'C:/Users/fixture/.codex';
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const claude = (id, patch) => ({
  id: `external:claude:${id}`, engine: 'claude', external_id: id,
  source_path: `${CLAUDE_HOME}/projects/C--fixture-workshop/${id}.jsonl`, source_home: CLAUDE_HOME,
  resume: { supported: true }, cwd: 'C:/fixture/workshop', partial: false, ...patch,
});
const codex = (id, patch) => ({
  id: `external:codex:${id}`, engine: 'codex', external_id: id,
  source_path: `${CODEX_HOME}/sessions/2026/09/30/rollout-${id}.jsonl`, source_home: CODEX_HOME,
  resume: { supported: true }, cwd: 'C:/fixture/workshop', partial: false, ...patch,
});

const text = (value) => ({ kind: 'text', text: value });
const msg = (id, role, blocks, minutesAgo) => ({ id, role, timestamp: iso(minutesAgo), blocks });

const MIGRATION = claude('0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3', {
  title: 'Migrate the search index to the new analyzer', created_at: iso(300), updated_at: iso(42),
  last_prompt: 'Keep the old index readable until the backfill finishes.', partial: true,
});
const ATTACHED = claude('7a1b9c3d-2e4f-4a6b-8c0d-1e2f3a4b5c6d', {
  title: 'Draft the release checklist', created_at: iso(2_000), updated_at: iso(1_440),
  last_prompt: 'Add the rollback step.',
});
const NO_CWD = claude('c3d4e5f6-a7b8-4c9d-8e0f-a1b2c3d4e5f6', {
  last_prompt: 'Summarise yesterday’s incident thread for the postmortem.', cwd: undefined,
  created_at: iso(4_400), updated_at: iso(4_320), resume: { supported: false, reason: 'working_directory_missing' },
});
const BRANCHED = claude('d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f7', {
  title: 'Try a streaming parser', parent_id: '0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3',
  created_at: iso(6_000), updated_at: iso(5_900), cwd: 'C:/fixture/workshop/packages/parser',
});

const CODEX_ITEMS = [
  codex('019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', { title: 'Fix the flaky rail tests', updated_at: iso(18), created_at: iso(80) }),
  codex('019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5c', { last_prompt: 'Why does the importer drop empty rows?', updated_at: iso(200), created_at: iso(260) }),
];

const executors = engines.executors.map((item) => item.id === 'claude-acp'
  ? { ...item, connection: { ...item.connection, login_status: 'logged_in' } }
  : item);

export default {
  ...engines,
  executors,
  sessions: [...engines.sessions, sessionRecord('session_fixture_local_attached', { title: 'Draft the release checklist', updated_at: ts(1_440) })],
  localSessions: {
    'claude-acp': {
      root: `${CLAUDE_HOME}/projects`, exists: true, truncated: false, unreadable_files: 1, resume_enabled: true,
      items: [MIGRATION, ATTACHED, NO_CWD, BRANCHED],
      details: {
        [MIGRATION.id]: {
          warnings: ['transcript_sampled', 'content_truncated'],
          messages: [
            msg('m1', 'user', [text('Move the search index to the new analyzer. Keep the old index readable until the backfill finishes.')], 300),
            msg('m2', 'assistant', [text('I will add the new analyzer behind a read alias, backfill in batches of 5,000, and switch the alias only after the counts match.'), { kind: 'tool_call', name: 'Bash' }], 298),
            msg('m3', 'user', [text('Batches of 5,000 are too slow on the staging box. Try 20,000 and watch memory.')], 60),
            msg('m4', 'assistant', [text('Raised the batch to 20,000. Peak memory stayed under 1.2 GB; the backfill is at 64%.'), { kind: 'tool_call', name: 'Read' }], 42),
          ],
        },
        [NO_CWD.id]: {
          warnings: [],
          messages: [
            msg('n1', 'user', [text('Summarise yesterday’s incident thread for the postmortem.')], 4_330),
            msg('n2', 'assistant', [text('Three causes: a stale cache key, a retry storm from the importer, and a missing alert on queue depth.')], 4_320),
          ],
        },
      },
    },
    'codex-app-server': {
      root: `${CODEX_HOME}/sessions`, exists: true, truncated: true, unreadable_files: 0, resume_enabled: true,
      items: CODEX_ITEMS,
      details: {
        [CODEX_ITEMS[0].id]: { warnings: [], messages: [msg('c1', 'user', [text('Fix the flaky rail tests.')], 80), msg('c2', 'assistant', [text('Both flakes waited on a timer; they now await the settle helper.')], 18)] },
      },
    },
  },
  localAttachmentsSeed: { [ATTACHED.id]: 'session_fixture_local_attached' },
};
