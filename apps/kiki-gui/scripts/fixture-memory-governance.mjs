/**
 * Fixture stand-in for the governed-store memory routes (kap-server
 * routes/memory.ts, agent-core memoryAuthorityStore.ts): authority status,
 * read-only recovery and resume, provenance, historical revisions, and the
 * forget preview / irreversible forget pair. Entry CRUD stays in
 * fixture-server.mjs; this module wraps it so the store's mode is enforced on
 * every write and a user write records a decision, as the real store does.
 *
 * Scenario seed (optional):
 *   memoryGovernance: {
 *     authority: { backend: 'sqlite', mode: 'active', epoch, migrationId }   // default: legacy
 *     provenance: { [scopeKey]: { [id]: { sources: [...], adjudications: [...], shared: [ids] } } }
 *     revisions:  { [scopeKey]: { [id]: { [revision]: entry } } }
 *     delays:     { provenance?: ms, forget?: ms }
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
  server.memoryGovernanceDelays = seed.delays ?? {};
  server.memoryGovernanceReentry = false;
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

/** Returns true when this module answered; false lets fixture-server continue. */
export async function handleMemoryGovernance(server, res, path, query, body, method) {
  if (!path.startsWith('/memory') || server.memoryGovernanceReentry) return false;
  const authority = server.memoryAuthority;
  if (path === '/memory/authority' && method === 'GET') { server.envelope(res, structuredClone(authority)); return true; }
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
  if (path.startsWith('/memory/authority/')) return invalid(server, res, 'Not served by this fixture');

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
    const result = { operation_id: body.operation_id, forgotten };
    server.memoryForgotten.set(body.operation_id, result);
    server.envelope(res, result);
    return true;
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
