/**
 * Fixture stand-in for the persona routes (kap-server routes/personas.ts):
 * list / get / put / duplicate / archive / delete, CCv3 import preview and
 * confirm, export, and the avatar (GET, PUT with an optional `shape` field,
 * DELETE). Writes mutate scenario state so the page's save, conflict (40946), duplicate, archive and delete paths are exercisable.
 *
 * Scenario seed (optional):
 *   personas: [{ definition, examples?, archived?, avatar?: { file, mimeType, shape? } }]
 *   personaImport: { preview }   // what /import/preview returns for any card
 *
 * Card parsing is NOT simulated: any uploaded file previews as the seeded
 * `personaImport.preview` (the GUI is what is under test here).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function revisionOf(record) {
  return createHash('sha256').update(JSON.stringify([record.definition, record.examples ?? null])).digest('hex').slice(0, 16);
}

/** Reset hook: the fixture server calls this from `loadScenario`. */
export function resetPersonas(server, data) {
  server.personas = new Map((data.personas ?? []).map((seed) => [seed.definition.id, {
    definition: structuredClone(seed.definition),
    examples: seed.examples,
    archived: seed.archived === true,
    avatar: seed.avatar === undefined ? undefined : { bytes: readFileSync(seed.avatar.file), mimeType: seed.avatar.mimeType, shape: seed.avatar.shape },
    // The daily pointer and the two visibility flags live in the persona's
    // state file; a seed may name them directly or nest them under `state`.
    state: { ...(seed.state ?? {}), ...(seed.homeSessionId !== undefined ? { homeSessionId: seed.homeSessionId } : {}), ...(seed.pinned !== undefined ? { pinned: seed.pinned } : {}), ...(seed.hidden !== undefined ? { hidden: seed.hidden } : {}) },
  }]));
  server.personaImport = data.personaImport;
}

function summaryOf(record) {
  const { id, name, title, job } = record.definition;
  const state = record.state ?? {};
  return {
    id, name,
    ...(title !== undefined ? { title } : {}),
    ...(job !== undefined ? { job } : {}),
    revision: revisionOf(record),
    archived: record.archived,
    ...(state.homeSessionId !== undefined ? { homeSessionId: state.homeSessionId } : {}),
    ...(state.pinned !== undefined ? { pinned: state.pinned } : {}),
    ...(state.hidden !== undefined ? { hidden: state.hidden } : {}),
    ...(record.avatar !== undefined ? { avatarMime: record.avatar.mimeType } : {}),
    ...(record.avatar?.shape !== undefined ? { avatarShape: record.avatar.shape } : {}),
  };
}

/** The persona state file's own shape (`personaStateSchema`). */
function stateOf(record) {
  const state = record.state ?? {};
  return {
    version: 1,
    archived: record.archived,
    ...(state.homeSessionId !== undefined ? { homeSessionId: state.homeSessionId } : {}),
    ...(state.pinned !== undefined ? { pinned: state.pinned } : {}),
    ...(state.hidden !== undefined ? { hidden: state.hidden } : {}),
  };
}

function snapshotOf(record) {
  return { definition: structuredClone(record.definition), revision: revisionOf(record), ...(record.examples !== undefined ? { examples: record.examples } : {}) };
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Minimal multipart reader: text fields plus the one `file` part. */
function parseMultipart(raw, contentType) {
  const boundary = /boundary=([^;]+)/u.exec(contentType ?? '')?.[1];
  const fields = {};
  let file;
  if (boundary === undefined) return { fields, file };
  const text = raw.toString('latin1');
  for (const part of text.split(`--${boundary}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    const body = part.slice(split + 4).replace(/\r\n$/u, '');
    const name = /name="([^"]*)"/u.exec(head)?.[1];
    if (name === undefined) continue;
    const filename = /filename="([^"]*)"/u.exec(head)?.[1];
    if (filename !== undefined) {
      file = { filename, mimeType: /content-type:\s*([^\r\n]+)/iu.exec(head)?.[1]?.trim() ?? 'application/octet-stream', bytes: Buffer.from(body, 'latin1') };
    } else {
      fields[name] = Buffer.from(body, 'latin1').toString('utf8');
    }
  }
  return { fields, file };
}

function uniqueId(server, base) {
  let candidate = base;
  for (let index = 2; server.personas.has(candidate); index += 1) candidate = `${base}-${index}`;
  return candidate;
}

/** Handle `/api/personas*`; returns true when it answered. */
export async function handlePersonas(server, req, res, path, query) {
  if (!path.startsWith('/personas')) return false;
  const method = req.method ?? 'GET';
  const ok = (data) => { server.envelope(res, data); return true; };
  const fail = (code, msg) => { server.envelope(res, null, code, msg); return true; };
  const json = async () => { const raw = await readRaw(req); return raw.length === 0 ? {} : JSON.parse(raw.toString('utf8')); };
  if (server.personas === undefined) resetPersonas(server, server.scenario?.data ?? {});

  if (path === '/personas' && method === 'GET') {
    const includeArchived = query.get('includeArchived') === 'true';
    return ok([...server.personas.values()].filter((record) => includeArchived || !record.archived).map(summaryOf));
  }
  if (path === '/personas/import/preview' && method === 'POST') {
    const { file } = parseMultipart(await readRaw(req), req.headers['content-type']);
    if (file === undefined) return fail(40001, 'missing `file` field');
    if (server.personaImport?.preview === undefined) return fail(40001, 'this file is not a character card');
    return ok(structuredClone(server.personaImport.preview));
  }
  if (path === '/personas/import' && method === 'POST') {
    const { fields, file } = parseMultipart(await readRaw(req), req.headers['content-type']);
    const preview = server.personaImport?.preview;
    if (file === undefined || preview === undefined) return fail(40001, 'this file is not a character card');
    const id = fields.id ?? uniqueId(server, preview.definition.id);
    if (server.personas.has(id)) return fail(40945, `persona ${id} already exists`);
    const avatar = preview.avatar === undefined ? undefined : { bytes: Buffer.from(preview.avatar.data, 'base64'), mimeType: preview.avatar.mimeType };
    const record = { definition: { ...structuredClone(preview.definition), id, ...(fields.name !== undefined ? { name: fields.name } : {}) }, examples: preview.examples, archived: false, avatar };
    server.personas.set(id, record);
    return ok({ snapshot: snapshotOf(record), memory: { status: 'committed', count: preview.memoryEntries.length } });
  }

  const match = /^\/personas\/([^/:]+)(?::(duplicate|archive))?(?:\/(avatar|export|home|state))?$/u.exec(path);
  if (match === null) return false;
  const id = decodeURIComponent(match[1]);
  if (!ID.test(id)) return fail(40001, 'invalid persona id');
  const record = server.personas.get(id);
  const action = match[2];
  const sub = match[3];

  if (method === 'PUT' && sub === undefined) {
    const body = await json();
    if (body.definition?.id !== id) return fail(40001, 'definition.id must match the persona path id');
    if (record === undefined && body.revision !== undefined) return fail(40425, `persona ${id} does not exist`);
    if (record !== undefined && body.revision === undefined) return fail(40945, `persona ${id} already exists`);
    if (record !== undefined && body.revision !== revisionOf(record)) return fail(40946, `persona ${id} changed since it was read`);
    const next = { definition: body.definition, examples: body.examples, archived: record?.archived ?? false, avatar: record?.avatar, state: record?.state };
    server.personas.set(id, next);
    return ok(snapshotOf(next));
  }
  if (record === undefined) return fail(40425, `persona ${id} does not exist`);
  if (sub === 'home' && method === 'PUT') {
    const body = await json();
    const sessionId = body.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return fail(40001, 'sessionId is required');
    const session = server.sessions?.get(sessionId)?.record;
    if (session === undefined) return fail(40402, `session ${sessionId} does not exist`);
    // The same boundary the server enforces: a room seat is not a persona's
    // daily conversation, and an ephemeral session cannot be one.
    if (session.metadata?.room_member_of !== undefined) return fail(40001, 'a room member session cannot become the daily conversation');
    if (session.ephemeral === true) return fail(40001, 'an ephemeral session cannot become the daily conversation');
    record.state = { ...(record.state ?? {}), homeSessionId: sessionId };
    return ok(stateOf(record));
  }
  if (sub === 'state' && method === 'PATCH') {
    const body = await json();
    record.state = {
      ...(record.state ?? {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
      ...(typeof body.hidden === 'boolean' ? { hidden: body.hidden } : {}),
    };
    return ok(stateOf(record));
  }
  if (sub === 'avatar' && method === 'GET') {
    if (record.avatar === undefined) return fail(40425, `persona ${id} has no avatar`);
    res.writeHead(200, { 'content-type': record.avatar.mimeType, 'content-length': record.avatar.bytes.byteLength });
    res.end(record.avatar.bytes);
    return true;
  }
  if (sub === 'avatar' && method === 'PUT') {
    const { fields, file } = parseMultipart(await readRaw(req), req.headers['content-type']);
    if (file === undefined || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType)) return fail(40001, 'avatar must be PNG, JPEG, or WebP');
    const shape = fields.shape === 'circle' || fields.shape === 'square' ? fields.shape : undefined;
    record.avatar = { bytes: file.bytes, mimeType: file.mimeType, shape };
    return ok({ id, mimeType: file.mimeType, size: file.bytes.byteLength, ...(shape !== undefined ? { shape } : {}) });
  }
  if (sub === 'avatar' && method === 'DELETE') {
    const deleted = record.avatar !== undefined;
    record.avatar = undefined;
    return ok({ id, deleted });
  }
  if (sub === 'export' && method === 'GET') {
    const format = query.get('format') ?? 'json';
    const card = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: record.definition.name, description: record.definition.description, first_mes: record.definition.greeting ?? '' } }, null, 2);
    res.writeHead(200, { 'content-type': format === 'json' ? 'application/json' : 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.${format}"` });
    res.end(card);
    return true;
  }
  if (action === 'duplicate' && method === 'POST') {
    const body = await json();
    const nextId = body.id ?? uniqueId(server, `${id}-copy`);
    if (server.personas.has(nextId)) return fail(40945, `persona ${nextId} already exists`);
    const copy = { definition: { ...structuredClone(record.definition), id: nextId, name: body.name ?? `${record.definition.name} 副本` }, examples: record.examples, archived: false, avatar: record.avatar };
    server.personas.set(nextId, copy);
    return ok(snapshotOf(copy));
  }
  if (action === 'archive' && method === 'POST') {
    const body = await json();
    record.archived = body.archived === true;
    return ok({ version: 1, archived: record.archived });
  }
  if (method === 'DELETE') {
    const expected = query.get('expectedRevision');
    if (expected !== null && expected !== revisionOf(record)) return fail(40946, `persona ${id} changed since it was read`);
    server.personas.delete(id);
    for (const key of [...server.memoryEntries.keys()]) if (key.endsWith(`persona:${id}`)) server.memoryEntries.delete(key);
    return ok({ deleted: true, memory: { status: 'committed' } });
  }
  if (method === 'GET' && sub === undefined && action === undefined) return ok(snapshotOf(record));
  return false;
}
