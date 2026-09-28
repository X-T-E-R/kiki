/**
 * workspace-tools — two registered workspaces with a populated task board and
 * a scheduled-task list spread across both, so the /board and /cron pages can
 * be proven in both scopes (all workspaces vs one) with real rows: active and
 * paused plans, a stale one-shot, a plan without an owning session, and board
 * cards in every column.
 *
 * No prompt script: the point is the routed tool pages, not a turn.
 */

import { sessionRecord, ts } from './helpers.mjs';

const WS_APP = 'wd_fixture_000000000000';
const WS_DOCS = 'wd_docs_site_000000000000';

const SESSION = {
  release: 'session_fixture_tools_release',
  audit: 'session_fixture_tools_audit',
  docs: 'session_fixture_tools_docs',
};

const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60_000).toISOString();

function cron(fields) {
  return {
    recurring: true,
    paused: false,
    age_days: 3,
    stale: false,
    created_at: ts(3 * 24 * 60),
    last_fired_at: null,
    ...fields,
  };
}

const cronTasks = [
  cron({
    id: 'cron_tools_standup',
    session_id: SESSION.release,
    workspace_id: WS_APP,
    cron: '0 9 * * 1-5',
    human_schedule: 'Every weekday at 09:00',
    prompt_preview: 'Summarize the commits merged since yesterday and flag anything that touched the release branch.',
    next_fire_at: at(47),
    last_fired_at: ts(23 * 60),
  }),
  cron({
    id: 'cron_tools_linkcheck',
    session_id: SESSION.docs,
    workspace_id: WS_DOCS,
    cron: '*/30 * * * *',
    human_schedule: 'Every 30 minutes',
    prompt_preview: 'Crawl the docs preview build and report the first broken internal link.',
    next_fire_at: at(12),
    last_fired_at: ts(18),
  }),
  cron({
    id: 'cron_tools_release_notes',
    session_id: SESSION.release,
    workspace_id: WS_APP,
    cron: '30 18 28 9 *',
    human_schedule: 'Once, today at 18:30',
    prompt_preview: 'Regenerate the release notes from the changelog and attach the PDF to the release session.',
    next_fire_at: at(6 * 60 + 5),
    recurring: false,
    age_days: 0,
    created_at: ts(90),
  }),
  cron({
    id: 'cron_tools_dependency_audit',
    session_id: null,
    workspace_id: WS_APP,
    cron: '0 3 * * 0',
    human_schedule: 'Every Sunday at 03:00',
    prompt_preview: 'Audit dependency updates and open a board card for every major version bump.',
    next_fire_at: null,
    paused: true,
    age_days: 21,
    last_fired_at: ts(8 * 24 * 60),
  }),
  cron({
    id: 'cron_tools_translation_sync',
    session_id: SESSION.docs,
    workspace_id: WS_DOCS,
    cron: '0 12 * * *',
    human_schedule: 'Every day at 12:00',
    prompt_preview: 'Sync the zh translation of every page changed on main and list the untranslated headings.',
    next_fire_at: null,
    paused: true,
    stale: true,
    age_days: 34,
    last_fired_at: ts(29 * 24 * 60),
  }),
];

function card({ id, workspaceId, title, priority, status, minutesAgo, sessionIds = [], completed = false }) {
  const updatedAt = ts(minutesAgo);
  return {
    id,
    workspaceId,
    storage: { root: workspaceId === WS_APP ? 'C:/fixture' : 'C:/fixture-docs', storageId: `board_${workspaceId}`, kind: 'workspace' },
    title,
    priority,
    status,
    revision: 2,
    createdAt: ts(minutesAgo + 300),
    updatedAt,
    completedAt: completed ? updatedAt : null,
    archived: false,
    category: '',
    sessionIds,
    executionIds: [],
  };
}

const cards = [
  card({ id: 'board_tools_release', workspaceId: WS_APP, title: 'Cut the 0.4 release branch', priority: 'P1', status: 'active', minutesAgo: 6, sessionIds: [SESSION.release] }),
  card({ id: 'board_tools_flaky', workspaceId: WS_APP, title: 'Quarantine the flaky upload test', priority: 'P0', status: 'in_progress', minutesAgo: 3, sessionIds: [SESSION.audit] }),
  card({ id: 'board_tools_contrast', workspaceId: WS_APP, title: 'Fix the contrast findings from the audit', priority: 'P2', status: 'in_progress', minutesAgo: 40, sessionIds: [SESSION.audit] }),
  card({ id: 'board_tools_migrate', workspaceId: WS_APP, title: 'Migrate settings storage to v3', priority: 'P2', status: 'paused', minutesAgo: 60 * 26 }),
  card({ id: 'board_tools_readme', workspaceId: WS_APP, title: 'Refresh the README screenshots', priority: 'P3', status: 'done', minutesAgo: 60 * 5, completed: true }),
  card({ id: 'board_tools_docs_nav', workspaceId: WS_DOCS, title: 'Restructure the docs sidebar', priority: 'P1', status: 'active', minutesAgo: 25, sessionIds: [SESSION.docs] }),
  card({ id: 'board_tools_docs_links', workspaceId: WS_DOCS, title: 'Repair broken links in the API reference', priority: 'P2', status: 'in_progress', minutesAgo: 14, sessionIds: [SESSION.docs] }),
  card({ id: 'board_tools_docs_search', workspaceId: WS_DOCS, title: 'Evaluate local search for the docs site', priority: 'P3', status: 'done', minutesAgo: 60 * 30, completed: true }),
];

export default {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture', name: 'fixture', created_at: ts(60 * 24 * 40), last_opened_at: ts(3), session_count: 2, pinned: false },
    { id: WS_DOCS, root: 'C:/fixture-docs', name: 'docs-site', created_at: ts(60 * 24 * 20), last_opened_at: ts(14), session_count: 1, pinned: false },
  ],
  sessions: [
    sessionRecord(SESSION.release, { title: 'Release 0.4 prep', updated_at: ts(6) }),
    sessionRecord(SESSION.audit, { title: 'Accessibility audit', updated_at: ts(3) }),
    sessionRecord(SESSION.docs, {
      title: 'Docs navigation rework',
      workspace_id: WS_DOCS,
      metadata: { cwd: 'C:/fixture-docs' },
      updated_at: ts(14),
    }),
  ],
  snapshots: {},
  cronTasks,
  taskBoard: {
    storage: { root: 'C:/fixture', storageId: `board_${WS_APP}`, kind: 'workspace' },
    cards,
    detail: {
      board_tools_flaky: {
        description: [
          'The upload integration test fails about one run in five on CI, always on the Windows runner.',
          '',
          '## Scope',
          '',
          '- Move `upload.spec.ts` into the **quarantine** suite so it stops blocking merges',
          '- Keep it running nightly and report the failure rate',
          '- Open a follow-up card once the root cause is known',
          '',
          '> Unquarantine only after 20 consecutive green nightly runs.',
        ].join('\n'),
        prd: '',
      },
    },
  },
};
