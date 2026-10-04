/**
 * Managed import history (`pluginImportService`) for the GUI fixture server.
 *
 * The routes mirror `packages/agent-core-v2/src/app/pluginImport/pluginImportService.ts`:
 * the same ten methods, the same `Import*` wire shapes validated by
 * `packages/protocol/src/rest/plugin-import.ts`, and a job that really moves
 * through `running` to `completed` — the page polls it, so a canned `completed`
 * would prove nothing about the progress a user sees.
 *
 * The scenario owns the data (`pluginImport`): which sources a healthy enabled
 * plugin contributes, and for each source home a probe, the discovery entries,
 * and the parse pages a parser would return. Sources are projected the way the
 * service projects them — only a session source whose plugin is enabled and
 * healthy is offered — so a disabled plugin's importer never appears.
 *
 * Nothing here reads a real home, a real plugin manifest, or a real history
 * file. Every path and message is fixture text.
 */

import { tsImport } from 'tsx/esm/api';

// The production wire validators, not a local restatement: a fixture job that
// does not satisfy `importJobSchema` is a fixture bug, not a shape to widen.
const {
  importArchiveSchema,
  importDiscoveryPageSchema,
  importJobSchema,
  importPreviewInputSchema,
  importPreviewSchema,
  importReadPageSchema,
  importSelectionSchema,
  importSourceSchema,
  importStartInputSchema,
} = await tsImport('../../../packages/protocol/src/rest/plugin-import.ts', import.meta.url);

/** The connected fixture server's home, as `bootstrap.homeDir` reports it. */
export const FIXTURE_IMPORT_HOME = 'main';
/**
 * How much work one poll of a live job does, so progress is the server's.
 * Roughly the pace of a parser reading a chunk off disk: fast enough that a
 * short import finishes while a reader watches, slow enough that a real
 * history is not over before the page has drawn it.
 */
export const TICK_MS = 1_400;
const DISCOVERY_PAGE = 3;

/**
 * What becoming a Kiki session cannot carry, in the service's own words. The
 * page must not have to invent this disclosure: a session import turns old tool
 * calls into history, and it does not install another tool's system prompt,
 * approvals or running tasks as this Kiki's own state.
 */
const NATIVE_LOSSES = [
  { code: 'native_text_history', count: 1, detail: 'User/assistant text becomes native context; tools become completed historical text, never executable calls' },
  { code: 'native_internal_state_not_imported', count: 1, detail: 'External system instructions, metadata, usage, approvals and running tasks are not installed as local state' },
];

function now() { return Date.now(); }
function fail(message) { const error = new Error(message); error.fixtureHttp = 400; return error; }
function failCode(message, code) { const error = fail(message); error.fixtureCode = code; return error; }

/** Sources from the scenario, projected through the production schema. */
function sourcesOf(server) {
  const configured = server.scenario?.data?.pluginImport?.sources ?? [];
  // A first-party importer is served by the host from its own descriptor, so it
  // is offered whether or not a plugin record exists for it — the whole point is
  // that the reader installs nothing. A third-party source still has to be an
  // installed, healthy, enabled plugin, or it is not on this server at all.
  const hostShipped = new Set(Object.keys(server.scenario?.data?.pluginImport?.hostShipped ?? {}));
  return configured
    .filter((source) => {
      if (hostShipped.has(source.pluginId)) return true;
      const plugin = (server.plugins ?? []).find((item) => item.id === source.pluginId);
      return plugin !== undefined && plugin.enabled === true && plugin.state === 'ok';
    })
    .map((source) => importSourceSchema.parse({
      schemaVersion: 1, id: source.id, label: source.label, formatVersion: source.formatVersion, pluginId: source.pluginId,
    }));
}

function keyOf(input) { return `${input.pluginId}:${input.sourceId}:${input.home}`; }

/** The scenario's stored home data for one selection, or a refusal. */
function homeOf(server, input) {
  const source = sourcesOf(server).find((item) => item.pluginId === input.pluginId && item.id === input.sourceId);
  if (source === undefined) throw fail('Session source is not enabled');
  const home = server.importHomes[keyOf(input)];
  if (home === undefined) throw failCode('Source home not found', 40409);
  return { source, home };
}

/** Cursor paging over an ordered map, in the shape the contract returns. */
function pageOf(store, input, parse) {
  const keys = Object.keys(store).sort();
  const cursor = input.cursor ?? '';
  const limit = input.limit ?? 50;
  const after = keys.filter((key) => key > cursor);
  const keys_ = after.slice(0, limit);
  const last = keys_.at(-1) ?? cursor;
  return { items: keys_.map((key) => parse(store[key])), cursor: keys.some((key) => key > last) ? last : null };
}

function mergeLosses(...groups) {
  const map = new Map();
  for (const loss of groups.flat()) {
    const key = `${loss.code}\0${loss.detail}`;
    const old = map.get(key);
    if (old === undefined) map.set(key, { ...loss });
    else old.count += loss.count;
  }
  return [...map.values()].slice(0, 100);
}

/** Reset every import store from the scenario, restarting any live job's loop. */
export function resetImportHistory(server, data) {
  const config = data?.pluginImport ?? null;
  server.importEnabled = config !== null && config !== undefined;
  server.importHomes = config?.homes ?? {};
  server.importStored = config?.storedByJob ?? {};
  server.importPreviews = {};
  server.importJobs = {};
  server.importArchives = {};
  server.importPages = {};
  server.importNative = {};
  server.importSessions = {};
  server.importTimers = new Map();
  for (const job of config?.jobs ?? []) server.importJobs[job.id] = importJobSchema.parse(job);
  for (const archive of config?.archives ?? []) server.importArchives[archive.id] = importArchiveSchema.parse(archive);
  // A seeded native job is also a seeded receipt, filed under the same identity
  // the service would compute for it. That is what makes a later preview of the
  // same source + revision + directory report the existing session.
  for (const job of config?.jobs ?? []) {
    if (job.destination?.kind !== 'native-session' || job.sessionId === null || job.sessionId === undefined) continue;
    server.importNative[keyOfNative(job)] = { sessionId: job.sessionId, sessionPath: job.sessionPath, jobId: job.id };
  }
  // A seeded archive's pages are stored under the job that wrote it, exactly
  // as the service keys them, so `read` finds them without a special case.
  for (const [jobId, pages] of Object.entries(config?.storedByJob ?? {})) {
    pages.forEach((page, index) => { server.importPages[`${jobId}:${index}`] = page; });
  }
  for (const id of Object.keys(server.importJobs)) {
    const job = server.importJobs[id];
    if (job.status === 'running' || job.status === 'queued') tick(server, id);
  }
}

const storedFor = (server, job) => server.importStored[job.id] ?? server.importHomes[keyOf(job.selection)]?.pages ?? [];

/**
 * The identity a native session receipt is filed under. Same as the service's:
 * the source it came from, the revision that was read, and the directory it
 * was aimed at. A new revision is a new session; a new directory is a new
 * session; the same three are the same conversation already in Kiki.
 */
function keyOfNative(job) {
  return `${keyOf(job.selection)} ${job.revision} ${job.destination?.workDir ?? ''}`;
}

/**
 * The turns a committed native import puts into its session. User and
 * assistant text is what a session continues from; system and metadata records
 * are not conversation, and a tool record is history the reader can read but
 * not re-run. This mirrors what the service appends as native context.
 */
export function importedSessionMessages(server, job) {
  const records = (server.importPages[job.id] ?? server.importStored[job.id]?.pages
    ?? server.importHomes[keyOf(job.selection)]?.pages ?? [])
    .flatMap((page) => page.records ?? []);
  return records
    .filter((record) => (record.role === 'user' || record.role === 'assistant') && (record.text ?? '') !== '')
    .map((record, index) => ({
      id: `msg-import-${index}`,
      role: record.role,
      content: [{ type: 'text', text: record.text }],
      created_at: new Date(job.createdAt + index * 1000).toISOString(),
    }));
}

/**
 * One page of a live job, then the next. The archive is written when the
 * parser's last page reports `cursor: null`, which is the same boundary the
 * service commits on.
 */
function tick(server, jobId) {
  const run = () => {
    const job = server.importJobs[jobId];
    if (job === undefined || (job.status !== 'running' && job.status !== 'queued')) {
      stop(server, jobId);
      return;
    }
    const page = storedFor(server, job)[job.pages];
    if (page === undefined) { commit(server, job); return; }
    const next = importJobSchema.parse({
      ...job,
      status: 'running',
      pages: job.pages + 1,
      records: job.records + page.records.length,
      bytesRead: page.bytesRead,
      cursor: page.cursor,
      parsed: page.cursor === null,
      losses: mergeLosses(job.losses, page.losses ?? []),
      updatedAt: now(),
    });
    server.importJobs[jobId] = next;
    if (page.cursor === null) commit(server, next);
  };
  const timer = setInterval(run, TICK_MS);
  timer.unref?.();
  server.importTimers.set(jobId, timer);
}

function stop(server, jobId) {
  const timer = server.importTimers.get(jobId);
  if (timer !== undefined) clearInterval(timer);
  server.importTimers.delete(jobId);
}

function commit(server, job) {
  stop(server, job.id);
  // A native destination writes a session, not an archive. The receipt is keyed
  // by source + revision + destination, which is what makes a second import of
  // the same revision land in the same session instead of forking a second one.
  if (job.destination?.kind === 'native-session') {
    const sessionId = job.sessionId ?? `session-${job.id}`;
    const receipt = server.importNative[keyOfNative(job)] ?? {
      sessionId, sessionPath: `${job.destination.workDir}/.kiki/sessions/${sessionId}`, jobId: job.id,
    };
    server.importNative[keyOfNative(job)] = receipt;
    server.importSessions[receipt.sessionId] = {
      id: receipt.sessionId, workDir: job.destination.workDir, title: job.title, jobId: job.id,
    };
    for (const [index, page] of storedFor(server, job).entries()) {
      server.importPages[`${job.id}:${index}`] = page;
    }
    // The committed fact is the session; `archiveId` stays null, which is what
    // tells the page there is no archive to open and a session to continue.
    // The session is created before the job is reported completed, so a reader
    // who sees  and clicks through never lands on an id that is not
    // there yet.
    server.addImportedSession?.({ ...job, sessionId: receipt.sessionId });
    server.importJobs[job.id] = importJobSchema.parse({
      ...job, status: 'completed', archiveId: null, sessionId: receipt.sessionId,
      sessionPath: receipt.sessionPath, error: null, updatedAt: now(),
    });
    return;
  }
  const archiveId = `archive-${job.id}`;
  const archive = importArchiveSchema.parse({
    schemaVersion: 1,
    id: archiveId,
    pluginId: job.selection.pluginId,
    sourceId: job.selection.sourceId,
    sourceHome: job.sourceHome,
    externalId: job.selection.externalId,
    targetHome: job.targetHome,
    title: job.title,
    revision: job.revision,
    formatVersion: job.formatVersion,
    createdAt: job.createdAt,
    updatedAt: now(),
    status: job.losses.length > 0 ? 'partial' : 'preserved',
    losses: job.losses,
    records: job.records,
    pages: job.pages,
    jobId: job.id,
    previousJobIds: [],
  });
  server.importArchives[archiveId] = archive;
  for (const [index, page] of storedFor(server, job).entries()) {
    server.importPages[`${job.id}:${index}`] = page;
  }
  server.importJobs[job.id] = importJobSchema.parse({ ...job, status: 'completed', archiveId, error: null, updatedAt: now() });
}

/** The ten `pluginImportService` methods, as the fixture-klient dispatcher wants them. */
export function callImportService(server, method, args) {
  if (!server.importEnabled) throw fail('Plugin history import is disabled');
  switch (method) {
    case 'sources':
      return { ok: true, data: sourcesOf(server) };

    case 'discover': {
      const input = args[0] ?? {};
      const { home } = homeOf(server, input);
      const offset = Number(input.cursor ?? 0);
      const entries = (home.entries ?? []).slice(offset, offset + DISCOVERY_PAGE);
      const cursor = offset + DISCOVERY_PAGE < (home.entries ?? []).length ? String(offset + DISCOVERY_PAGE) : null;
      return { ok: true, data: importDiscoveryPageSchema.parse({ entries, cursor }) };
    }

    case 'preview': {
      // The aim is part of the input, so it is parsed with the selection: a
      // preview that ignored it would describe a read nobody is going to make.
      const { destination, ...chosen } = importPreviewInputSchema.parse(args[0]);
      const selection = importSelectionSchema.parse(chosen);
      const { source, home } = homeOf(server, selection);
      const first = (home.pages ?? [])[0] ?? { records: [], cursor: null, losses: [], bytesRead: 0 };
      const existing = Object.values(server.importArchives).find((item) => item.externalId === selection.externalId);
      const native = destination?.kind === 'native-session'
        ? server.importNative[`${keyOf(selection)} ${home.probe.revision} ${destination.workDir}`]
        : undefined;
      const preview = importPreviewSchema.parse({
        schemaVersion: 1,
        id: `preview-${(home.id ?? selection.externalId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`,
        selection,
        targetHome: FIXTURE_IMPORT_HOME,
        probe: { ...home.probe, formatVersion: source.formatVersion, sourceHome: selection.home },
        records: first.records,
        // A session import discloses what it cannot carry on top of what the
        // parser dropped: the same two lines the service adds.
        losses: mergeLosses(
          home.probe.losses ?? [], first.losses ?? [],
          ...(destination?.kind === 'native-session' ? [NATIVE_LOSSES] : []),
        ),
        // A parser that returned a cursor has more to give. The page must say
        // `sample`, so a bounded read is never drawn as a whole import.
        coverage: first.cursor === null ? 'complete' : 'sample',
        existingArchiveId: existing?.id ?? null,
        existingRevision: existing?.revision ?? null,
        // The host's own reuse receipt: this conversation is already a session
        // in that directory, so importing again extends it rather than copying.
        existingSessionId: native?.sessionId ?? null,
        destination,
        createdAt: now(),
      });
      server.importPreviews[preview.id] = preview;
      return { ok: true, data: preview };
    }

    case 'start': {
      const input = importStartInputSchema.parse(args[0]);
      const preview = server.importPreviews[input.previewId];
      if (preview === undefined) throw fail('Import preview not found in this target home');
      if (preview.probe.status === 'unsupported') throw fail('Source format is unsupported');
      const id = `job-${preview.selection.externalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
      const prior = server.importJobs[id];
      if (prior !== undefined) return { ok: true, data: prior };
      const job = importJobSchema.parse({
        schemaVersion: 1,
        id,
        previewId: preview.id,
        selection: preview.selection,
        sourceHome: preview.probe.sourceHome,
        targetHome: preview.targetHome,
        revision: preview.probe.revision,
        title: preview.probe.title,
        formatVersion: preview.probe.formatVersion,
        status: 'queued',
        createdAt: now(),
        updatedAt: now(),
        records: 0,
        pages: 0,
        bytesRead: 0,
        totalBytes: preview.probe.totalBytes,
        cursor: null,
        parsed: false,
        losses: preview.probe.losses,
        archiveId: null,
        error: null,
        // The session id is minted now and written when the session is really
        // committed, so a job that is still running names no session to open.
        destination: preview.destination,
        sessionId: preview.destination?.kind === 'native-session' ? `session-${id}` : undefined,
        sessionPath: null,
      });
      server.importJobs[id] = importJobSchema.parse({ ...job, status: 'running' });
      tick(server, id);
      return { ok: true, data: job };
    }

    case 'jobs':
      return { ok: true, data: pageOf(server.importJobs, args[0] ?? {}, (job) => importJobSchema.parse(job)) };

    case 'archives': {
      const input = args[0] ?? {};
      const query = input.query?.toLocaleLowerCase();
      const store = Object.fromEntries(Object.values(server.importArchives)
        .filter((item) => !query || `${item.title}\n${item.externalId}\n${item.sourceId}`.toLocaleLowerCase().includes(query))
        .map((item) => [item.id, item]));
      return { ok: true, data: pageOf(store, input, (archive) => importArchiveSchema.parse(archive)) };
    }

    case 'job': {
      const job = server.importJobs[args[0]];
      if (job === undefined) throw fail('Import job not found');
      return { ok: true, data: job };
    }

    case 'cancel': {
      const job = server.importJobs[args[0]];
      if (job === undefined) throw fail('Import job not found');
      if (job.status === 'completed') return { ok: true, data: job };
      stop(server, job.id);
      const stopped = importJobSchema.parse({ ...job, status: 'cancelled', error: null, updatedAt: now() });
      server.importJobs[job.id] = stopped;
      return { ok: true, data: stopped };
    }

    case 'resume': {
      const job = server.importJobs[args[0]];
      if (job === undefined) throw fail('Import job not found');
      if (job.status === 'completed' || server.importTimers.has(job.id)) return { ok: true, data: job };
      const queued = importJobSchema.parse({ ...job, status: 'queued', error: null, updatedAt: now() });
      server.importJobs[job.id] = importJobSchema.parse({ ...queued, status: 'running' });
      tick(server, job.id);
      return { ok: true, data: queued };
    }

    case 'read': {
      const input = args[0] ?? {};
      const archive = server.importArchives[input.archiveId];
      if (archive === undefined) throw fail('Import archive not found');
      const pageIndex = input.cursor === undefined ? 0 : Number(input.cursor);
      const stored = server.importPages[`${archive.jobId}:${pageIndex}`];
      const records = stored?.records ?? [];
      return {
        ok: true,
        data: importReadPageSchema.parse({ archive, records, cursor: pageIndex + 1 < archive.pages ? String(pageIndex + 1) : null }),
      };
    }

    default:
      throw fail(`Unsupported import method: ${method}`);
  }
}
