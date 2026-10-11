// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { importKeys, type ImportArchive, type ImportJob } from '../../lib/importHistory';
import { ImportHistoryView } from './ImportHistoryView';

const sources = vi.fn();
const discover = vi.fn();
const preview = vi.fn();
const start = vi.fn();
const jobs = vi.fn();
const jobById = vi.fn();
const cancel = vi.fn();
const resume = vi.fn();
const archives = vi.fn();
const read = vi.fn();
const meta = vi.fn();
const listWorkspaces = vi.fn();
const listPlugins = vi.fn();
const getPluginSettings = vi.fn();
let remote = false;

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      meta,
      listWorkspaces,
      listPlugins,
      getPluginSettings,
      klient: { global: { imports: { sources, discover, preview, start, jobs, job: jobById, cancel, resume, archives, read } } },
    },
    scopeId: 'scope-1',
    meta: { server_id: 'fixture-server', server_home_id: '11111111-1111-4111-8111-111111111111' },
    sshLabel: null,
    connectionId: remote ? 'remote-1' : null,
  }),
}));

const HOME = 'C:/Users/ada/.claude';
const FILE = '0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3';
const WORK_DIR = 'C:/code/my-project';

/** Two workspaces this Kiki already knows, offered as chips rather than typed. */
const WORKSPACES = {
  items: [
    { id: 'ws-1', name: 'my-project', root: WORK_DIR, createdAt: 0, updatedAt: 0 },
    { id: 'ws-2', name: '', root: 'C:/code/other', createdAt: 0, updatedAt: 0 },
  ],
};

const SOURCES = [
  { schemaVersion: 1, id: 'claude-code', label: 'Claude Code', formatVersion: 'claude-code.history.v1', pluginId: 'claude-code-import' },
  { schemaVersion: 1, id: 'codex', label: 'Codex', formatVersion: 'codex.rollout.v1', pluginId: 'codex-import' },
];

/** A second plugin contributing a source with the *same* id. */
const AMBIGUOUS = [
  SOURCES[0]!,
  SOURCES[1]!,
  { schemaVersion: 1 as const, id: 'claude-code', label: 'Claude Code (mirror)', formatVersion: 'claude-code.history.v2', pluginId: 'mirror-import' },
];

const PREVIEW = {
  schemaVersion: 1,
  id: 'preview-1',
  selection: { pluginId: 'claude-code-import', sourceId: 'claude-code', home: HOME, externalId: FILE },
  targetHome: '11111111-1111-4111-8111-111111111111',
  probe: {
    revision: 'a3f1c0d9', title: 'Migrate the search index', formatVersion: 'claude-code.history.v1',
    status: 'partial' as const, losses: [], totalBytes: 1000, sourceHome: HOME,
  },
  records: [{ id: 'r1', part: 0, role: 'user' as const, text: 'Move the search index.' }],
  losses: [{ code: 'sidechain_filtered', count: 4, detail: 'Sidechain turns are not carried over.' }],
  coverage: 'sample' as const,
  existingArchiveId: null,
  existingRevision: null,
  createdAt: 0,
};

/** The same read, aimed at a Kiki session: the host names its reuse receipt. */
const SESSION_PREVIEW = {
  ...PREVIEW,
  id: 'preview-session',
  destination: { kind: 'native-session' as const, workDir: WORK_DIR },
  existingSessionId: 'session-existing',
  losses: [
    { code: 'sidechain_filtered', count: 4, detail: 'Sidechain turns are not carried over.' },
    { code: 'native_text_history', count: 1, detail: 'User/assistant text becomes native context; tools become completed historical text, never executable calls' },
  ],
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  remote = false;
  meta.mockReset().mockResolvedValue({ experimental_flags: { plugin_import: true } });
  sources.mockReset().mockResolvedValue(SOURCES);
  discover.mockReset().mockResolvedValue({ entries: [{ externalId: FILE, title: 'Migrate the search index' }], cursor: null });
  preview.mockReset().mockResolvedValue(PREVIEW);
  start.mockReset().mockResolvedValue({ id: 'job-1', status: 'queued' });
  jobs.mockReset().mockResolvedValue({ items: [], cursor: null });
  archives.mockReset().mockResolvedValue({ items: [], cursor: null });
  jobById.mockReset().mockRejectedValue(new Error('no such job'));
  read.mockReset().mockResolvedValue({ records: [], nextCursor: null });
  listWorkspaces.mockReset().mockResolvedValue(WORKSPACES);
  // A first-party importer is served by the host and is deliberately absent
  // from the installed list; the page must still be fully usable.
  listPlugins.mockReset().mockResolvedValue({ plugins: [] });
  getPluginSettings.mockReset().mockResolvedValue({ schema: {}, values: {} });
  cancel.mockReset(); resume.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(
  props: { initialSourceId?: string; initialSourcePluginId?: string; onOpenSession?: (sessionId: string) => void } = {},
): Promise<{ container: HTMLElement; queryClient: QueryClient }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><ImportHistoryView {...props} /></I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, queryClient };
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const setHome = async (container: HTMLElement) => {
  await typeInto(container.querySelector<HTMLInputElement>('[data-plugin-import-home]')!, HOME);
  await settle();
};
/** Aim the import at a working directory, the way choosing a workspace does. */
const setWorkDir = async (container: HTMLElement, value = WORK_DIR) => {
  await typeInto(container.querySelector<HTMLInputElement>('[data-plugin-import-workdir-input]')!, value);
  await settle();
};
/** Pick the destination segment by its own label, the way a reader does. */
const chooseDestination = async (container: HTMLElement, kind: 'native' | 'archive') => {
  await click(container.querySelector(`[data-plugin-import-destination] [data-segment="${kind}"]`)!);
  await settle();
};

/**
 * The archive path, chosen explicitly. The page now opens on a Kiki session, so
 * a test about the read-only archive has to say which aim it is exercising
 * rather than inherit whatever the default happened to be that day.
 */
async function renderArchiveFlow(
  props: { initialSourceId?: string; initialSourcePluginId?: string; onOpenSession?: (sessionId: string) => void } = {},
): Promise<{ container: HTMLElement; queryClient: QueryClient }> {
  const rendered = await render(props);
  await chooseDestination(rendered.container, 'archive');
  return rendered;
}

const job = (id: string, title: string, fields: Partial<ImportJob> = {}): ImportJob => ({
  id, schemaVersion: 1, previewId: 'p', selection: { pluginId: 'p', sourceId: 's', home: HOME, externalId: 'a' },
  sourceHome: HOME, targetHome: 'home-1', revision: 'r', title, formatVersion: 'v1', status: 'completed',
  createdAt: 0, updatedAt: 0, records: 1, pages: 1, bytesRead: 1, totalBytes: 1,
  cursor: null, parsed: true, losses: [], archiveId: null, error: null, ...fields,
});
const archive = (id: string, title: string): ImportArchive => ({
  schemaVersion: 1,
  id, pluginId: 'p', sourceId: 'claude-code', sourceHome: HOME, externalId: `${id}-file`,
  targetHome: 'main', title, revision: 'bb12cc33', formatVersion: 'v1', createdAt: 0, updatedAt: 0,
  status: 'preserved', losses: [], records: 3, pages: 1, jobId: `job-of-${id}`, previousJobIds: [],
});

/** A job that committed a Kiki session: no archive, but a session to open. */
const sessionJob = (id: string, title: string, fields: Partial<ImportJob> = {}): ImportJob => job(id, title, {
  destination: { kind: 'native-session', workDir: WORK_DIR },
  sessionId: `${id}-session`,
  sessionPath: `${WORK_DIR}/.kiki/sessions/${id}-session`,
  ...fields,
});

describe('ImportHistoryView', () => {
  it('reads its sources under the key for this connection, so a plugin detail shares the read', async () => {
    const { container, queryClient } = await render();
    expect(sources).toHaveBeenCalledTimes(1);
    // The import surface and a plugin's own detail page read the same server
    // fact, so they have to land in the same cache entry. A page-specific key
    // let the two disagree — one offering an importer the other does not show —
    // for as long as either entry stayed fresh.
    const shared = queryClient.getQueryData(importKeys.sources('scope-1'));
    expect(shared).toEqual(SOURCES);
    expect(queryClient.getQueryData(importKeys.sources('detail'))).toBeUndefined();
    // And the reader is not asked twice for one page: the list it drew is the
    // cached read above, not a second request.
    expect(container.querySelectorAll('[data-plugin-import-source]')).toHaveLength(2);
  });

  it('draws its sources from the contract, not from a format enum in the GUI', async () => {
    const { container } = await render();
        const tabs = [...container.querySelectorAll('[data-plugin-import-source]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Claude Code', 'Codex']);
    // Both are separate plugins, which is what the fixture proves.
    expect(sources).toHaveBeenCalledTimes(1);
  });

  it('works with no plugin installed at all, as a first-party importer is', async () => {
    // The host ships this importer: it is not in the installed list and has no
    // plugin page. Importing is still the whole job here, so nothing about the
    // flow may depend on an install the reader never made.
    listPlugins.mockResolvedValue({ plugins: [] });
    // The host answers with the aim it was asked for, as the service does.
    preview.mockImplementation(async (input: { destination?: unknown }) => ({ ...PREVIEW, destination: input.destination }));
    const { container } = await render();
    await setWorkDir(container);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    // The sources came from the host, the preview is on screen, and the job can
    // start — none of which waits on a plugin being installed.
    expect(container.querySelector('[data-plugin-import-preview]')).not.toBeNull();
    expect(preview).toHaveBeenCalledTimes(1);
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();
    expect(start).toHaveBeenCalledWith({ previewId: 'preview-1', acknowledge: true });
    // What is not offered is the link to a page that could not act anyway.
    expect(container.querySelector('[data-plugin-import-open-plugin]')).toBeNull();
  });

  it('offers the plugin page only for a plugin the reader actually installed', async () => {
    listPlugins.mockResolvedValue({ plugins: [{ id: 'claude-code-import', displayName: 'Claude Code history', version: '1.0.0', enabled: true, state: 'ok', source: 'local-path' }] });
    const { container } = await render();
    // A genuinely installed importer still has settings and an enable toggle a
    // reader might want, so the link stays.
    expect(container.querySelector('[data-plugin-import-open-plugin="claude-code-import"]')).not.toBeNull();
  });

  it('puts the custom script’s rule on this page, where its format is', async () => {
    // The custom source's settings live with its format rather than on a plugin
    // page: there is no installed plugin to reach one from.
    sources.mockResolvedValue([
      { schemaVersion: 1 as const, id: 'custom', label: 'Custom script', formatVersion: 'custom-records-v1', pluginId: 'kiki-history' },
    ]);
    const { container } = await render();
    expect(container.querySelector('[data-plugin-import-custom-settings]')).not.toBeNull();
    expect(getPluginSettings).toHaveBeenCalledWith('kiki-history');
  });

  it('never shows a target home the server has not named', async () => {
    const { container } = await render();
    const target = container.querySelector('[data-plugin-import-target]')!;
    // Nothing on the wire has named a target yet, so the block says so. The
    // home uuid from /meta is a different fact and must not stand in for the
    // server's own absolute home path.
    expect((target as HTMLElement).dataset['pluginImportTarget']).toBe('unknown');
    expect(target.textContent).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(target.textContent).not.toContain('main');
    expect(target.querySelector('input')).toBeNull();
  });

  it('opens the linked source, not the first one, when a deep link names the second', async () => {
    sources.mockResolvedValue(AMBIGUOUS);
    // A link into the second plugin's source. Before this was fixed the link
    // carried no plugin, so it fell through to whichever source sorted first.
    const { container } = await render({ initialSourceId: 'claude-code', initialSourcePluginId: 'mirror-import' });
    const tabs = [...container.querySelectorAll('[data-plugin-import-source]')] as HTMLElement[];
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain('mirror');
    // Two sources share an id, so identity cannot be the id alone.
    expect(new Set(tabs.map((tab) => tab.dataset['pluginImportSource'])).size).toBe(3);
  });

  it('still resolves a link that carries only a source id', async () => {
    sources.mockResolvedValue(SOURCES);
    const { container } = await render({ initialSourceId: 'codex' });
    const selected = [...container.querySelectorAll('[data-plugin-import-source]')]
      .filter((tab) => tab.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain('Codex');
  });

  it('names the target home the server reports once a preview exists', async () => {
    const { container } = await renderArchiveFlow()
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    const target = container.querySelector('[data-plugin-import-target]')!;
    // The absolute path the service's `bootstrap.homeDir` reports, verbatim.
    expect((target as HTMLElement).dataset['pluginImportTarget']).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('asks the server whether it can import rather than reading an experimental flag', async () => {
    meta.mockResolvedValue({ experimental_flags: {} });
    const { container } = await render();
    expect(sources).toHaveBeenCalled();
    expect(container.querySelector('[data-cap-import-disabled]')).toBeNull();
  });

  it('labels a bounded preview as a sample and shows the server’s own losses', async () => {
    const { container } = await renderArchiveFlow()
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    const panel = container.querySelector('[data-plugin-import-preview]')!;
    expect((panel as HTMLElement).dataset['pluginImportCoverage']).toBe('sample');
    expect((panel as HTMLElement).dataset['pluginImportProbe']).toBe('partial');
    const losses = [...container.querySelectorAll('[data-plugin-import-loss]')].map((node) => node.textContent);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toContain('4');
    expect(losses[0]).toContain('Sidechain turns are not carried over.');
  });

  it('drops a stale preview when the source home changes', async () => {
    const { container } = await renderArchiveFlow()
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    expect(container.querySelector('[data-plugin-import-preview]')).not.toBeNull();
    // A preview names the exact source it was probed from. Pointing at another
    // home invalidates it, so the action below it cannot commit the old read.
    await typeInto(container.querySelector<HTMLInputElement>('[data-plugin-import-home]')!, 'C:/Users/ada/.codex');
    await settle();
    expect(container.querySelector('[data-plugin-import-preview]')).toBeNull();
  });

  it('keeps a start from reaching for a preview the server has already taken back', async () => {
    const { container } = await renderArchiveFlow()
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    // The reader walked away to another archive while a page was in flight.
    await click(container.querySelector('[data-plugin-import-change-file]')!);
    await settle();
    expect(container.querySelector('[data-plugin-import-start]')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the job in one click, with no second consent', async () => {
    const { container } = await renderArchiveFlow()
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();
    expect(start).toHaveBeenCalledWith({ previewId: 'preview-1', acknowledge: true });
  });

  it('accumulates job pages instead of replacing the first with the second', async () => {
    const first = { id: 'job-1', schemaVersion: 1, previewId: 'p', selection: { pluginId: 'p', sourceId: 's', home: HOME, externalId: 'a' }, sourceHome: HOME, targetHome: 'home-1', revision: 'r', title: 'First job', formatVersion: 'v1', status: 'completed', createdAt: 0, updatedAt: 0, records: 1, pages: 1, bytesRead: 1, totalBytes: 1, cursor: null, parsed: true, losses: [], archiveId: null, error: null };
    const second = { ...first, id: 'job-2', title: 'Second job' };
    // The server pages by the cursor it hands back, not by how often it was
    // asked: page one without a cursor, then one page per returned cursor.
    jobs.mockImplementation(async (request: { cursor?: string } = {}) => (request.cursor === undefined
      ? { items: [first], cursor: 'page-2' }
      : { items: [second], cursor: null }));
    const { container } = await render();
    expect(container.querySelectorAll('[data-plugin-import-job]')).toHaveLength(1);
    // The server said there is a next page; the reader asks for it.
    await click(container.querySelector('[data-plugin-import-more]')!);
    await settle();
    // Both pages are on screen. A list that swaps page for page loses the first
    // page the moment the reader asks for the second.
    const titles = [...container.querySelectorAll('[data-plugin-import-job]')].map((row) => row.textContent ?? '');
    expect(titles.join('|')).toContain('First job');
    expect(titles.join('|')).toContain('Second job');
    // The last page had no cursor, so the list does not offer one it cannot read.
    expect(container.querySelector('[data-plugin-import-more]')).toBeNull();
  });

  it('still shows a job that finished while the reader was reading older ones', async () => {
    const running = { id: 'job-live', schemaVersion: 1, previewId: 'p', selection: { pluginId: 'p', sourceId: 's', home: HOME, externalId: 'a' }, sourceHome: HOME, targetHome: 'home-1', revision: 'r', title: 'Running job', formatVersion: 'v1', status: 'running' as const, createdAt: 0, updatedAt: 0, records: 0, pages: 0, bytesRead: 0, totalBytes: 0, cursor: null, parsed: false, losses: [], archiveId: null, error: null };
    const older = { ...running, id: 'job-old', title: 'Older job', status: 'completed' as const };
    const fresh = { ...running, id: 'job-fresh', title: 'Just finished job', status: 'completed' as const };
    jobs.mockImplementation(async (request: { cursor?: string } = {}) => (request.cursor === undefined
      ? { items: [running], cursor: 'page-2' }
      : { items: [older], cursor: null }));
    const { container } = await renderArchiveFlow()
    // The reader pages back in time; the newest page keeps its own life.
    await click(container.querySelector('[data-plugin-import-more]')!);
    await settle();
    expect(container.textContent).toContain('Older job');
    // That job finished, and the server now leads the newest page with it.
    jobs.mockImplementation(async (request: { cursor?: string } = {}) => (request.cursor === undefined
      ? { items: [fresh], cursor: 'page-2' }
      : { items: [older], cursor: null }));
    // A job the reader starts is the re-read this screen owes them: the newest
    // page is read again while they are still looking at the older one.
    start.mockResolvedValue({ id: 'job-fresh', status: 'queued' });
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();
    expect(container.textContent).toContain('Just finished job');
    // Paging back must not have thrown the older page away.
    expect(container.textContent).toContain('Older job');
  });

  it('keeps a remote peer’s archives readable and offers no import it cannot own', async () => {
    remote = true;
    archives.mockResolvedValue({ items: [{ id: 'archive-1', pluginId: 'p', sourceId: 'claude-code', sourceHome: HOME, externalId: FILE, targetHome: 'main', title: 'Migrate the search index', revision: 'bb12cc33', formatVersion: 'v1', createdAt: 0, updatedAt: 0, status: 'preserved', losses: [], records: 3, pages: 1, jobId: 'job-1', previousJobIds: [] }], cursor: null });
    const { container } = await render();
    // The page is not hidden and the archive is not faked away.
    expect(container.querySelector('[data-plugin-import-view]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-archive="archive-1"]')).not.toBeNull();
    // The source-home field and the start action belong to the local owner.
    expect(container.querySelector('[data-plugin-import-readonly]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-home]')).toBeNull();
  });
});

/**
 * The server pages by its own cursor and its own order. Neither is a promise
 * that what a reader just asked for is on the page they are looking at, so the
 * list has to hold every page it has read and the start receipt has to be read
 * by id.
 */
describe('ImportHistoryView paging and the job it just started', () => {
  it('keeps the middle page on screen after a third one is read', async () => {
    jobs.mockImplementation(async (request: { cursor?: string } = {}) => {
      if (request.cursor === undefined) return { items: [job('job-1', 'Page one job')], cursor: 'page-2' };
      if (request.cursor === 'page-2') return { items: [job('job-2', 'Page two job')], cursor: 'page-3' };
      return { items: [job('job-3', 'Page three job')], cursor: null };
    });
    const { container } = await render();
    await click(container.querySelector('[data-plugin-import-more]')!);
    await settle();
    await click(container.querySelector('[data-plugin-import-more]')!);
    await settle();

    // Every page read is still here, including the one in the middle.
    const titles = [...container.querySelectorAll('[data-plugin-import-job]')].map((row) => row.textContent ?? '');
    expect(titles.join('|')).toContain('Page one job');
    expect(titles.join('|')).toContain('Page two job');
    expect(titles.join('|')).toContain('Page three job');
    expect(container.querySelectorAll('[data-plugin-import-job]')).toHaveLength(3);
    // The last page had no cursor, so the list does not offer one it cannot read.
    expect(container.querySelector('[data-plugin-import-more]')).toBeNull();
  });

  it('keeps the middle archive on screen after a third page is read', async () => {
    archives.mockImplementation(async (request: { cursor?: string } = {}) => {
      if (request.cursor === undefined) return { items: [archive('archive-1', 'Archive one')], cursor: 'page-2' };
      if (request.cursor === 'page-2') return { items: [archive('archive-2', 'Archive two')], cursor: 'page-3' };
      return { items: [archive('archive-3', 'Archive three')], cursor: null };
    });
    const { container } = await render();
    await click(container.querySelector('[data-plugin-import-more]')!);
    await settle();
    await click(container.querySelector('[data-plugin-import-more]')!);
    await settle();

    expect(container.querySelector('[data-plugin-import-archive="archive-1"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-archive="archive-2"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-archive="archive-3"]')).not.toBeNull();
  });

  it('reads the job it just started by id, and shows its progress even when no page holds it', async () => {
    // A full first page that does not contain the new job: the server's order
    // is not a time order, so "newest is on page one" is not a fact.
    jobs.mockResolvedValue({ items: [job('job-old', 'An older job')], cursor: 'page-2' });
    const started = job('job-brand-new', 'The job I just started', { status: 'running' as const, records: 0, pages: 0, bytesRead: 40, totalBytes: 100, parsed: false });
    jobById.mockImplementation(async (id: string) => (id === started.id ? started : job(id, `Unknown ${id}`)));
    start.mockResolvedValue({ id: started.id, status: 'queued' });

    const { container } = await renderArchiveFlow()
    expect(container.querySelector('[data-plugin-import-job="job-brand-new"]')).toBeNull();

    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();

    // The receipt's job is on screen with a real progress bar, and can be
    // cancelled — without the reader having to find its page first.
    const row = container.querySelector('[data-plugin-import-job="job-brand-new"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-plugin-import-progress]')).not.toBeNull();
    await click(container.querySelector('[data-plugin-import-cancel="job-brand-new"]')!);
    expect(cancel).toHaveBeenCalledWith('job-brand-new');
  });

  it('opens the archive of a started job once it settles, read by id', async () => {
    jobs.mockResolvedValue({ items: [], cursor: null });
    let state = job('job-brand-new', 'The job I just started', { status: 'running' as const, parsed: false });
    jobById.mockImplementation(async (id: string) => (id === state.id ? state : job(id, `Unknown ${id}`)));
    start.mockResolvedValue({ id: state.id, status: 'queued' });
    read.mockResolvedValue({ records: [], nextCursor: null });

    const { container, queryClient } = await renderArchiveFlow()
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();
    expect(container.querySelector('[data-plugin-import-open]')).toBeNull();

    // It finishes. The archive id arrives on the job record itself, not on any
    // list page, so only a fresh read of that job puts it on screen.
    state = { ...state, status: 'completed' as const, archiveId: 'archive-new', records: 4, pages: 1 };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-import', 'job', 'scope-1', state.id] });
    });
    await settle();

    const open = container.querySelector('[data-plugin-import-open="archive-new"]');
    expect(open).not.toBeNull();
    await click(open!);
    expect(read).toHaveBeenCalled();
  });
});

/**
 * The reader's goal is a Kiki session they can keep talking in, so the page
 * offers that first and only asks for the one thing it cannot know. The
 * read-only archive is still one segment away, and the previous path must keep
 * working exactly as it did — nothing here may make the archive import harder.
 */
describe('ImportHistoryView importing as a native Kiki session', () => {
  it('defaults to a Kiki session rather than an archive', async () => {
    const { container } = await render();
    // The reader's goal is a conversation they can continue, so it is what the
    // page is on before they touch anything.
    const destination = container.querySelector('[data-plugin-import-destination]')!;
    expect((destination as HTMLElement).dataset['pluginImportDestination']).toBe('native');
    expect(destination.textContent).toContain('Kiki session');
    // And the field that destination needs is on screen with it.
    expect(container.querySelector('[data-plugin-import-workdir-input]')).not.toBeNull();
  });

  it('sends the chosen working directory as the destination and starts in the same click', async () => {
    preview.mockResolvedValue(SESSION_PREVIEW);
    const { container } = await render();
    await chooseDestination(container, 'native');
    await setWorkDir(container);
    await setHome(container);
    await settle();
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();

    // The wire carries the aim, not a GUI-private field: the same `destination`
    // the service's schema names.
    expect(preview).toHaveBeenCalledWith({
      pluginId: 'claude-code-import', sourceId: 'claude-code', home: HOME, externalId: FILE,
      destination: { kind: 'native-session', workDir: WORK_DIR },
    });
    const panel = container.querySelector('[data-plugin-import-preview]')!;
    expect((panel as HTMLElement).dataset['pluginImportPreviewKind']).toBe('native-session');
    // The consequence says where it lands, which is the reader's own choice.
    expect(panel.textContent).toContain(WORK_DIR);
    // One click, and still exactly the one consent the archive path has.
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();
    expect(start).toHaveBeenCalledWith({ previewId: 'preview-session', acknowledge: true });
  });

  it('never probes a session read that has no working directory to run in', async () => {
    const { container } = await render();
    await setHome(container);
    // The reader has chosen a session but not where it works. There is no
    // sensible default, so the read is not sent rather than guessed at.
    expect(preview).not.toHaveBeenCalled();
    expect(container.querySelector('[data-plugin-import-workdir-required]')).not.toBeNull();

    // Naming a directory is what unblocks it, and nothing else.
    await setWorkDir(container);
    // eslint-disable-next-line no-console
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('offers the workspaces this Kiki already knows instead of a wall of typing', async () => {
    const { container } = await render();
    const chips = [...container.querySelectorAll('[data-plugin-import-workdir-option]')] as HTMLElement[];
    expect(chips.map((chip) => chip.dataset['pluginImportWorkdirOption'])).toEqual([WORK_DIR, 'C:/code/other']);

    // One click on a known workspace aims the import there, with no typing and
    // no directory being registered as a side effect.
    await click(chips[0]!);
    await settle();
    expect((container.querySelector('[data-plugin-import-workdir-input]') as HTMLInputElement).value).toBe(WORK_DIR);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ destination: { kind: 'native-session', workDir: WORK_DIR } }));
  });

  it('re-probes rather than redrawing the previous aim’s losses', async () => {
    preview.mockResolvedValue(SESSION_PREVIEW);
    const { container } = await render();
    await setWorkDir(container);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    expect(container.querySelector('[data-plugin-import-preview]')).not.toBeNull();
    const first = preview.mock.calls.length;

    // A different aim is a different read: the same file into an archive has
    // different losses, so the panel under the reader must not survive the
    // change as though it described the new aim.
    await chooseDestination(container, 'archive');
    expect(container.querySelector('[data-plugin-import-preview]')).toBeNull();
    expect(preview.mock.calls.length).toBeGreaterThan(first);
  });

  it('tells the reader when this conversation is already in that directory', async () => {
    preview.mockResolvedValue(SESSION_PREVIEW);
    const { container } = await render();
    await setWorkDir(container);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    // The host's own reuse receipt, from `existingSessionId`. Without it a
    // second import looks like it would fork a second copy of the history.
    const receipt = container.querySelector('[data-plugin-import-existing-session]');
    expect(receipt).not.toBeNull();
    expect(receipt!.textContent).toContain(WORK_DIR);
  });

  it('does not raise the archive receipt under a session destination', async () => {
    // The archive is a different fact from the session. Under a session read it
    // would send the reader looking for a record they did not ask for, and it
    // reads as though starting this import would update that archive.
    // The host answers with the aim it was actually asked for, as the service
    // does — echoing the session aim back for an archive read would be a
    // fixture that proves nothing.
    preview.mockImplementation(async (input: { destination?: { kind: string } }) => ({
      ...SESSION_PREVIEW,
      destination: input.destination,
      // The archive exists only for the archive aim; the session only for the
      // session aim. Both receipts are set here so whichever one the page
      // wrongly showed would be caught.
      existingArchiveId: 'archive-elsewhere',
      existingRevision: 'bb12cc33dd44ee55',
      existingSessionId: input.destination?.kind === 'native-session' ? 'session-existing' : null,
    }));
    const { container } = await render();
    await setWorkDir(container);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    expect(container.querySelector('[data-plugin-import-existing]')).toBeNull();
    expect(container.querySelector('[data-plugin-import-existing-session]')).not.toBeNull();

    // The archive aim still raises its own receipt — the two are not merged.
    await chooseDestination(container, 'archive');
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // Changing the aim closed the panel, so the list is open again and the same
    // file can be picked for the new aim without retyping anything.
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container.querySelector('[data-plugin-import-existing]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-existing-session]')).toBeNull();
  });

  it('shows the session import’s own losses beside the parser’s', async () => {
    preview.mockResolvedValue(SESSION_PREVIEW);
    const { container } = await render();
    await setWorkDir(container);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    // The host discloses both what the parser dropped and what becoming a
    // session cannot carry; neither is inferred by this page.
    const codes = [...container.querySelectorAll('[data-plugin-import-loss]')].map((node) => (node as HTMLElement).dataset['pluginImportLoss']);
    expect(codes).toContain('sidechain_filtered');
    expect(codes).toContain('native_text_history');
    // And the note says the one thing a session import cannot promise.
    expect(container.querySelector('[data-plugin-import-preview-note]')!.textContent)
      .toContain('not as this Kiki’s permissions');
  });

  it('keeps the read-only archive path working exactly as it was', async () => {
    const { container } = await render();
    await chooseDestination(container, 'archive');
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    // The archive path sends the selection alone — the field is optional, and
    // this keeps the older servers and archives behaving identically.
    expect(preview).toHaveBeenCalledWith({
      pluginId: 'claude-code-import', sourceId: 'claude-code', home: HOME, externalId: FILE,
      destination: { kind: 'archive' },
    });
    const panel = container.querySelector('[data-plugin-import-preview]')!;
    expect((panel as HTMLElement).dataset['pluginImportPreviewKind']).toBe('archive');
    // The read-only boundary is still stated once, in its own words.
    expect(container.querySelector('[data-plugin-import-preview-note]')!.textContent)
      .toContain('read-only archive');
    // And the session-only field is not on screen.
    expect(container.querySelector('[data-plugin-import-workdir-input]')).toBeNull();
  });

  it('offers a remote peer no session it could not create', async () => {
    remote = true;
    const { container } = await render();
    // The peer's own history is still readable here, but a session would have
    // to be created in this machine's directory from the peer's conversation,
    // so the choice is not offered rather than offered and refused later.
    expect(container.querySelector('[data-plugin-import-view]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-destination-readonly]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-import-destination] [data-segment="native"]')).toBeNull();
    expect(container.querySelector('[data-plugin-import-workdir-input]')).toBeNull();
  });

  it('shortens the id it draws and still sends the whole one', async () => {
    // Two conversations can share a title, so the row carries the id beside it
    // — but a full 36-character digest on every row is noise that competes with
    // the title for the same glance.
    const TWIN = '7a1b9c3d-2e4f-4a6b-8c0d-1e2f3a4b5c6d';
    discover.mockResolvedValue({
      entries: [
        { externalId: FILE, title: 'Shared title' },
        { externalId: TWIN, title: 'Shared title' },
      ],
      cursor: null,
    });
    const { container } = await renderArchiveFlow();
    await setHome(container);
    const rows = [...container.querySelectorAll('[data-plugin-import-file]')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    // The drawn id is the head, not the whole digest, and the two stay apart.
    const drawn = rows.map((row) => row.textContent ?? '');
    expect(drawn.join('|')).toContain('0f4d2a1c-6b8e');
    expect(drawn.join('|')).toContain('7a1b9c3d-2e4f');
    expect(drawn.join('|')).not.toContain(TWIN);
    // The full value is still what the row is keyed by, what its tooltip
    // carries, and what the preview is asked about.
    expect(rows[1]!.dataset['pluginImportFile']).toBe(TWIN);
    expect(rows[1]!.querySelector('[title]')!.getAttribute('title')).toBe(TWIN);
    // Discovery lists a home, not a file, so the id first reaches the wire on
    // the preview — the read that is actually about this conversation.
    await click(rows[1]!);
    await settle();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ externalId: TWIN }));
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();
    // What the server is told is the whole id, not the head drawn on the row.
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ externalId: TWIN }));
  });

  it('reads one page and one record as singular facts', async () => {
    jobs.mockResolvedValue({ items: [job('job-1', 'Single page job', { records: 1, pages: 1 })], cursor: null });
    const { container } = await render();
    const row = container.querySelector('[data-plugin-import-job="job-1"]')!;
    // `1 pages` is the grammar a single templated string got wrong; the two
    // numbers are independent, so each is read on its own.
    expect(row.textContent).toContain('1 record');
    expect(row.textContent).toContain('1 page');
    expect(row.textContent).not.toContain('1 pages');
    expect(row.textContent).not.toContain('1 records');
  });

  it('keeps the plural form when the counts are not one', async () => {
    jobs.mockResolvedValue({ items: [job('job-1', 'Many page job', { records: 3, pages: 4 })], cursor: null });
    const { container } = await render();
    const row = container.querySelector('[data-plugin-import-job="job-1"]')!;
    expect(row.textContent).toContain('3 records');
    expect(row.textContent).toContain('4 pages');
  });

  it('opens a finished session import on the session route, not as an archive', async () => {
    const opened: string[] = [];
    jobs.mockResolvedValue({ items: [sessionJob('job-native', 'Migrate the search index')], cursor: null });
    const { container } = await render({ onOpenSession: (id) => { opened.push(id); } });

    const row = container.querySelector('[data-plugin-import-job="job-native"]')!;
    const open = row.querySelector('[data-plugin-import-open-session]')!;
    expect(open).not.toBeNull();
    // A native import writes no archive, so the archive action must not appear
    // as though there were one to open.
    expect(row.querySelector('[data-plugin-import-open]')).toBeNull();
    await click(open);
    // The id the host committed, handed to the normal session route.
    expect(opened).toEqual(['job-native-session']);
  });

  it('offers no session to open before the host has committed one', async () => {
    // A job that is merely finished reading has not created a session yet, so
    // there is nothing to continue and the action must not be a dead link.
    jobs.mockResolvedValue({
      items: [sessionJob('job-running', 'Still importing', { status: 'running' as const, sessionId: null, parsed: false, records: 0, pages: 0 })],
      cursor: null,
    });
    const { container } = await render({ onOpenSession: () => undefined });
    const row = container.querySelector('[data-plugin-import-job="job-running"]')!;
    expect(row.querySelector('[data-plugin-import-open-session]')).toBeNull();
    expect(row.querySelector('[data-plugin-import-progress]')).not.toBeNull();
  });

  it('reads the session job back by id the way it reads an archive job', async () => {
    // The same readback the archive path already has: a job started here is a
    // preview digest, not necessarily on any page the reader has asked for.
    jobs.mockResolvedValue({ items: [job('job-old', 'An older job')], cursor: null });
    let state = sessionJob('job-brand-new', 'The session I just started', { status: 'running' as const, sessionId: null, parsed: false, records: 0, pages: 0, bytesRead: 30, totalBytes: 100 });
    jobById.mockImplementation(async (id: string) => (id === state.id ? state : job(id, `Unknown ${id}`)));
    start.mockResolvedValue({ id: state.id, status: 'queued' });
    preview.mockResolvedValue(SESSION_PREVIEW);

    const { container, queryClient } = await render({ onOpenSession: () => undefined });
    await setWorkDir(container);
    await setHome(container);
    await click(container.querySelector(`[data-plugin-import-file="${FILE}"]`)!);
    await settle();
    await click(container.querySelector('[data-plugin-import-start]')!);
    await settle();

    const row = container.querySelector('[data-plugin-import-job="job-brand-new"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-plugin-import-progress]')).not.toBeNull();

    // It finishes. The session id arrives on the job record, not on any list
    // page, so only a fresh read of that job can name the session to open.
    state = { ...state, status: 'completed' as const, sessionId: 'session-landed', records: 6, pages: 2 };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-import', 'job', 'scope-1', state.id] });
    });
    await settle();
    expect(container.querySelector('[data-plugin-import-open-session="session-landed"]')).not.toBeNull();
  });
});
