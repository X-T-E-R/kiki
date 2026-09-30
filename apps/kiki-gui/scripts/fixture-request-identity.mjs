/**
 * Fixture stand-in for the request identity routes (kap-server
 * routes/requestIdentity.ts): catalog read, profile duplicate / replace /
 * delete, track check / apply / dismiss / rollback / reset / pin, manifest
 * URL, and preview. Writes mutate scenario state so the page's edit, staging
 * and rollback paths are exercisable.
 *
 * Scenario seed (optional):
 *   requestIdentity: { catalog, checks?: { [track]: { [source]: revision | { error } } }, previews?: { [profileId]: { [protocol]: preview } } }
 *
 * Template rendering is NOT simulated: a preview for a custom profile or an
 * unsaved draft substitutes `{version}` and a fixed host into its own
 * templates and appends the seeded lineage headers; the GUI is under test.
 */

const HOST = { os_type: 'Windows', os_version: '10.0.26100', arch: 'x86_64', platform: 'win32', node_arch: 'x64', stainless_os: 'Windows', stainless_arch: 'x64', grok_os: 'windows', grok_arch: 'x86_64', kiki_version: '0.9.0', model: 'example-model' };

/** Reset hook: the fixture server calls this from `loadScenario`. */
export function resetRequestIdentity(server, data) {
  const seed = data.requestIdentity;
  server.requestIdentity = seed === undefined ? undefined : {
    catalog: structuredClone(seed.catalog),
    checks: structuredClone(seed.checks ?? {}),
    previews: structuredClone(seed.previews ?? {}),
    lineage: structuredClone(seed.lineage ?? {}),
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function render(template, version) {
  return template.replaceAll(/\{([a-z_]+)\}/gu, (whole, name) => (name === 'version' ? version : HOST[name] ?? whole));
}

function versionOf(state, profile) {
  if (profile.version.mode === 'fixed') return { version: profile.version.value, origin: 'fixed' };
  const track = state.catalog.tracks.find((candidate) => candidate.id === profile.track);
  if (profile.version.mode === 'track' && track !== undefined) return { version: track.current.version, origin: `track:${track.current.origin}` };
  return { version: HOST.kiki_version, origin: 'kiki' };
}

function previewOf(state, profile, protocol) {
  const seeded = profile.id === undefined ? undefined : state.previews[profile.id]?.[protocol];
  if (seeded !== undefined) return structuredClone(seeded);
  const { version, origin } = versionOf(state, profile);
  const lineage = state.lineage[profile.base_preset] ?? {};
  if (lineage.unsupported?.includes(protocol)) {
    return { headers: [], params: {}, version, version_origin: origin, suppressed_user_agent: false, error: lineage.error };
  }
  const headers = [];
  if (profile.user_agent !== '') headers.push({ name: 'User-Agent', value: render(profile.user_agent, version), kind: 'static', origin: 'profile' });
  for (const header of profile.headers) {
    if (header.value !== '') headers.push({ name: header.name, value: render(header.value, version), kind: 'static', origin: 'profile' });
  }
  for (const header of lineage.headers ?? []) headers.push({ ...header, kind: header.kind ?? 'per_request', origin: 'lineage' });
  const params = Object.fromEntries(profile.params.map((param) => [param.name, typeof param.value === 'string' ? render(param.value, version) : param.value]));
  Object.assign(params, lineage.params?.[protocol] ?? {});
  return { headers, params, version, version_origin: origin, suppressed_user_agent: profile.base_preset === 'none' };
}

export async function handleRequestIdentity(server, req, res, path) {
  if (!path.startsWith('/request-identity')) return false;
  if (server.requestIdentity === undefined) resetRequestIdentity(server, server.scenario?.data ?? {});
  const state = server.requestIdentity;
  const method = req.method ?? 'GET';
  const ok = (data) => { server.envelope(res, data); return true; };
  const fail = (code, msg) => { server.envelope(res, null, code, msg); return true; };
  if (state === undefined) return fail(40426, 'fixture: no request identity seed');
  const catalog = state.catalog;
  const now = () => new Date().toISOString();

  if (path === '/request-identity' && method === 'GET') return ok(structuredClone(catalog));
  if (path === '/request-identity/preview' && method === 'POST') {
    const body = await readJson(req);
    const profile = body.draft ?? catalog.profiles.find((candidate) => candidate.id === body.profile);
    if (profile === undefined) return fail(40426, `request identity ${String(body.profile)} does not exist`);
    return ok(previewOf(state, profile, body.protocol));
  }
  if (path === '/request-identity/profiles' && method === 'POST') {
    const body = await readJson(req);
    const source = catalog.profiles.find((candidate) => candidate.id === body.from);
    if (source === undefined) return fail(40426, `request identity ${String(body.from)} does not exist`);
    const stem = source.id.replace(/^custom:/u, '');
    let n = 1;
    while (catalog.profiles.some((candidate) => candidate.id === `custom:${stem}-${String(n)}`)) n += 1;
    catalog.profiles.push({ ...structuredClone(source), id: `custom:${stem}-${String(n)}`, builtin: false, label: body.label ?? `${source.label} (copy)`, duplicated_from: source.id, created_at: now(), updated_at: now() });
    return ok(structuredClone(catalog));
  }
  const profileMatch = /^\/request-identity\/profiles\/([^/]+)$/u.exec(path);
  if (profileMatch !== null) {
    const id = decodeURIComponent(profileMatch[1]);
    const index = catalog.profiles.findIndex((candidate) => candidate.id === id);
    if (index === -1) return fail(40426, `request identity ${id} does not exist`);
    if (catalog.profiles[index].builtin) return fail(40001, 'built-in identities are read-only; duplicate one to edit it');
    if (method === 'PUT') {
      const draft = await readJson(req);
      const unknown = [...JSON.stringify(draft).matchAll(/\{([a-z_]+)\}/gu)].map((match) => match[1]).find((name) => name !== 'version' && !(name in HOST));
      if (unknown !== undefined) return fail(40001, `unknown template variable {${unknown}}`);
      catalog.profiles[index] = { ...catalog.profiles[index], ...draft, updated_at: now() };
      return ok(structuredClone(catalog));
    }
    if (method === 'DELETE') {
      const users = catalog.usage.filter((row) => row.authored?.profile === id);
      if (users.length > 0) return fail(40947, `identity ${id} is still used by ${users.map((row) => row.label).join(', ')}`);
      catalog.profiles.splice(index, 1);
      return ok(structuredClone(catalog));
    }
  }
  if (path === '/request-identity/manifest' && method === 'PUT') {
    catalog.manifest_url = (await readJson(req)).url;
    return ok(structuredClone(catalog));
  }
  const trackMatch = /^\/request-identity\/tracks\/([a-z_]+)\/(check|apply|dismiss|rollback|reset|pin)$/u.exec(path);
  if (trackMatch === null) return false;
  const track = catalog.tracks.find((candidate) => candidate.id === trackMatch[1]);
  if (track === undefined) return fail(40426, `request identity ${trackMatch[1]} does not exist`);
  const action = trackMatch[2];
  const body = await readJson(req);
  const refuse = (verb) => fail(40001, `unpin the track before ${verb}`);
  if (action === 'check') {
    const outcome = state.checks[track.id]?.[body.source];
    const at = now();
    if (outcome === undefined || outcome.error !== undefined) {
      track.last_check = { source: body.source, at, ok: false, error: outcome?.error ?? 'no answer' };
    } else {
      track.last_check = { source: body.source, at, ok: true, version: outcome.version };
      track.candidate = outcome.version === track.current.version ? null : { ...outcome, at };
    }
  } else if (action === 'apply') {
    if (track.pinned) return refuse('applying an update');
    if (track.candidate?.version !== body.version) return fail(40947, 'the checked version changed; check again');
    track.history.unshift(track.current);
    track.current = { ...track.candidate, at: now() };
    track.candidate = null;
  } else if (action === 'dismiss') {
    track.candidate = null;
  } else if (action === 'rollback') {
    if (track.pinned) return refuse('rolling back');
    const previous = track.history.shift();
    if (previous === undefined) return fail(40001, 'there is no earlier version to roll back to');
    track.current = previous;
  } else if (action === 'reset') {
    if (track.pinned) return refuse('resetting it');
    if (track.current.origin !== 'builtin') track.history.unshift(track.current);
    track.current = structuredClone(track.builtin);
  } else if (action === 'pin') {
    track.pinned = body.pinned === true;
  }
  return ok(structuredClone(catalog));
}
