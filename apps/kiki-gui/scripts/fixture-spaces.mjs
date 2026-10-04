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
      settings: {
        plans: new Map(),
        // The main space's own preferences are the source every followed item
        // resolves against; a space with `prefs` of its own is authoritative.
        mainPrefs: seed.mainPrefs,
        mainSelections: seed.mainSelections ?? {},
        undo: new Map(),
      },
    };
  }
  return server.spaces;
}

// ---------------------------------------------------------------------------
// Space settings (`GET/POST /homes/:id/settings…`) — a stand-in for
// kap-server's spacePreferences service. It models the same shape the GUI
// consumes: item ids, groups, selections, preview tokens, undo and the
// one-time device import. It is not the real store: it keeps nothing on disk.
// ---------------------------------------------------------------------------

const PROTOCOL_DEFAULTS = {
  theme: 'system',
  skin: { source: 'builtin', id: 'paper' },
  tweaks: {},
  background: { light: null, dark: null, linked: true, assist: true },
  proseFont: 'serif',
  defaultAppendTiming: 'agent_idle',
  foldSteps: true,
  worktreeSkipConfirm: false,
};

const PREFERENCE_ITEMS = [
  { id: 'pref:theme', name: 'Theme', domain: 'appearance', key: 'theme' },
  { id: 'pref:skin', name: 'Skin', domain: 'appearance', key: 'skin' },
  { id: 'pref:tweaks', name: 'Appearance tweaks', domain: 'appearance', key: 'tweaks' },
  { id: 'pref:background', name: 'Background', domain: 'appearance', key: 'background' },
  { id: 'pref:proseFont', name: 'Assistant prose', domain: 'appearance', key: 'proseFont' },
  { id: 'pref:defaultAppendTiming', name: 'Append timing', domain: 'config', key: 'defaultAppendTiming' },
  { id: 'pref:foldSteps', name: 'Fold steps', domain: 'config', key: 'foldSteps' },
  { id: 'pref:worktreeSkipConfirm', name: 'Worktree confirmation', domain: 'config', key: 'worktreeSkipConfirm' },
];

const CONFIG_ITEMS = [
  { id: 'config:default_model', name: 'Default model', path: 'default_model' },
  { id: 'config:default_permission_mode', name: 'Default permission mode', path: 'default_permission_mode' },
];

const RESOURCE_ITEMS = [
  { id: 'resource:agents:SYSTEM.md', name: 'SYSTEM.md', domain: 'agents' },
  { id: 'resource:instructions:AGENTS.md', name: 'AGENTS.md', domain: 'instructions' },
  { id: 'resource:skills:paper-search', name: 'paper-search', domain: 'skills' },
  { id: 'resource:mcp:docs', name: 'docs', domain: 'mcp' },
  { id: 'resource:plugins:hello', name: 'hello', domain: 'plugins' },
  { id: 'resource:appearance:themes/inkstone.json', name: 'inkstone.json', domain: 'appearance' },
];

const DOMAINS = ['config', 'agents', 'instructions', 'skills', 'mcp', 'appearance', 'plugins', 'credentials', 'generic_roots'];
const GROUP_DOMAINS = DOMAINS.filter((domain) => domain !== 'generic_roots');

function settingsFor(spaces, id) {
  const item = spaces.items.find((entry) => entry.id === id);
  const primary = id === 'main';
  const own = primary ? spaces.settings.mainPrefs : item?.prefs;
  const selections = primary ? spaces.settings.mainSelections : item?.selections ?? {};
  return { item, primary, own, prefs: { ...PROTOCOL_DEFAULTS, ...(own ?? {}) }, choices: selections, authority: own !== undefined };
}

/** The mode a space's preference item has when nothing names it explicitly. */
function defaultPreferenceMode(spaces, id, key) {
  const space = settingsFor(spaces, id);
  if (space.primary) return 'fixed';
  // No preferences of its own yet: nothing is inherited on paper.
  if (space.own === undefined) return 'fixed';
  // A stored local value is a fixed one.
  if (Object.hasOwn(space.own, key)) return 'fixed';
  const domain = PREFERENCE_ITEMS.find((entry) => entry.key === key)?.domain ?? 'config';
  const group = space.choices[`group:${domain}`]?.mode;
  if (group !== undefined) return group;
  return domain === 'plugins' ? 'fixed' : 'follow';
}

/** What a preference resolves to: its own value when fixed, else the main space's. */
function preferenceValue(spaces, id, key, mode) {
  const space = settingsFor(spaces, id);
  const main = spaces.settings.mainPrefs ?? {};
  const own = space.own ?? {};
  return mode === 'fixed' ? (own[key] ?? PROTOCOL_DEFAULTS[key]) : (main[key] ?? PROTOCOL_DEFAULTS[key]);
}

function itemIds(space) {
  return [
    ...PREFERENCE_ITEMS.map((entry) => entry.id),
    ...CONFIG_ITEMS.map((entry) => entry.id),
    ...RESOURCE_ITEMS.map((entry) => entry.id),
    'source:credentials',
    'source:generic_roots',
  ];
}

function itemState(spaces, id, wireId) {
  const space = settingsFor(spaces, id);
  const preference = PREFERENCE_ITEMS.find((entry) => entry.id === wireId);
  const config = CONFIG_ITEMS.find((entry) => entry.id === wireId);
  const resource = RESOURCE_ITEMS.find((entry) => entry.id === wireId);
  const selection = space.choices[wireId];
  const mode = selection?.mode ?? (space.authority ? 'fixed' : 'follow');
  if (preference !== undefined) {
    const mode = selection?.mode ?? defaultPreferenceMode(spaces, id, preference.key);
    const value = preferenceValue(spaces, id, preference.key, mode);
    const mainValue = spaces.settings.mainPrefs?.[preference.key] ?? PROTOCOL_DEFAULTS[preference.key];
    return {
      id: wireId, name: preference.name, domain: preference.domain, kind: 'preference',
      selection: primaryOr(space.primary, selection, mode), stored: mode === 'fixed' ? value : null,
      effective: value, main: mainValue, actual: value,
      origin: mode === 'follow' ? 'main' : space.own !== undefined && Object.hasOwn(space.own, preference.key) ? 'home' : 'builtin',
      available: true, pending: false, activation: 'immediate',
      revision: `r-${wireId}-${mode}`, main_revision: `r-${wireId}-main`, dependencies: [],
      can_push: !space.primary,
    };
  }
  if (config !== undefined) {
    // The space's own key is its value here; the main space's own key is what a
    // follow resolves to. They are different facts, and a plan that shows them
    // equal would hide the change it is about to make.
    const localValue = space.item?.overrides?.[config.path];
    const mainValue = space.primary ? undefined : server_config_value(spaces, config.path);
    const value = localValue ?? mainValue;
    return {
      id: wireId, name: config.name, domain: 'config', kind: 'config',
      selection: primaryOr(space.primary, selection, mode), stored: localValue ?? null, effective: value ?? null,
      main: mainValue ?? null, actual: value ?? null,
      origin: localValue !== undefined ? 'home' : mainValue !== undefined ? 'main' : 'builtin', available: true, pending: false, activation: 'immediate',
      revision: `r-${wireId}-${mode}`, main_revision: `r-${wireId}-main`, dependencies: [],
      can_push: !space.primary,
    };
  }
  if (resource !== undefined) {
    const available = space.choices[wireId]?.mode !== 'exclude';
    return {
      id: wireId, name: resource.name, domain: resource.domain, kind: 'resource',
      selection: { mode: selection?.mode ?? 'follow', ...(selection?.mode === 'exclude' ? { excluded: true } : {}) },
      stored: available ? { files: [resource.name], bytes: 1024, content_revision: 'c1' } : null,
      effective: available ? { files: [resource.name], bytes: 1024, content_revision: 'c1' } : null,
      main: { files: [resource.name], bytes: 1024, content_revision: 'c1' }, actual: null,
      origin: available ? (selection?.mode === 'fixed' ? 'home' : 'main') : 'unavailable',
      available, pending: false, activation: 'restart',
      revision: `r-${wireId}`, main_revision: `r-${wireId}-main`, dependencies: [],
      can_push: !space.primary && available,
      ...(available ? {} : { blocked_reason: 'Resource content is unavailable' }),
    };
  }
  if (wireId === 'source:credentials') {
    const shared = space.primary || space.item?.credentials !== 'isolated';
    return {
      id: wireId, name: 'Accounts and keys', domain: 'credentials', kind: 'source',
      selection: { mode: shared ? 'follow' : 'fixed' }, stored: null, effective: shared ? 'shared' : 'isolated',
      main: 'shared', actual: shared ? 'shared' : 'isolated', origin: shared ? 'shared' : 'isolated',
      available: true, pending: false, activation: 'restart', revision: 'r-cred', main_revision: 'r-cred-main',
      dependencies: [], can_push: false,
    };
  }
  return {
    id: 'source:generic_roots', name: 'Shared skills and agents', domain: 'generic_roots', kind: 'source',
    selection: { mode: 'follow' }, stored: null, effective: true, main: true, actual: true, origin: 'home',
    available: true, pending: false, activation: 'restart', revision: 'r-roots', main_revision: 'r-roots-main',
    dependencies: [], can_push: false,
  };
}

function primaryOr(primary, selection, mode) {
  return primary ? { mode: 'fixed', ...(selection ?? {}) } : { mode, ...(selection ?? {}) };
}

function server_config_value(spaces, path) {
  const main = spaces.mainConfig ?? {};
  return main[path];
}

function detailFor(spaces, id) {
  const space = settingsFor(spaces, id);
  const items = itemIds(space).map((wireId) => itemState(spaces, id, wireId));
  const groups = GROUP_DOMAINS.map((domain) => {
    const members = items.filter((item) => item.domain === domain);
    return {
      domain,
      mode: space.choices[`group:${domain}`]?.mode ?? (space.primary || domain === 'plugins' ? 'fixed' : 'follow'),
      fixed_count: members.filter((item) => item.selection.mode === 'fixed').length,
      follow_count: members.filter((item) => item.selection.mode === 'follow').length,
    };
  });
  groups.push({
    domain: 'credentials',
    mode: space.item?.credentials === 'isolated' ? 'fixed' : 'follow',
    fixed_count: space.item?.credentials === 'isolated' ? 1 : 0,
    follow_count: space.item?.credentials === 'isolated' ? 0 : 1,
  });
  groups.push({ domain: 'generic_roots', mode: 'follow', fixed_count: 0, follow_count: 1 });
  groups.sort((left, right) => DOMAINS.indexOf(left.domain) - DOMAINS.indexOf(right.domain));
  return {
    schema: 2,
    id, name: space.primary ? 'Main space' : space.item.name, primary: space.primary,
    revision: `rev-${id}`, main_revision: 'rev-main',
    inherit: {
      config: space.choices['group:config']?.mode !== 'fixed', agents: true, instructions: true, skills: true, mcp: true,
      appearance: true, plugins: space.choices['group:plugins']?.mode === 'fixed' ? false : false,
      credentials: space.item?.credentials === 'isolated' ? 'isolated' : 'shared', generic_roots: true,
    },
    groups, items,
    preferences: Object.fromEntries(PREFERENCE_ITEMS.map((entry) => [
      entry.key,
      items.find((item) => item.id === entry.id)?.effective ?? PROTOCOL_DEFAULTS[entry.key],
    ])),
    preference_authority: space.authority,
    ...(spaces.settings.undo.has(id) ? { undo_id: spaces.settings.undo.get(id).id } : {}),
    restart_required: false,
  };
}

function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function previewRows(spaces, id, body) {
  const plan = { rows: [], action: body.action };
  const requested = new Set([...(body.items ?? []), ...(body.changes ?? []).map((change) => change.id)]);
  for (const domain of body.groups ?? []) {
    for (const wireId of itemIds(settingsFor(spaces, id))) {
      if (itemState(spaces, id, wireId).domain === domain) requested.add(wireId);
    }
    if (domain === 'credentials') requested.add('source:credentials');
    if (domain === 'generic_roots') requested.add('source:generic_roots');
  }
  const groupRows = [];
  for (const domain of body.groups ?? []) {
    groupRows.push({
      id: `group:${domain}`, name: `Future ${domain} items`, domain,
      before: detailFor(spaces, id).groups.find((entry) => entry.domain === domain)?.mode ?? 'follow',
      after: body.action === 'follow' ? 'follow' : 'fixed',
      selected: body.action !== 'push-to-main', same_value: false, main_changed: false, conflict: false, dependencies: [],
    });
  }
  const space = settingsFor(spaces, id);
  for (const wireId of requested) {
    const item = itemState(spaces, id, wireId);
    const change = (body.changes ?? []).find((entry) => entry.id === wireId);
    const before = body.action === 'push-to-main' ? item.main : item.effective;
    const after = change !== undefined ? change.value : body.action === 'follow' ? item.main : body.action === 'exclude' ? null : item.effective;
    const blocked = body.action === 'exclude' && item.kind !== 'resource'
      ? 'Only resources can be excluded'
      : body.action === 'edit' && item.kind === 'resource'
        ? 'Edit this resource through its resource editor'
        : body.action === 'push-to-main' && !item.can_push
          ? 'This item cannot be shared through the ordinary push flow'
          : body.action === 'follow' && item.kind === 'resource' && item.main === null
            ? 'Resource content is unavailable'
            : undefined;
    plan.rows.push({
      id: wireId, name: item.name, domain: item.domain, before, after,
      selected: blocked === undefined, same_value: same(before, after), main_changed: false, conflict: false,
      dependencies: item.dependencies,
      ...(blocked === undefined ? {} : { blocked_reason: blocked }),
    });
  }
  plan.rows.push(...groupRows);
  return plan;
}

function applyPlan(spaces, id, body) {
  const plan = spaces.settings.plans.get(body.token);
  if (plan === undefined || Date.parse(plan.expires_at) < Date.now()) return { error: 'This list is out of date. Reopen it.' };
  if ((body.selected ?? []).length === 0) return { applied: [] };
  const space = settingsFor(spaces, id);
  const target = space.primary ? null : space.item;
  const before = structuredClone({ prefs: target?.prefs, selections: target?.selections, credentials: target?.credentials, overrides: target?.overrides });
  for (const wireId of body.selected) {
    const row = plan.rows.find((entry) => entry.id === wireId);
    if (row === undefined || row.blocked_reason !== undefined) return { error: `No plan for ${wireId}` };
    if (wireId.startsWith('group:')) {
      if (target !== null) target.selections = { ...target.selections, [wireId]: { mode: plan.action === 'follow' ? 'follow' : 'fixed' } };
      continue;
    }
    const preference = PREFERENCE_ITEMS.find((entry) => entry.id === wireId);
    const config = CONFIG_ITEMS.find((entry) => entry.id === wireId);
    if (preference !== undefined) {
      if (target === null) continue;
      const value = plan.changes?.find?.((entry) => entry.id === wireId)?.value ?? row.after;
      target.prefs = { ...(target.prefs ?? {}), [preference.key]: value };
      target.selections = {
        ...target.selections,
        [wireId]: { mode: plan.action === 'follow' ? 'follow' : 'fixed', ...(plan.action === 'fixed' ? { reason: 'edited' } : {}) },
      };
      continue;
    }
    if (config !== undefined && target !== null) {
      target.overrides = { ...(target.overrides ?? {}) };
      if (plan.action === 'follow') delete target.overrides[config.path];
      else target.overrides[config.path] = row.after;
      target.selections = { ...target.selections, [wireId]: { mode: plan.action === 'follow' ? 'follow' : 'fixed' } };
    }
  }
  if (space.item !== undefined && body.selected.includes('source:credentials')) space.item.credentials = 'shared';
  spaces.settings.undo.set(id, { id: `undo-${Date.now()}`, before });
  spaces.log.push({ spaceSettings: { id, action: plan.action, selected: body.selected } });
  return { applied: body.selected, undo_id: spaces.settings.undo.get(id).id };
}

function handleSpaceSettings(server, res, path, method, body) {
  const spaces = state(server);
  // The layered config the active backend serves is this fixture's stand-in for
  // the main space's own values, which `config:` items resolve against.
  spaces.mainConfig = server.config;
  const detailPath = /^\/homes\/([^/]+)\/settings$/.exec(path);
  if (detailPath !== null && method === 'GET') {
    server.envelope(res, detailFor(spaces, decodeURIComponent(detailPath[1])));
    return true;
  }
  const previewPath = /^\/homes\/([^/]+)\/settings\/preview$/.exec(path);
  if (previewPath !== null && method === 'POST') {
    const id = decodeURIComponent(previewPath[1]);
    const rows = previewRows(spaces, id, body ?? {});
    const token = `plan-${Math.random().toString(16).slice(2)}`;
    const expires_at = new Date(Date.now() + 600_000).toISOString();
    spaces.settings.plans.set(token, { ...rows, token, expires_at, changes: body?.changes });
    spaces.log.push({ spacePreview: { id, action: body?.action, items: body?.items, groups: body?.groups, changes: body?.changes } });
    server.envelope(res, {
      schema: 2, token, action: body?.action ?? 'follow', rows: rows.rows,
      revision: `rev-${id}`, main_revision: 'rev-main',
      // Preferences and config apply at once; resources and sources wait for a
      // restart, which is the whole of what this route can promise.
      restart_required: rows.rows.some((row) => !row.id.startsWith('group:')
        && itemState(spaces, id, row.id).activation === 'restart'),
      expires_at,
    });
    return true;
  }
  const applyPath = /^\/homes\/([^/]+)\/settings\/apply$/.exec(path);
  if (applyPath !== null && method === 'POST') {
    const id = decodeURIComponent(applyPath[1]);
    const result = applyPlan(spaces, id, body ?? {});
    spaces.settings.plans.delete(body?.token);
    if (result.error !== undefined) { server.envelope(res, null, 40001, result.error); return true; }
    server.envelope(res, { detail: detailFor(spaces, id), applied: result.applied, ...(result.undo_id === undefined ? {} : { undo_id: result.undo_id }) });
    return true;
  }
  const undoPath = /^\/homes\/([^/]+)\/settings\/undo$/.exec(path);
  if (undoPath !== null && method === 'POST') {
    const id = decodeURIComponent(undoPath[1]);
    const record = spaces.settings.undo.get(id);
    if (record === undefined || body?.undo_id !== record.id) { server.envelope(res, null, 40001, 'No recent change to undo'); return true; }
    const target = id === 'main' ? null : spaces.items.find((entry) => entry.id === id);
    if (target !== null) {
      target.prefs = record.before?.prefs;
      target.selections = record.before?.selections ?? {};
      target.credentials = record.before?.credentials ?? target.credentials;
      target.overrides = record.before?.overrides ?? {};
    }
    spaces.settings.undo.delete(id);
    server.envelope(res, { detail: detailFor(spaces, id), applied: [] });
    return true;
  }
  const importPath = /^\/homes\/([^/]+)\/settings\/import-preferences$/.exec(path);
  if (importPath !== null && method === 'POST') {
    const id = decodeURIComponent(importPath[1]);
    const target = id === 'main' ? null : spaces.items.find((entry) => entry.id === id);
    const space = settingsFor(spaces, id);
    if (space.authority) {
      server.envelope(res, { detail: detailFor(spaces, id), imported: false, device_conflict: !same(body?.values, space.prefs) });
      return true;
    }
    if (target !== null) {
      target.prefs = { ...PROTOCOL_DEFAULTS, ...(body?.values ?? {}) };
      target.selections = Object.fromEntries(PREFERENCE_ITEMS.map((entry) => [entry.id, { mode: 'fixed', reason: 'migrated' }]));
    }
    spaces.log.push({ spaceImport: { id, device_id: body?.device_id } });
    server.envelope(res, { detail: detailFor(spaces, id), imported: true, device_conflict: false });
    return true;
  }
  return false;
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

/**
 * The home the active backend belongs to, for `/meta`'s `current_space_id`: a
 * window connected to a space's backend answers with that space's own home id,
 * and the main backend answers `main`. An unknown id is not a space this
 * process plays, so it projects the main backend.
 */
export function spaceCurrentHome(server) {
  const spaces = state(server);
  return spaces.active === 'main' || spaces.items.some((item) => item.id === spaces.active) ? spaces.active : 'main';
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

  if (handleSpaceSettings(server, res, path, method, body)) return true;

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
