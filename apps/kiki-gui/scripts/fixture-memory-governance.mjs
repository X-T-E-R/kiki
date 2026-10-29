/**
 * Fixture stand-in for the governed-store memory routes (kap-server
 * routes/memory.ts, agent-core memoryAuthorityStore.ts): authority status,
 * read-only recovery and resume, provenance, historical revisions, and the
 * forget preview / irreversible forget pair, and the Markdown export /
 * import-preview / import round trip. Entry CRUD stays in
 * fixture-server.mjs; this module wraps it so the store's mode is enforced on
 * every write and a user write records a decision, as the real store does.
 *
 * Scenario seed (optional):
 *   memoryGovernance: {
 *     authority: { backend: 'sqlite', mode: 'active', epoch, migrationId }   // default: legacy
 *     provenance: { [scopeKey]: { [id]: { sources: [...], adjudications: [...], shared: [ids] } } }
 *     revisions:  { [scopeKey]: { [id]: { [revision]: entry } } }
 *     delays:     { provenance?: ms, forget?: ms }
 *     importTtlMs: preview token lifetime (default 10 min)
 *     upgrade:    { operationId, namespaces, failAt?, issues?, hold? } — an automatic
 *                 startup upgrade that advances one step per status read
 *   }
 * Migration start/cancel are served for completeness of the contract but the
 * GUI under test does not call them.
 */

import { randomUUID } from 'node:crypto';

const LEGACY = { version: 1, epoch: 0, backend: 'legacy', mode: 'active' };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function resetMemoryGovernance(server, data) {
  const seed = data.memoryGovernance ?? {};
  server.memoryAuthority = { ...LEGACY, ...structuredClone(seed.authority ?? {}) };
  if (server.memoryAuthority.backend === 'sqlite') server.memoryAuthority.migrationId ??= '00000000-0000-4000-8000-000000000001';
  server.memoryProvenance = new Map(Object.entries(structuredClone(seed.provenance ?? {})).map(([key, items]) => [key, new Map(Object.entries(items))]));
  server.memoryRevisions = new Map(Object.entries(structuredClone(seed.revisions ?? {})).map(([key, items]) => [key, new Map(Object.entries(items).map(([id, revisions]) => [id, new Map(Object.entries(revisions))]))]));
  server.memoryForgotten = new Map();
  server.memoryForgottenIds = new Set();
  server.memoryImportOps = new Map();
  server.memoryGovernanceDelays = seed.delays ?? {};
  server.memoryGovernanceReentry = false;
  server.memoryImports = new Map();
  server.memoryImportTtlMs = seed.importTtlMs ?? 10 * 60_000;
  server.memoryUpgrade = seed.upgrade === undefined ? undefined : { ...structuredClone(seed.upgrade), step: 0 };
}

/**
 * Stands in for the startup upgrade: each status read moves it one step
 * (discovery, one namespace per read, validation), unless `hold` keeps it
 * still or `failAt` stops it with the seeded issues. Completion switches to
 * the governed store, as the real one does.
 */
function advanceUpgrade(server) {
  const upgrade = server.memoryUpgrade;
  const authority = server.memoryAuthority;
  if (upgrade === undefined || authority.backend !== 'legacy' || authority.mode === 'readonly' || upgrade.hold) return;
  const id = authority.migration?.id ?? upgrade.operationId;
  const migration = authority.migration ?? { id, namespaces: [], index: 0, issues: [], phase: 'importing' };
  if (migration.phase === 'failed') return;
  upgrade.step += 1;
  if (upgrade.failAt !== undefined && upgrade.step >= upgrade.failAt) {
    Object.assign(authority, { mode: 'migrating', migration: { ...migration, phase: 'failed', issues: structuredClone(upgrade.issues ?? []), failure: { code: 'memory.source_invalid', message: `Memory source validation found ${(upgrade.issues ?? []).length} issue(s); repair the listed sources and retry this operation` } } });
    return;
  }
  if (migration.namespaces.length === 0) {
    Object.assign(authority, { mode: 'migrating', migration: { ...migration, namespaces: [...upgrade.namespaces], phase: 'importing' } });
    return;
  }
  if (migration.index < migration.namespaces.length) {
    Object.assign(authority, { migration: { ...migration, index: migration.index + 1 } });
    return;
  }
  if (migration.phase !== 'validating') { Object.assign(authority, { migration: { ...migration, phase: 'validating' } }); return; }
  server.memoryAuthority = { version: 1, epoch: authority.epoch + 1, backend: 'sqlite', mode: 'active', migrationId: id };
}

const invalid = (server, res, msg) => { server.envelope(res, null, 40001, msg, { code: 'invalid_input', recovery: 'Inspect Memory authority status and reconcile the reported operation before retrying.' }); return true; };

function provenanceOf(server, key, id) {
  let scope = server.memoryProvenance.get(key);
  if (scope === undefined) { scope = new Map(); server.memoryProvenance.set(key, scope); }
  let record = scope.get(id);
  if (record === undefined) { record = { sources: [], adjudications: [], shared: [] }; scope.set(id, record); }
  return record;
}

function revisionOf(server, key, id, revision) {
  const entry = server.memoryList(key).find((item) => item.id === id);
  if (entry !== undefined && server.memoryRevision(entry) === revision) return { ...structuredClone(entry), revision };
  const seeded = server.memoryRevisions.get(key)?.get(id)?.get(revision);
  if (seeded !== undefined) return { ...structuredClone(seeded), revision };
  const record = (server.memoryJournal.get(key) ?? []).find((item) => item.id === id && item.beforeRevision === revision && item.before !== null);
  const before = record === undefined ? undefined : server.memoryBeforeImage(record.before);
  return before === undefined ? undefined : { ...before, revision };
}

function ownerScope(scope, query) {
  const workspaceId = query.get('workspace_id') ?? undefined;
  const personaId = query.get('persona_id') ?? undefined;
  if (scope === 'persona') return { kind: 'persona', personaId };
  if (scope === 'persona_workspace') return { kind: 'persona_workspace', workspaceId, personaId };
  return scope === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId };
}

/** The exported file, byte for byte the shape memoryMarkdown.ts serializes. */
function memoryMarkdown(scope, entry) {
  const metadata = { format: 'kiki-memory-v1', scope, id: entry.id, revision: entry.revision, origin: { id: entry.id, revision: entry.revision }, source: entry.source, type: entry.type, title: entry.title, status: entry.status, pinned: entry.pinned, basis: entry.basis, validity: entry.validity ?? null };
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${entry.body}\n`;
}

const fileRefused = (server, res, code, msg, recovery) => { server.envelope(res, null, 40001, msg, { code, recovery }); return true; };

function parseImport(markdown) {
  const match = typeof markdown === 'string' ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown) : null;
  if (match === null) return undefined;
  let meta;
  try { meta = JSON.parse(match[1]); } catch { return undefined; }
  const body = match[2].trim();
  if (meta?.format !== 'kiki-memory-v1' || typeof meta.title !== 'string' || meta.title.trim() === '' || body === '' || body.length > 1_500) return undefined;
  if (meta.id === 'new' ? meta.revision !== null || meta.status !== 'active' : meta.revision === null || meta.origin === null) return undefined;
  return { format: meta.format, scope: meta.scope, id: meta.id, revision: meta.revision, origin: meta.origin ?? null, source: meta.source ?? { writer: 'import' }, type: meta.type, title: meta.title.trim(), body, status: meta.status, pinned: meta.pinned === true, basis: meta.basis, validity: meta.validity ?? null };
}

const sameScope = (a, b) => JSON.stringify([a?.kind, a?.workspaceId ?? null, a?.personaId ?? null]) === JSON.stringify([b?.kind, b?.workspaceId ?? null, b?.personaId ?? null]);

function previewImport(server, res, key, scope, body) {
  const incoming = parseImport(body?.markdown);
  if (incoming === undefined || typeof body?.source_locator !== 'string' || body.source_locator.trim() === '' || typeof body?.reason !== 'string' || body.reason.trim() === '') {
    return fileRefused(server, res, 'invalid_input', 'Memory Markdown frontmatter is missing', 'Export an entry before editing its Markdown; keep its scope, ID, revision and origin.');
  }
  if (!sameScope(scope, incoming.scope)) return fileRefused(server, res, 'scope_mismatch', 'Markdown scope does not match the selected owner', 'Select the exported workspace and persona; exporting or importing never moves an entry.');
  const unit = JSON.stringify([key, body.markdown, body.source_locator.trim()]);
  const seen = server.memoryImports.get(unit);
  const entries = server.memoryList(key);
  const withRevision = (entry) => ({ ...structuredClone(entry), revision: server.memoryRevision(entry) });
  if (seen !== undefined) {
    if ((server.memoryForgottenIds ?? new Set()).has(seen)) return fileRefused(server, res, 'inactive_target', 'This exact Markdown source has been forgotten', 'Use a distinct new source; an old source cannot recreate forgotten Memory.');
    const linked = entries.find((entry) => entry.id === seen);
    if (linked !== undefined) { server.envelope(res, { incoming, current: withRevision(linked), action: 'retained', canApply: false }); return true; }
  }
  const found = incoming.id === 'new' ? undefined : entries.find((entry) => entry.id === incoming.id);
  const current = found === undefined ? null : withRevision(found);
  if (incoming.id !== 'new' && (current === null || current.revision !== incoming.revision)) {
    server.envelope(res, { incoming, current, action: 'update', canApply: false, issue: { code: 'revision_conflict', recovery: 'Export the current entry again, reconcile the complete content and preview that new file.' } });
    return true;
  }
  if (incoming.id === 'new') {
    const duplicate = entries.find((entry) => entry.status === 'active' && entry.title.toLowerCase() === incoming.title.toLowerCase());
    if (duplicate !== undefined) { server.envelope(res, { incoming, current: withRevision(duplicate), action: 'create', canApply: false, issue: { code: 'duplicate_title', recovery: 'Export the existing entry and reconcile its complete content instead of creating a duplicate title.' } }); return true; }
  }
  if (current !== null && current.type === incoming.type && current.title === incoming.title && current.body === incoming.body && current.pinned === incoming.pinned) {
    server.envelope(res, { incoming, current, action: 'unchanged', canApply: false });
    return true;
  }
  const expiresAt = Date.now() + server.memoryImportTtlMs;
  const input = { markdown: body.markdown, sourceLocator: body.source_locator.trim(), reason: body.reason.trim() };
  const previewToken = `${Buffer.from(JSON.stringify({ version: 1, epoch: server.memoryAuthority.epoch, expiresAt, input })).toString('base64url')}.fixture`;
  server.envelope(res, { incoming, current, action: incoming.id === 'new' ? 'create' : 'update', canApply: true, previewToken, expiresAt: new Date(expiresAt).toISOString() });
  return true;
}

/** Collects one envelope routeMemory writes, so a confirmed import reuses the ordinary save. */
function captured() {
  const out = { status: 0, payload: undefined };
  return { out, res: { writeHead(status) { out.status = status; }, end(text) { out.payload = JSON.parse(text); } } };
}

async function applyImport(server, res, key, scope, body, path, query) {
  if (body?.confirm_import !== true || typeof body?.operation_id !== 'string') return invalid(server, res, 'confirm_import and operation_id are required');
  const done = server.memoryImportOps?.get(body.operation_id);
  if (done !== undefined) { server.envelope(res, structuredClone(done)); return true; }
  let token;
  try {
    const [payload, signature, extra] = String(body.preview_token).split('.');
    if (!payload || signature !== 'fixture' || extra !== undefined) throw new Error('bad');
    token = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (token.expiresAt <= Date.now() || token.epoch !== server.memoryAuthority.epoch) throw new Error('stale');
  } catch {
    return fileRefused(server, res, 'invalid_input', 'Memory import preview is invalid, expired or from a different authority state', 'Preview the unchanged Markdown again and review its current target before confirming.');
  }
  const incoming = parseImport(token.input.markdown);
  const unit = JSON.stringify([key, token.input.markdown, token.input.sourceLocator]);
  const seen = server.memoryImports.get(unit);
  if (seen !== undefined && (server.memoryForgottenIds ?? new Set()).has(seen)) return fileRefused(server, res, 'inactive_target', 'This exact Markdown source has been forgotten', 'Use a distinct new source; an old source cannot recreate forgotten Memory.');
  const put = { action: incoming.id === 'new' ? 'create' : 'update', type: incoming.type, title: incoming.title, body: incoming.body, pinned: incoming.pinned, reason: token.input.reason, basis: incoming.basis, validity: incoming.validity, expected_revision: incoming.id === 'new' ? undefined : incoming.revision };
  const { out, res: sink } = captured();
  const putPath = path.replace(/\/import$/, `/${incoming.id}`);
  server.memoryGovernanceReentry = true;
  try { await server.routeMemory(sink, putPath, query, put, 'PUT'); } finally { server.memoryGovernanceReentry = false; }
  const envelope = out.payload;
  if (envelope?.code === 40944) { server.envelope(res, null, 40944, 'memory.revision_conflict', { code: 'revision_conflict', recovery: 'Export the current entry again, reconcile the complete content and preview that new file.' }); return true; }
  if (envelope?.code !== 0) { server.envelope(res, null, envelope?.code ?? 50000, envelope?.msg ?? 'failed', envelope?.details); return true; }
  const entry = envelope.data.entry;
  const record = provenanceOf(server, key, entry.id);
  record.sources.push({ id: `source:import:${server.memoryOpCounter}`, scope: `memory/${key}`, objectId: entry.id, payload: token.input.markdown, locator: token.input.sourceLocator, learnedAt: new Date().toISOString() });
  record.adjudications.push({ id: `decision:import:${server.memoryOpCounter}`, scope: `memory/${key}`, objectId: entry.id, kind: 'correction', revision: entry.revision, reason: token.input.reason, sourceIds: [] });
  server.memoryImports.set(unit, entry.id);
  server.memoryImportOps ??= new Map();
  server.memoryImportOps.set(body.operation_id, envelope.data);
  server.envelope(res, envelope.data);
  return true;
}

/** Returns true when this module answered; false lets fixture-server continue. */
export async function handleMemoryGovernance(server, res, path, query, body, method) {
  if (!path.startsWith('/memory') || server.memoryGovernanceReentry) return false;
  const authority = server.memoryAuthority;
  if (path === '/memory/authority' && method === 'GET') { advanceUpgrade(server); server.envelope(res, structuredClone(server.memoryAuthority)); return true; }
  if (path === '/memory/authority/recover-readonly' && method === 'POST') {
    if (body?.confirm_readonly !== true) return invalid(server, res, 'confirm_readonly is required');
    if (authority.backend !== 'sqlite') return invalid(server, res, 'Recovery requires completed SQLite migration');
    if (authority.mode !== 'readonly') { authority.recoveryId = randomUUID(); authority.mode = 'readonly'; authority.epoch += 1; }
    server.envelope(res, { recoveryId: authority.recoveryId, scope: `store/memory-recovery-v1/${authority.recoveryId}`, generation: 1, namespaces: ['memory/global'], mode: 'readonly', database: 'memory.sqlite', compatibility: 'legacy-current-view', resume: 'resumeEditing' });
    return true;
  }
  if (path === '/memory/authority/resume-editing' && method === 'POST') {
    if (authority.mode !== 'readonly' || body?.recovery_id !== authority.recoveryId || body?.expected_epoch !== authority.epoch) return invalid(server, res, 'Memory recovery state changed; reload its exact recovery ID and epoch');
    delete authority.recoveryId;
    authority.mode = 'active';
    authority.epoch += 1;
    server.envelope(res, structuredClone(authority));
    return true;
  }
  if (path === '/memory/authority/retry' && method === 'POST') {
    const id = authority.backend === 'sqlite' ? authority.migrationId : authority.migration?.id;
    if (body?.operation_id !== id) return invalid(server, res, 'Memory migration does not match the retry');
    if (authority.backend !== 'sqlite') {
      // A retry after the sources were repaired starts the same operation over.
      const upgrade = server.memoryUpgrade;
      if (upgrade !== undefined) { upgrade.failAt = undefined; upgrade.step = 0; }
      Object.assign(authority, { mode: 'migrating', migration: { id, namespaces: [], index: 0, issues: [], phase: 'importing' } });
    }
    server.envelope(res, structuredClone(authority));
    return true;
  }
  if (path.startsWith('/memory/authority/')) return invalid(server, res, 'Not served by this fixture');
  // Until the automatic upgrade completes, the store answers no ordinary read or write.
  if (server.memoryUpgrade !== undefined && server.memoryAuthority.backend === 'legacy' && /^\/memory\/(global|workspace|persona_workspace|persona)(\/|$)/.test(path)) {
    return invalid(server, res, 'Memory startup migration has not completed; inspect authority status and retry the same operation');
  }

  const match = /^\/memory\/(global|workspace|persona_workspace|persona)(?:\/(.+))?$/.exec(path);
  if (match === null) return false;
  const key = server.memoryScopeKey(match[1], query.get('workspace_id') ?? undefined, query.get('persona_id') ?? undefined);
  const tail = match[2] ?? '';
  const sqlite = authority.backend === 'sqlite';
  const entries = server.memoryList(key);
  const writing = method === 'PUT' || method === 'DELETE' || tail === 'undo' || tail === 'forget';
  if (writing && authority.mode !== 'active') {
    return invalid(server, res, authority.mode === 'readonly' ? 'Memory recovery mode is read-only; resume SQLite editing to write' : 'Memory migration is paused behind its write barrier; resume or cancel the migration');
  }
  const governedOnly = /\/(provenance|revisions\/.+)$/.test(tail) || tail === 'forget-preview' || tail === 'forget';
  if (governedOnly && !sqlite) return invalid(server, res, 'This Memory governance operation requires completed SQLite migration');

  const provenance = /^(m_[A-Za-z0-9_]+)\/provenance$/.exec(tail);
  if (provenance !== null && method === 'GET') {
    if (server.memoryGovernanceDelays.provenance) await sleep(server.memoryGovernanceDelays.provenance);
    const id = provenance[1];
    if (!entries.some((entry) => entry.id === id) && !server.memoryProvenance.get(key)?.has(id)) { server.envelope(res, null, 40423, 'Memory not found'); return true; }
    const record = provenanceOf(server, key, id);
    server.envelope(res, { sources: structuredClone(record.sources), adjudications: structuredClone(record.adjudications), relatedObjectIds: [id, ...record.shared].toSorted() });
    return true;
  }
  const revision = /^(m_[A-Za-z0-9_]+)\/revisions\/(.+)$/.exec(tail);
  if (revision !== null && method === 'GET') {
    const entry = revisionOf(server, key, revision[1], decodeURIComponent(revision[2]));
    if (entry === undefined) { server.envelope(res, null, 40423, 'Memory revision not found'); return true; }
    server.envelope(res, { ...entry, historical: true, complete: true });
    return true;
  }
  if (tail === 'forget-preview' && method === 'POST') {
    const ids = new Set();
    for (const id of body?.ids ?? []) { ids.add(id); for (const shared of provenanceOf(server, key, id).shared) ids.add(shared); }
    const targets = [];
    for (const id of [...ids].toSorted()) {
      const entry = entries.find((item) => item.id === id);
      if (entry === undefined) { server.envelope(res, null, 40423, 'Memory forget target is missing or already forgotten'); return true; }
      targets.push({ id, expectedRevision: server.memoryRevision(entry), entry: { ...structuredClone(entry), revision: server.memoryRevision(entry) } });
    }
    server.envelope(res, { generation: server.memoryOpCounter, targets });
    return true;
  }
  if (tail === 'forget' && method === 'POST') {
    if (body?.confirm_irreversible !== true) return invalid(server, res, 'confirm_irreversible is required');
    if (server.memoryGovernanceDelays.forget) await sleep(server.memoryGovernanceDelays.forget);
    const done = server.memoryForgotten.get(body.operation_id);
    if (done !== undefined) { server.envelope(res, done); return true; }
    for (const target of body.targets ?? []) {
      const entry = entries.find((item) => item.id === target.id);
      if (entry === undefined || server.memoryRevision(entry) !== target.expected_revision) {
        server.envelope(res, null, 40944, 'Forget preview changed', { code: 'revision_conflict', recovery: 'Read the complete current target and reconcile its conditions before retrying.' });
        return true;
      }
    }
    const forgotten = body.targets.map((target) => target.id);
    server.memoryEntries.set(key, entries.filter((entry) => !forgotten.includes(entry.id)));
    server.memoryJournal.set(key, (server.memoryJournal.get(key) ?? []).filter((record) => !forgotten.includes(record.id)));
    for (const id of forgotten) { server.memoryProvenance.get(key)?.delete(id); server.memoryRevisions.get(key)?.delete(id); }
    server.memoryForgottenIds ??= new Set();
    for (const id of forgotten) server.memoryForgottenIds.add(id);
    const result = { operation_id: body.operation_id, forgotten };
    server.memoryForgotten.set(body.operation_id, result);
    server.envelope(res, result);
    return true;
  }

  const exported = /^(m_[A-Za-z0-9_]+)\/export$/.exec(tail);
  if (exported !== null && method === 'GET') {
    if (!sqlite) return invalid(server, res, 'This Memory governance operation requires completed SQLite migration');
    const entry = entries.find((item) => item.id === exported[1]);
    if (entry === undefined) { server.envelope(res, null, 40423, 'Memory not found', { code: 'not_found', recovery: 'Reload the current scoped entry before exporting.' }); return true; }
    const current = { ...structuredClone(entry), revision: server.memoryRevision(entry) };
    server.envelope(res, { markdown: memoryMarkdown(ownerScope(match[1], query), current), entry: current });
    return true;
  }
  if ((tail === 'import-preview' || tail === 'import') && method === 'POST') {
    if (!sqlite) return invalid(server, res, 'This Memory governance operation requires completed SQLite migration');
    if (authority.mode !== 'active') return invalid(server, res, authority.mode === 'readonly' ? 'Memory recovery mode is read-only; resume SQLite editing to write' : 'Memory migration is paused behind its write barrier; resume or cancel the migration');
    return tail === 'import-preview'
      ? previewImport(server, res, key, ownerScope(match[1], query), body)
      : applyImport(server, res, key, ownerScope(match[1], query), body, path, query);
  }

  // An ordinary user write on the governed store also records a decision on
  // the revision it produced, the way the store does.
  if (sqlite && method === 'PUT' && /^m_[A-Za-z0-9_]+$/.test(tail)) {
    server.memoryGovernanceReentry = true;
    try { await server.routeMemory(res, path, query, body, method); } finally { server.memoryGovernanceReentry = false; }
    const entry = server.memoryList(key).find((item) => item.id === tail);
    if (entry !== undefined && body?.expected_revision !== server.memoryRevision(entry)) {
      provenanceOf(server, key, tail).adjudications.push({
        id: `decision:${server.memoryOpCounter}:${tail}`, scope: `memory/${key}`, objectId: tail,
        kind: body?.action === 'archive' ? 'retirement' : 'correction', revision: server.memoryRevision(entry), reason: body?.reason ?? '', sourceIds: [],
      });
    }
    return true;
  }
  return false;
}
