/**
 * Fixture stand-in for the two-way IM session REST surface (kap-server
 * routes/imSessions.ts, klient `rest.imSessions`): the snapshot, the
 * conversation catalog, the setup catalog, the access policy, and the
 * per-account check / listen and per-binding patch / remove / test actions.
 * Everything is held in memory; nothing connects to a platform or sends a
 * message, and a check only reports the seeded account state back.
 *
 * Scenario seed (optional; a scenario without it serves an empty, allowed
 * snapshot so the page settles instead of loading forever):
 *   im: {
 *     snapshot:     ImSessionSnapshot
 *     catalog:      ImCatalog
 *     setupCatalog: ImSetupCatalog
 *   }
 */

const EMPTY_SNAPSHOT = {
  policy: { allowed: true, default_enabled: true },
  instances: [],
  discoveries: [],
  bindings: [],
  strangers: [],
  voice_fallbacks: 0,
};

export function resetImSessions(server) {
  const seed = server.scenario?.data.im ?? {};
  server.imSessions = {
    snapshot: structuredClone(seed.snapshot ?? EMPTY_SNAPSHOT),
    catalog: structuredClone(seed.catalog ?? { personas: [], sessions: [] }),
    setupCatalog: structuredClone(seed.setupCatalog ?? { platforms: [] }),
  };
}

function state(server) {
  if (server.imSessions === undefined) resetImSessions(server);
  return server.imSessions;
}

function invalid(server, res) {
  server.envelope(res, null, 40001, 'IM session request is invalid; reload and retry.');
  return true;
}

export function handleImSessions(server, res, path, method, body) {
  if (path !== '/im/sessions' && !path.startsWith('/im/sessions/')) return false;
  const store = state(server);
  const { snapshot } = store;
  const ok = (data) => { server.envelope(res, data); return true; };

  if (path === '/im/sessions' && method === 'GET') return ok(structuredClone(snapshot));
  if (path === '/im/sessions/catalog' && method === 'GET') return ok(structuredClone(store.catalog));
  if (path === '/im/sessions/setup' && method === 'GET') return ok(structuredClone(store.setupCatalog));
  if (path === '/im/sessions/policy' && method === 'PUT') {
    if (typeof body?.allowed !== 'boolean') return invalid(server, res);
    snapshot.policy = structuredClone(body);
    return ok(structuredClone(snapshot));
  }

  const instance = /^\/im\/sessions\/instances\/([^/]+)\/(check|listen)$/u.exec(path);
  if (instance !== null && method === 'POST') {
    const account = snapshot.instances.find((item) => item.id === decodeURIComponent(instance[1]));
    if (account === undefined) return invalid(server, res);
    if (instance[2] === 'listen') {
      if (typeof body?.listening !== 'boolean') return invalid(server, res);
      Object.assign(account, { listening: body.listening, adapter: body.listening ? 'running' : 'stopped', connection: undefined, connection_detail: undefined });
      return ok(structuredClone(snapshot));
    }
    return ok({ ok: account.connection !== 'auth_expired', account_id: account.account_id ?? account.id });
  }

  const binding = /^\/im\/sessions\/bindings\/([^/]+)(\/test)?$/u.exec(path);
  if (binding !== null) {
    const id = decodeURIComponent(binding[1]);
    const index = snapshot.bindings.findIndex((item) => item.id === id);
    if (index < 0) return invalid(server, res);
    if (binding[2] === '/test' && method === 'POST') {
      const row = snapshot.bindings[index];
      const account = snapshot.instances.find((item) => item.id === row.provider_instance_id);
      const connected = account !== undefined && account.listening && account.adapter !== 'stopped' && account.adapter !== 'missing';
      return ok(connected
        ? { binding_id: id, status: 'delivered', message_ids: [] }
        : { binding_id: id, status: 'failed', message_ids: [], detail: 'channel_not_connected' });
    }
    if (binding[2] === undefined && method === 'PATCH') {
      snapshot.bindings[index] = { ...snapshot.bindings[index], ...structuredClone(body ?? {}) };
      return ok(structuredClone(snapshot));
    }
    if (binding[2] === undefined && method === 'DELETE') {
      snapshot.bindings.splice(index, 1);
      return ok(structuredClone(snapshot));
    }
  }
  return false;
}
