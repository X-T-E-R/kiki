/**
 * plugin-import — the managed import surface at `/capabilities?view=import`.
 *
 * One package, six sources: `kiki-history` carries the built-in formats
 * (Claude Code, Codex, Pi, Grok, OpenCode) plus the custom-script slot, so the
 * view proves the source list is contract data rather than a format enum
 * written in the GUI. The scenario seeds:
 *
 *   - two homes (Claude Code and Codex) with a discovery list longer than one
 *     page, so the cursor paging is exercised;
 *   - a live job already mid-read, so a reader meets real progress before
 *     starting anything, plus a stopped, an interrupted and a failed one;
 *   - two archives with pages, so "open archive" reads something;
 *   - the package's settings form with its one field, `customScript`, empty —
 *     an empty value means the bundled example script;
 *   - `plugin_import` on in the flag snapshot, as the server with the routes
 *     registered reports it.
 *
 * Shapes mirror packages/protocol/src/rest/plugin-import.ts; values are mock
 * data. `preview`'s Claude probe returns a cursor, so the page draws `sample`
 * rather than a whole import.
 */

import plugins from './capabilities.scenario.mjs';
import {
  commitAssistant,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const HISTORY_PLUGIN = 'kiki-history';
const CLAUDE_HOME = 'C:/Users/fixture/.claude';
const CODEX_HOME = 'C:/Users/fixture/.codex';

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const at = (minutes) => Date.now() - minutes * 60_000;

const rec = (id, part, role, text, extra = {}) => ({ id, part, role, text, ...extra });

const MIGRATION = '0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3';
const RAIL_TESTS = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';
const CHECKLIST = '7a1b9c3d-2e4f-4a6b-8c0d-1e2f3a4b5c6d';
const PARSER = 'd1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f7';

/** What a continued migrated session answers: a fact only the imported turns carry. */
/** Past every turn the imported history seeded, so a new turn never collides. */
const IMPORTED_TURN_ID = 9001;

const IMPORTED_REPLY = 'From the history you imported: the batch was raised to 20,000 and peak memory stayed under 1.2 GB, with the backfill at 64% at that point.';

/** One stored page: what a bounded parse returns, with the losses it counted. */
const page = (records, { cursor, bytesRead, losses = [] }) => ({ records, cursor, losses, bytesRead });

/** A job record, shaped exactly as the service persists it. */
const job = (id, externalId, patch) => ({
  schemaVersion: 1,
  id,
  previewId: `preview-${id}`,
  selection: {
    pluginId: HISTORY_PLUGIN,
    sourceId: 'claude-code',
    home: CLAUDE_HOME,
    externalId,
  },
  sourceHome: CLAUDE_HOME,
  targetHome: 'main',
  revision: 'a3f1c0d9e2b4876519ac2de3f4051627384956a6b7c8d9e0f1a2b3c4d5e6f708',
  title: 'Migrate the search index to the new analyzer',
  formatVersion: 'claude-code.history.v1',
  status: 'running',
  createdAt: at(12),
  updatedAt: at(1),
  records: 0,
  pages: 0,
  bytesRead: 0,
  totalBytes: 812_400,
  cursor: null,
  parsed: false,
  losses: [],
  archiveId: null,
  error: null,
  ...patch,
});

/** An archive, plus the pages its job stored. */
const archiveOf = (id, patch) => ({
  schemaVersion: 1,
  id,
  pluginId: HISTORY_PLUGIN,
  sourceId: 'claude-code',
  sourceHome: CLAUDE_HOME,
  externalId: CHECKLIST,
  targetHome: 'main',
  title: 'Draft the release checklist',
  revision: 'bb12cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899aabb',
  formatVersion: 'claude-code.history.v1',
  createdAt: at(1_440),
  updatedAt: at(1_430),
  status: 'preserved',
  losses: [],
  records: 12,
  pages: 2,
  jobId: 'job-checklist-done',
  previousJobIds: [],
  ...patch,
});

// A done job, so its archive's pages are readable.
const CHECKLIST_JOB = job('job-checklist-done', CHECKLIST, {
  status: 'completed',
  records: 12,
  pages: 2,
  bytesRead: 41_800,
  parsed: true,
  archiveId: 'archive-checklist-done',
  createdAt: at(1_441),
  updatedAt: at(1_430),
});

const CHECKLIST_ARCHIVE = archiveOf('archive-checklist-done', { jobId: 'job-checklist-done' });

// A finished *native* import: the same conversation already committed as a Kiki
// session, so the page has a real session to continue and the reuse receipt has
// something to name. It writes no archive — that difference is the one the row
// has to show, not the one a caption claims.
const NATIVE_WORK_DIR = 'C:/Users/fixture/code/imported-project';
const NATIVE_SESSION = '019f2c8a-7b31-4c6d-9a52-0e6b1d4f8a20';
const NATIVE_REVISION = 'e1e2f3a4b5c6d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6';
const NATIVE_JOB = job('job-native-done', CHECKLIST, {
  status: 'completed',
  records: 12,
  pages: 2,
  bytesRead: 41_800,
  parsed: true,
  title: 'Draft the release checklist',
  revision: NATIVE_REVISION,
  archiveId: null,
  destination: { kind: 'native-session', workDir: NATIVE_WORK_DIR },
  sessionId: NATIVE_SESSION,
  sessionPath: `${NATIVE_WORK_DIR}/.kiki/sessions/${NATIVE_SESSION}`,
  losses: [
    { code: 'sidechain_filtered', count: 2, detail: 'Sidechain (sub-agent) turns are not carried over.' },
    { code: 'native_text_history', count: 1, detail: 'User/assistant text becomes native context; tools become completed historical text, never executable calls' },
  ],
  createdAt: at(90),
  updatedAt: at(88),
});

// A live job mid-read: real bytes read against a real total, so the progress
// bar has a ratio the page did not invent.
const LIVE_JOB = job('job-migration-live', MIGRATION, {
  records: 21,
  pages: 2,
  bytesRead: 268_000,
  cursor: 'page-2',
  losses: [{ code: 'sidechain_filtered', count: 4, detail: 'Sidechain (sub-agent) turns are not carried over.' }],
});

// A job the reader stopped, and one the host interrupted on restart.
const STOPPED_JOB = job('job-incident-stopped', 'c3d4e5f6-a7b8-4c9d-8e0f-a1b2c3d4e5f6', {
  title: 'Summarise yesterday’s incident thread',
  status: 'cancelled',
  records: 9,
  pages: 1,
  bytesRead: 88_000,
  losses: [],
  createdAt: at(180),
  updatedAt: at(174),
});

const INTERRUPTED_JOB = job('job-parser-interrupted', PARSER, {
  title: 'Try a streaming parser',
  status: 'interrupted',
  records: 14,
  pages: 2,
  bytesRead: 132_000,
  error: 'Host restarted; resume explicitly',
  createdAt: at(90),
  updatedAt: at(84),
});

// A job that failed, with the server's own sentence rather than a UI invention.
const FAILED_JOB = job('job-attachments-failed', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', {
  title: 'Recover the missing screenshots',
  status: 'failed',
  records: 4,
  pages: 1,
  bytesRead: 19_400,
  error: 'Source changed; preview again before importing',
  createdAt: at(45),
  updatedAt: at(44),
});

const pluginImport = {
  // Which of these the host serves itself, and so offers without an install.
  // A source outside this list is a third-party plugin's and still has to be
  // installed, healthy and enabled to appear.
  hostShipped: { [HISTORY_PLUGIN]: true },
  sources: [
    { pluginId: HISTORY_PLUGIN, id: 'claude-code', label: 'Claude Code', formatVersion: 'claude-code.history.v1' },
    { pluginId: HISTORY_PLUGIN, id: 'codex', label: 'Codex', formatVersion: 'codex.rollout.v1' },
    { pluginId: HISTORY_PLUGIN, id: 'pi', label: 'Pi', formatVersion: 'pi-jsonl-v3' },
    { pluginId: HISTORY_PLUGIN, id: 'grok', label: 'Grok', formatVersion: 'grok-acp-v1' },
    { pluginId: HISTORY_PLUGIN, id: 'opencode', label: 'OpenCode', formatVersion: 'opencode-export-v1' },
    { pluginId: HISTORY_PLUGIN, id: 'custom', label: 'Custom script', formatVersion: 'custom-records-v1' },
  ],
  homes: {
    [`${HISTORY_PLUGIN}:claude-code:${CLAUDE_HOME}`]: {
      probe: {
        revision: LIVE_JOB.revision,
        title: 'Migrate the search index to the new analyzer',
        formatVersion: 'claude-code.history.v1',
        status: 'partial',
        losses: [
          { code: 'sidechain_filtered', count: 4, detail: 'Sidechain (sub-agent) turns are not carried over.' },
          { code: 'image_placeholder', count: 7, detail: 'Images are recorded as placeholders; the files are not copied.' },
        ],
        totalBytes: 812_400,
        sourceHome: CLAUDE_HOME,
      },
      entries: [
        { externalId: MIGRATION, title: 'Migrate the search index to the new analyzer' },
        { externalId: CHECKLIST, title: 'Draft the release checklist' },
        { externalId: PARSER, title: '' },
        { externalId: 'c3d4e5f6-a7b8-4c9d-8e0f-a1b2c3d4e5f6', title: 'Summarise yesterday’s incident thread for the postmortem' },
        { externalId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', title: 'Profile the search index rebuild' },
      ],
      // The first page returns a cursor, so `preview` reports `sample`.
      pages: [
        page([
          rec('m1', 0, 'user', 'Move the search index to the new analyzer. Keep the old index readable until the backfill finishes.'),
          rec('m2', 1, 'assistant', 'I will add the new analyzer behind a read alias, backfill in batches, and switch the alias only after the counts match.'),
          rec('m3', 1, 'tool_call', '', { toolName: 'Bash', toolCallId: 'call_01' }),
        ], { cursor: 'page-2', bytesRead: 26_000, losses: [{ code: 'sidechain_filtered', count: 4, detail: 'Sidechain (sub-agent) turns are not carried over.' }] }),
        page([
          rec('m4', 2, 'user', 'Batches of 5,000 are too slow on the staging box. Try 20,000 and watch memory.'),
          rec('m5', 3, 'assistant', 'Raised the batch to 20,000. Peak memory stayed under 1.2 GB; the backfill is at 64%.'),
        ], { cursor: 'page-3', bytesRead: 242_000, losses: [{ code: 'image_placeholder', count: 7, detail: 'Images are recorded as placeholders; the files are not copied.' }] }),
        page([
          rec('m6', 4, 'user', 'Finish the backfill and write the rollback step.'),
          rec('m7', 5, 'assistant', 'Backfill finished at 03:12. The rollback step drops the alias and re-points at the old index.'),
        ], { cursor: null, bytesRead: 812_400 }),
      ],
    },
    [`${HISTORY_PLUGIN}:codex:${CODEX_HOME}`]: {
      probe: {
        revision: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
        title: 'Fix the flaky rail tests',
        formatVersion: 'codex.rollout.v1',
        status: 'preserved',
        losses: [],
        totalBytes: 24_100,
        sourceHome: CODEX_HOME,
      },
      entries: [
        { externalId: RAIL_TESTS, title: 'Fix the flaky rail tests' },
        { externalId: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5c', title: 'Why does the importer drop empty rows?' },
      ],
      // A single page with no cursor: this source reads completely.
      pages: [
        page([
          rec('c1', 0, 'user', 'Fix the flaky rail tests.'),
          rec('c2', 1, 'assistant', 'Both flakes waited on a timer; they now await the settle helper.'),
        ], { cursor: null, bytesRead: 24_100 }),
      ],
    },
  },
  jobs: [LIVE_JOB, CHECKLIST_JOB, NATIVE_JOB, STOPPED_JOB, INTERRUPTED_JOB, FAILED_JOB],
  archives: [CHECKLIST_ARCHIVE],
  pages: [
    // Two pages, so the archive reader's "load more" is real.
    {
      records: [
        rec('k1', 0, 'user', 'Draft the release checklist for the parser migration.'),
        rec('k2', 1, 'assistant', 'Here is the order I would ship in: parser behind a flag, then the index, then the two removal commits.'),
      ],
    },
    {
      records: [
        rec('k3', 2, 'user', 'Add the rollback step.'),
        rec('k4', 3, 'assistant', 'Added. Rollback is one command and drops the alias back to the old reader.'),
        rec('k5', 3, 'system', 'You are Claude Code, a helpful assistant.'),
      ],
    },
  ],
};

// A real 812 KB history is not three pages. The tail below is generated so a
// running job lasts long enough to be read at its real pace, instead of
// finishing between two polls and never being seen running at all.
const CLAUDE_PAGES = pluginImport.homes[`${HISTORY_PLUGIN}:claude-code:${CLAUDE_HOME}`].pages;
const MID = 'Migrate the search index to the new analyzer';
for (let index = 3; index < 14; index += 1) {
  CLAUDE_PAGES.splice(index, 0, page([
    rec(`m${index}0`, index * 2, 'user', `${MID} — step ${index - 2}: re-check the counts before switching the alias.`),
    rec(`m${index}1`, index * 2 + 1, 'assistant', `Counts match after batch ${index * 2}; the old reader still resolves.`),
  ], { cursor: `page-${index + 2}`, bytesRead: 26_000 * (index + 1) }));
}

// The stored pages belong to the archived job, keyed as the service keys them.
pluginImport.storedByJob = {
  'job-checklist-done': pluginImport.pages,
  'job-migration-live': CLAUDE_PAGES,
  // The seeded native job read the same conversation, so its session is
  // seeded with the same turns. Opening it shows the history it imported,
  // which is what a reader would check before sending anything into it.
  'job-native-done': pluginImport.pages,
};

export default {
  ...plugins,
  // A committed native import is a session, so a message sent into it is
  // answered from the history it imported. The reply quotes a decision that
  // only exists in the imported turns, which is what proves the continuation
  // carried that context rather than starting an empty conversation.
  onPrompt: [
    // A turn id well past the imported history's: an imported session already
    // holds turns, and reusing their id would address an existing turn instead
    // of opening the one this message starts.
    turnStart(IMPORTED_TURN_ID),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: IMPORTED_TURN_ID, step: 1 } } },
    { delay: 200 },
    ...streamSteps('assistant.delta', IMPORTED_TURN_ID, IMPORTED_REPLY, { per: 30 }),
    { delay: 250 },
    commitAssistant('$SID', IMPORTED_REPLY),
    turnEnd(IMPORTED_TURN_ID),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
  experimentalFlags: { ...(plugins.experimentalFlags ?? {}), plugin_import: true },
  // `kiki-history` is deliberately absent from the installed list: the host
  // serves its six formats from its own descriptor, so there is no plugin to
  // install, trust, enable or remove. Listing it here would be the one thing
  // that makes the walk prove the wrong thing — that importing depends on an
  // install the reader never made.
  plugins: [...plugins.plugins],
  // The package's one setting: the custom script the `custom` source runs.
  // Empty means the bundled example, so the seeded form opens blank.
  pluginSettings: {
    [HISTORY_PLUGIN]: {
      schema: {
        schema: {
          properties: {
            customScript: {
              type: 'string',
              title: 'Custom script',
              description: 'Absolute path of a trusted JS module exporting discover/probe/parse. Empty uses the bundled example.',
            },
          },
        },
      },
      values: {},
      secretsConfigured: [],
    },
  },
  pluginImport,
};
