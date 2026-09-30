/**
 * Fixture stand-in for the Antigravity ACP executor routes (kap-server
 * routes/antigravity.ts; shapes from packages/protocol/src/rest/antigravity.ts):
 *
 *   GET  /executors/antigravity-acp/binaries
 *   POST /executors/antigravity-acp/binaries/install  {version?}
 *   POST /executors/antigravity-acp/binaries/activate {version}
 *   POST /executors/antigravity-acp/login/start       {method_id}
 *   POST /executors/antigravity-acp/login/complete    {handle, redirect_url}
 *   POST /executors/antigravity-acp/login/cancel      {handle}
 *   POST /executors/antigravity-acp/logout            {}
 *
 * Scenario seed `antigravity` (optional):
 *   { versions, active_version, signed_in, install_delay_ms, expires_in_secs }
 * A pasted redirect URL containing `code=` signs in; `code=denied` answers
 * the vendor rejection (`message_code: signin_failed`) and anything else a
 * callback mismatch (`message_code: callback_mismatch`), like the real service.
 * An install pushes `event.executor.antigravity_install_progress` steps
 * (download bytes, extract, activate, done) over the klient events socket;
 * `install_hold_at` in the seed parks it at that many bytes for screenshots.
 * Mock data only.
 */

const ROOT = '/executors/antigravity-acp';
const RELEASE_BASE = 'https://edgedl.me.gvt1.com/edgedl/release2/antigravity-acp';

function state(server) {
  if (server.antigravity === undefined || server.antigravity.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.antigravity ?? {});
    server.antigravity = {
      scenario: server.scenario?.name,
      versions: seed.versions ?? [],
      active: seed.active_version,
      signedIn: seed.signed_in === true,
      phase: 'idle',
      error: undefined,
      installDelayMs: seed.install_delay_ms ?? 900,
      installHoldAt: seed.install_hold_at,
      expiresInSecs: seed.expires_in_secs ?? 300,
      flows: new Map(),
      counter: 0,
    };
  }
  return server.antigravity;
}

function status(ag, version = '1.2.1') {
  return {
    release: {
      version, platform: 'windows-x64', url: `${RELEASE_BASE}/${version}/windows-x64/agy_acp_server.zip`,
      entry: 'agy_acp_server.exe', required_sibling: 'localharness_external', args: [],
    },
    versions: [...ag.versions], active_version: ag.active, phase: ag.phase, error: ag.error,
  };
}

/** Returns true when the request was one of the Antigravity routes. */
export function handleAntigravity(server, res, path, method, body) {
  if (!path.startsWith(ROOT)) return false;
  const ag = state(server);
  const route = path.slice(ROOT.length);
  if (route === '/binaries' && method === 'GET') {
    server.envelope(res, status(ag));
    return true;
  }
  if (route === '/binaries/install' && method === 'POST') {
    const version = typeof body?.version === 'string' && body.version !== '' ? body.version : '1.2.1';
    if (!/^1\.\d+\.\d+$/.test(version)) {
      server.envelope(res, null, 40001, `Antigravity ACP CLI ${version} is not a 1.x release`);
      return true;
    }
    ag.phase = 'installing';
    const installId = `agy-install-${++ag.counter}`;
    const push = (step) => server.klient?.emitGlobal('event.executor.antigravity_install_progress', { installId, version, ...step });
    const totalBytes = 48_234_496;
    const ticks = 8;
    const tick = Math.max(20, Math.floor(ag.installDelayMs / (ticks + 2)));
    for (let n = 0; n <= ticks; n++) {
      const receivedBytes = Math.floor((totalBytes * n) / ticks);
      setTimeout(() => { if (ag.installHoldAt === undefined || receivedBytes <= ag.installHoldAt) push({ stage: 'download', receivedBytes, totalBytes }); }, tick * n);
    }
    if (ag.installHoldAt !== undefined) return true;
    setTimeout(() => { push({ stage: 'extract' }); }, tick * (ticks + 1));
    setTimeout(() => {
      push({ stage: 'activate' });
      if (!ag.versions.includes(version)) ag.versions = [...ag.versions, version].sort();
      ag.active = ag.active ?? version;
      ag.phase = 'idle';
      ag.error = undefined;
      push({ stage: 'done' });
      server.envelope(res, status(ag, version));
    }, ag.installDelayMs);
    return true;
  }
  if (route === '/binaries/activate' && method === 'POST') {
    if (!ag.versions.includes(body?.version)) {
      server.envelope(res, null, 40404, `Antigravity ACP CLI ${body?.version} is not installed`);
      return true;
    }
    ag.active = body.version;
    server.envelope(res, status(ag, body.version));
    return true;
  }
  if (route === '/login/start' && method === 'POST') {
    if (ag.signedIn) {
      server.envelope(res, { already_signed_in: true });
      return true;
    }
    ag.counter += 1;
    const handle = `agy-login-${ag.counter}`;
    ag.flows.set(handle, { method: body?.method_id ?? 'oauth-personal' });
    server.envelope(res, {
      already_signed_in: false, handle, method_id: body?.method_id ?? 'oauth-personal',
      auth_url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-antigravity&state=${handle}`,
      redirect_uri: 'http://localhost:45289/oauth2callback', expires_in_secs: ag.expiresInSecs,
    });
    return true;
  }
  if (route === '/login/complete' && method === 'POST') {
    if (!ag.flows.has(body?.handle)) {
      server.envelope(res, { signed_in: false, retryable: false, message: 'This sign-in expired. Start again.' });
      return true;
    }
    if (String(body?.redirect_url ?? '').includes('code=denied')) {
      ag.flows.delete(body.handle);
      server.envelope(res, { signed_in: false, retryable: false, message: 'Antigravity sign-in failed: invalid_grant', message_code: 'signin_failed' });
      return true;
    }
    if (!String(body?.redirect_url ?? '').includes('code=')) {
      server.envelope(res, { signed_in: false, retryable: true, message: 'The callback does not match this pending sign-in.', message_code: 'callback_mismatch' });
      return true;
    }
    ag.flows.delete(body.handle);
    ag.signedIn = true;
    server.envelope(res, { signed_in: true, retryable: false });
    return true;
  }
  if (route === '/login/cancel' && method === 'POST') {
    ag.flows.delete(body?.handle);
    server.envelope(res, { cancelled: true });
    return true;
  }
  if (route === '/logout' && method === 'POST') {
    ag.signedIn = false;
    server.envelope(res, { signed_out: true });
    return true;
  }
  return false;
}

/** Login status the catalog reports for the engine row. */
export function antigravityLogin(server) {
  const ag = server.antigravity;
  return ag === undefined || ag.scenario !== server.scenario?.name ? undefined : ag.signedIn ? 'logged_in' : 'logged_out';
}

/**
 * `POST /executors/antigravity-acp/check` once a version is cached: the
 * binary is found (so the IDE diagnostic no longer applies) and the sign-in
 * reflects this state. Undefined before an install — the scenario's seeded
 * check (the IDE-not-CLI answer) stands.
 */
export function antigravityCheck(server) {
  const ag = server.antigravity;
  if (ag === undefined || ag.scenario !== server.scenario?.name || ag.active === undefined) return undefined;
  const entry = `C:/Users/fixture/.kiki/tools/antigravity-acp/${ag.active}/windows-x64/agy_acp_server.exe`;
  return {
    id: 'antigravity-acp', status: ag.signedIn ? 'ready' : 'warning', version: ag.active, command: entry,
    selected_source: 'kiki-cache', resolved_args: [], login_status: ag.signedIn ? 'logged_in' : 'logged_out',
    diagnostics: [{ severity: 'info', message: `Selected source kiki-cache: ${entry}.` }],
    requirements: [{ id: 'antigravity-acp', label: 'Antigravity ACP CLI', role: 'program', status: 'ok', version: ag.active, path: entry }],
  };
}
