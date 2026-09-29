/**
 * Fixture stand-in for the spaces surface (kap-server routes/homes.ts and the
 * `/config` origin layer; design analyses/2026-09-29-kiki-instances-isolation-design.md §4.3, §9).
 *
 * One fixture process plays every space: `server.spaces.active` is the space
 * whose backend this `/api` currently is. The main space manages `homes.json`
 * (list/create/attach/remove/delete/credential mode); a space may only list,
 * and its writes are rejected like the real `requireMainSpace`. In a space,
 * `GET /config` carries `origins`, and `POST /config/overrides:remove` drops a
 * space-local key so it reads from the main space again.
 *
 * The visual proof's desktop mock switches spaces through
 *   POST /__control { action: 'space', id }        — make `id` the active backend
 *   POST /__control { action: 'space_state' }      — dump the spaces state
 *
 * Scenario seed (all optional):
 *   spaces: {
 *     mainPath: string,
 *     items: [{ id, name, color?, path, credentials?: 'shared'|'isolated',
 *               overrides?: { [snakeDomain]: value }, live?: boolean }],
 *     sshCandidates: [{ hostId, workspaceId?, name, credential_kinds }],
 *     active?: string,
 *   }
 */

/** Domains the fixture tracks per layer; everything else stays on `server.config`. */
const LAYERED = ['default_model', 'fast_model', 'default_permission_mode', 'session_title', 'subagent'];

function state(server) {
  if (server.spaces === undefined || server.spaces.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.spaces ?? {});
    server.spaces = {
      scenario: server.scenario?.name,
      mainPath: seed.mainPath ?? 'C:\\Users\\fixture\\.kiki',
      items: (seed.items ?? []).map((item) => ({ credentials: 'shared', overrides: {}, live: false, ...item })),
      sshCandidates: seed.sshCandidates ?? [],
      active: seed.active ?? 'main',
      mainConfig: undefined,
      log: [],
    };
  }
  return server.spaces;
}

function listPayload(spaces) {
  return {
    items: [
      { id: 'main', name: 'Main space', path: spaces.mainPath, primary: true, credentials_shared: true },
      ...spaces.items.map((item) => ({
        id: item.id, name: item.name, ...(item.color === undefined ? {} : { color: item.color }), path: item.path,
        primary: false, credentials_shared: item.credentials === 'shared',
      })),
    ],
  };
}

function leafOrigins(value, prefix, origin, into) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) leafOrigins(child, prefix === '' ? key : `${prefix}.${key}`, origin, into);
    return;
  }
  into[prefix] = origin;
}

function deepMerge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...(base !== null && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(over)) out[key] = deepMerge(out[key], value);
  return out;
}

/** The effective config the active backend serves, with origins inside a space. */
export function spaceConfig(server) {
  const spaces = state(server);
  if (spaces.active === 'main') return server.config;
  const item = spaces.items.find((entry) => entry.id === spaces.active);
  const merged = { ...server.config };
  const origins = {};
  for (const domain of LAYERED) {
    const base = server.config[domain];
    const local = item?.overrides[domain];
    if (base !== undefined) leafOrigins(base, '', 'base', origins[domain] ??= {});
    if (local !== undefined) {
      merged[domain] = deepMerge(base, local);
      leafOrigins(local, '', 'home', origins[domain] ??= {});
    }
  }
  return { ...merged, origins };
}

/** A config write inside a space lands in the space's own layer (§4.4). */
export function spaceConfigWrite(server, patch) {
  const spaces = state(server);
  if (spaces.active === 'main') return false;
  const item = spaces.items.find((entry) => entry.id === spaces.active);
  if (item === undefined) return false;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!LAYERED.includes(key)) continue;
    if (key === 'subagent' && value !== null && typeof value === 'object') {
      const next = { ...(item.overrides.subagent ?? {}) };
      for (const [field, fieldValue] of Object.entries(value)) {
        const camel = field.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
        if (fieldValue === null) delete next[camel]; else next[camel] = fieldValue;
      }
      item.overrides.subagent = next;
    } else if (value === null) {
      delete item.overrides[key];
    } else {
      item.overrides[key] = value;
    }
  }
  return true;
}

function removeOverride(item, domain, keyPath) {
  if (keyPath.length === 0) { delete item.overrides[domain]; return; }
  const parents = [];
  let current = item.overrides[domain];
  for (const part of keyPath) {
    if (current === null || typeof current !== 'object') return;
    parents.push([current, part]);
    current = current[part];
  }
  const [parent, key] = parents.at(-1);
  delete parent[key];
  for (let index = parents.length - 1; index > 0; index -= 1) {
    const [holder, holderKey] = parents[index - 1];
    if (Object.keys(holder[holderKey]).length === 0) delete holder[holderKey];
  }
  if (Object.keys(item.overrides[domain] ?? {}).length === 0) delete item.overrides[domain];
}

const id16 = () => `h-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}${Date.now().toString(16).slice(-8)}`;

export function handleSpaces(server, res, path, method, body) {
  const spaces = state(server);
  const reject = (message) => { server.envelope(res, null, 40001, message); return true; };
  const mainOnly = () => (spaces.active !== 'main' ? reject('Manage spaces from the main space window') : false);

  if (path === '/config/overrides:remove' && method === 'POST') {
    if (spaces.active === 'main') return reject('Only independent spaces can restore inherited settings');
    const item = spaces.items.find((entry) => entry.id === spaces.active);
    const keyPath = (body?.key_path ?? []).map((part) => part.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()));
    if (item !== undefined) removeOverride(item, body?.domain, keyPath);
    spaces.log.push({ removeOverride: body });
    server.envelope(res, spaceConfig(server));
    return true;
  }
  if (path === '/homes' && method === 'GET') {
    server.envelope(res, listPayload(spaces));
    return true;
  }
  if (path === '/homes' && method === 'POST') {
    if (mainOnly()) return true;
    if (typeof body?.name !== 'string' || body.name.trim() === '') return reject('name is required');
    if (spaces.items.some((item) => item.path.toLowerCase() === String(body.path).toLowerCase())) return reject('Cannot create space: Error: This space is already registered');
    const record = { id: id16(), name: body.name.trim(), color: body.color, path: body.path, credentials: body.inherit?.credentials ?? 'shared', overrides: {}, live: false };
    spaces.items.push(record);
    spaces.log.push({ create: body });
    server.envelope(res, { id: record.id, name: record.name, ...(record.color === undefined ? {} : { color: record.color }), path: record.path });
    return true;
  }
  if (path === '/homes:attach' && method === 'POST') {
    if (mainOnly()) return true;
    const name = String(body?.path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? 'space';
    const record = { id: id16(), name, path: body.path, credentials: 'shared', overrides: {}, live: false };
    spaces.items.push(record);
    server.envelope(res, { id: record.id, name: record.name, path: record.path });
    return true;
  }
  const candidates = /^\/homes\/(h-[a-z0-9-]+)\/ssh-copy-candidates$/.exec(path);
  if (candidates !== null && method === 'GET') {
    if (mainOnly()) return true;
    const item = spaces.items.find((entry) => entry.id === candidates[1]);
    if (item === undefined) return reject('Space is not registered');
    if (item.credentials !== 'shared') return reject('Only shared-credential spaces can copy main SSH secrets');
    server.envelope(res, { hosts: spaces.sshCandidates });
    return true;
  }
  const erase = /^\/homes\/(h-[a-z0-9-]+):delete$/.exec(path);
  if (erase !== null && method === 'POST') {
    if (mainOnly()) return true;
    const item = spaces.items.find((entry) => entry.id === erase[1]);
    if (item === undefined) return reject('Cannot delete space: Error: Space is not registered');
    if (body?.confirm_name !== item.name) return reject('Cannot delete space: Error: Space identity or confirmed name does not match');
    if (item.live) return reject('Cannot delete space: Error: Close this space window and backend before deletion');
    spaces.items = spaces.items.filter((entry) => entry !== item);
    spaces.log.push({ erase: { id: item.id, confirm_name: body.confirm_name } });
    server.envelope(res, listPayload(spaces));
    return true;
  }
  const one = /^\/homes\/(h-[a-z0-9-]+)$/.exec(path);
  if (one !== null && method === 'PATCH') {
    if (mainOnly()) return true;
    const item = spaces.items.find((entry) => entry.id === one[1]);
    if (item === undefined) return reject('Cannot update space: Error: Space is not registered');
    const previous = item.credentials;
    const desired = body?.inherit?.credentials;
    if (desired !== 'shared' && desired !== 'isolated') return reject('inherit.credentials must be shared or isolated');
    const copy = body?.copy_ssh_credentials;
    let copied = 0;
    if (copy !== undefined && copy !== false) {
      if (!(previous === 'shared' && desired === 'isolated')) return reject('Cannot update space: Error: SSH copying needs a shared → isolated switch');
      const picked = copy === true ? spaces.sshCandidates : spaces.sshCandidates.filter((candidate) => copy.hosts.some((host) => host.hostId === candidate.hostId && (host.workspaceId ?? null) === (candidate.workspaceId ?? null)));
      copied = picked.reduce((sum, host) => sum + host.credential_kinds.length, 0);
    }
    item.credentials = desired;
    spaces.log.push({ update: { id: item.id, body } });
    server.envelope(res, {
      space: { id: item.id, name: item.name, ...(item.color === undefined ? {} : { color: item.color }), path: item.path, credentials_shared: desired === 'shared' },
      restart_required: item.live,
      copied_ssh_entries: copied,
      ...(previous === 'isolated' && desired === 'shared' ? { retained_isolated_ssh_entries: 2 } : {}),
    });
    return true;
  }
  if (one !== null && method === 'DELETE') {
    if (mainOnly()) return true;
    spaces.items = spaces.items.filter((entry) => entry.id !== one[1]);
    server.envelope(res, listPayload(spaces));
    return true;
  }
  return false;
}

/** `/__control` actions for the desktop mock. */
export function spacesControl(server, body) {
  const spaces = state(server);
  if (body.action === 'space') {
    if (body.id !== 'main' && !spaces.items.some((item) => item.id === body.id)) return { error: `unknown space ${body.id}` };
    spaces.active = body.id;
    const item = spaces.items.find((entry) => entry.id === body.id);
    if (item !== undefined) item.live = true;
    return { active: spaces.active, ...(item === undefined ? {} : { space: { id: item.id, name: item.name, color: item.color, path: item.path, credentials: item.credentials } }) };
  }
  return { ...structuredClone({ active: spaces.active, items: spaces.items, log: spaces.log }) };
}
