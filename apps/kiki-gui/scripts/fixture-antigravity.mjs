/**
 * Fixture stand-in for the Antigravity ACP executor routes (kap-server
 * routes/antigravity.ts; shapes from packages/protocol/src/rest/antigravity.ts):
 *
 *   GET  /executors/antigravity-acp/binaries[?instance_id=...&check_updates=true&refresh_models=true]
 *   POST /executors/antigravity-acp/binaries/install  {version?, instance_id?}
 *   POST /executors/antigravity-acp/binaries/activate {version, instance_id?}
 *   POST /executors/antigravity-acp/login/start       {method_id, instance_id?, gcp_project?, gcp_location?, api_key?, force?}
 *   POST /executors/antigravity-acp/login/complete    {handle, code_or_url?, redirect_url?, instance_id?}
 *   POST /executors/antigravity-acp/login/cancel      {handle, instance_id?}
 *   POST /executors/antigravity-acp/logout            {instance_id?}
 *
 * Defaults to `agy` `1.5.11` (`official-cli`) with `latest_release` (`1.5.12`),
 * `flow_kind: 'code_paste'` (`https://antigravity.google/oauth-callback`),
 * entitled Gemini/Claude/GPT models, `auto_mode_supported: true`, and isolated
 * per-instance profiles. Mock data only.
 */

const ROOT = '/executors/antigravity-acp';
const DEFAULT_VERSION = '1.5.11';
const DEFAULT_LATEST = '1.5.12';
const RELEASE_BASE = 'https://storage.googleapis.com/antigravity-public/antigravity-cli';

const DEFAULT_MODELS = [
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', thinking_levels: ['low', 'medium', 'high'] },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash', thinking_levels: ['low', 'medium'] },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6', thinking_levels: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', thinking_levels: ['low', 'medium', 'high'] },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', thinking_levels: ['medium'] },
];

function instanceKey(instanceId) {
  return typeof instanceId === 'string' && instanceId.trim() !== '' ? instanceId.trim() : 'main';
}

function defaultProfile(seed, key) {
  const fromInstances = seed.instances?.[key];
  const signedIn = fromInstances !== undefined ? fromInstances.signed_in === true : (key === 'main' && seed.signed_in === true);
  return {
    instance_id: key === 'main' ? undefined : key,
    signed_in: signedIn,
    auth_method: fromInstances?.auth_method ?? (signedIn ? (seed.auth_method ?? 'oauth-personal') : undefined),
    account_label: fromInstances?.account_label ?? (signedIn ? (seed.account_label ?? 'alex@example.com') : undefined),
    gcp_project: fromInstances?.gcp_project ?? seed.gcp_project,
    gcp_location: fromInstances?.gcp_location ?? seed.gcp_location,
    eligibility: fromInstances?.eligibility ?? (signedIn ? (seed.eligibility ?? 'ready') : 'unknown'),
    eligibility_message: fromInstances?.eligibility_message ?? seed.eligibility_message,
    token_expired: fromInstances?.token_expired ?? seed.token_expired,
    auto_mode_supported: fromInstances?.auto_mode_supported ?? (signedIn ? (seed.auto_mode_supported ?? true) : undefined),
    models: fromInstances?.models ?? (signedIn ? (seed.models ?? structuredClone(DEFAULT_MODELS)) : []),
    commands: fromInstances?.commands ?? (signedIn ? ['/plan', '/compact', '/goal'] : []),
    checked_at: new Date().toISOString(),
  };
}

function state(server) {
  if (server.antigravity === undefined || server.antigravity.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.antigravity ?? {});
    const profiles = new Map();
    profiles.set('main', defaultProfile(seed, 'main'));
    for (const key of Object.keys(seed.instances ?? {})) {
      profiles.set(key, defaultProfile(seed, key));
    }
    server.antigravity = {
      scenario: server.scenario?.name,
      seed,
      defaultVersion: seed.release_version ?? DEFAULT_VERSION,
      latestVersion: seed.latest_version ?? DEFAULT_LATEST,
      layout: seed.layout ?? 'official-cli',
      versions: seed.versions ?? [],
      active: seed.active_version,
      phase: 'idle',
      error: undefined,
      installDelayMs: seed.install_delay_ms ?? 900,
      installHoldAt: seed.install_hold_at,
      expiresInSecs: seed.expires_in_secs ?? 300,
      profiles,
      flows: new Map(),
      counter: 0,
    };
  }
  return server.antigravity;
}

function profileFor(ag, instanceId) {
  const key = instanceKey(instanceId);
  if (!ag.profiles.has(key)) {
    ag.profiles.set(key, defaultProfile(ag.seed, key));
  }
  return ag.profiles.get(key);
}

function status(ag, instanceId, version = ag.defaultVersion) {
  const isLegacy = ag.layout === 'legacy-pair';
  const updateAvailable = ag.active !== undefined && ag.latestVersion !== undefined && ag.active !== ag.latestVersion;
  return {
    release: {
      version,
      platform: 'windows_amd64',
      url: `${RELEASE_BASE}/${version}-windows_amd64/agy.exe`,
      entry: isLegacy ? 'agy_acp_server.exe' : 'agy.exe',
      required_sibling: isLegacy ? 'localharness_external' : '',
      layout: ag.layout,
      args: ['acp'],
    },
    latest_release: ag.latestVersion === undefined ? undefined : {
      version: ag.latestVersion,
      update_available: updateAvailable,
    },
    versions: [...ag.versions],
    active_version: ag.active,
    phase: ag.phase,
    error: ag.error,
    profile: structuredClone(profileFor(ag, instanceId)),
  };
}

/** Returns true when the request was one of the Antigravity routes. */
export function handleAntigravity(server, res, path, method, body, query = new URLSearchParams()) {
  if (!path.startsWith(ROOT)) return false;
  const ag = state(server);
  const route = path.slice(ROOT.length);
  const instanceId = query?.get('instance_id') ?? body?.instance_id;

  if (route === '/binaries' && method === 'GET') {
    const profile = profileFor(ag, instanceId);
    if (query?.get('refresh_models') === 'true' && profile.signed_in) {
      profile.checked_at = new Date().toISOString();
      if (!profile.models || profile.models.length === 0) {
        profile.models = structuredClone(DEFAULT_MODELS);
      }
    }
    server.envelope(res, status(ag, instanceId));
    return true;
  }

  if (route === '/binaries/install' && method === 'POST') {
    const version = typeof body?.version === 'string' && body.version !== '' ? body.version : ag.defaultVersion;
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
      ag.active = version;
      ag.phase = 'idle';
      ag.error = undefined;
      push({ stage: 'done' });
      server.envelope(res, status(ag, instanceId, version));
    }, ag.installDelayMs);
    return true;
  }

  if (route === '/binaries/activate' && method === 'POST') {
    if (!ag.versions.includes(body?.version)) {
      server.envelope(res, null, 40404, `Antigravity ACP CLI ${body?.version} is not installed`);
      return true;
    }
    ag.active = body.version;
    server.envelope(res, status(ag, instanceId, body.version));
    return true;
  }

  if (route === '/login/start' && method === 'POST') {
    const profile = profileFor(ag, instanceId);
    const methodId = body?.method_id ?? 'oauth-personal';
    if (profile.signed_in && body?.force !== true) {
      server.envelope(res, { already_signed_in: true, instance_id: profile.instance_id, profile: structuredClone(profile) });
      return true;
    }
    if (methodId === 'gemini-api-key' || methodId === 'agent-platform') {
      profile.signed_in = true;
      profile.auth_method = methodId;
      profile.account_label = methodId === 'gemini-api-key' ? 'Gemini API key' : (body?.gcp_project || 'Vertex AI');
      profile.gcp_project = body?.gcp_project;
      profile.gcp_location = body?.gcp_location;
      profile.eligibility = 'ready';
      profile.auto_mode_supported = true;
      profile.models = structuredClone(DEFAULT_MODELS);
      profile.checked_at = new Date().toISOString();
      server.envelope(res, { already_signed_in: true, instance_id: profile.instance_id, profile: structuredClone(profile) });
      return true;
    }
    ag.counter += 1;
    const handle = `agy-login-${ag.counter}`;
    const isCodePaste = methodId === 'oauth-personal' && ag.layout !== 'legacy-pair';
    const flowKind = isCodePaste ? 'code_paste' : 'loopback_url';
    const redirectUri = isCodePaste ? 'https://antigravity.google/oauth-callback' : 'http://localhost:45289/oauth2callback';
    ag.flows.set(handle, {
      method: methodId,
      flowKind,
      instanceId,
      gcpProject: body?.gcp_project,
      gcpLocation: body?.gcp_location,
    });
    server.envelope(res, {
      already_signed_in: false,
      handle,
      method_id: methodId,
      flow_kind: flowKind,
      instance_id: profile.instance_id,
      auth_url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-antigravity&redirect_uri=${encodeURIComponent(redirectUri)}&state=${handle}`,
      redirect_uri: redirectUri,
      expires_in_secs: ag.expiresInSecs,
    });
    return true;
  }

  if (route === '/login/complete' && method === 'POST') {
    const flow = ag.flows.get(body?.handle);
    if (!flow) {
      server.envelope(res, { signed_in: false, retryable: false, message: 'This sign-in expired. Start again.' });
      return true;
    }
    const input = String(body?.code_or_url ?? body?.redirect_url ?? '').trim();
    if (input.includes('denied')) {
      ag.flows.delete(body.handle);
      server.envelope(res, { signed_in: false, retryable: false, message: 'Antigravity sign-in failed: invalid_grant', message_code: 'signin_failed' });
      return true;
    }
    if (input.includes('noplan')) {
      ag.flows.delete(body.handle);
      server.envelope(res, { signed_in: false, retryable: false, message: 'SUBSCRIPTION_REQUIRED: account not eligible', message_code: 'subscription_required' });
      return true;
    }
    const valid = flow.flowKind === 'code_paste'
      ? (input.includes('code=') || (/^[A-Za-z0-9/_-]{6,}$/.test(input) && !input.startsWith('http')))
      : input.includes('code=');
    if (!valid) {
      server.envelope(res, { signed_in: false, retryable: true, message: 'The callback does not match this pending sign-in.', message_code: 'callback_mismatch' });
      return true;
    }
    ag.flows.delete(body.handle);
    const profile = profileFor(ag, flow.instanceId ?? instanceId);
    profile.signed_in = true;
    profile.auth_method = flow.method;
    profile.account_label = flow.instanceId ? `${flow.instanceId.replace(/^instance-/, '')}@example.com` : 'alex@example.com';
    profile.gcp_project = flow.gcpProject;
    profile.gcp_location = flow.gcpLocation;
    profile.eligibility = 'ready';
    profile.token_expired = false;
    profile.auto_mode_supported = true;
    profile.models = structuredClone(DEFAULT_MODELS);
    profile.checked_at = new Date().toISOString();
    server.envelope(res, { signed_in: true, retryable: false, profile: structuredClone(profile) });
    return true;
  }

  if (route === '/login/cancel' && method === 'POST') {
    ag.flows.delete(body?.handle);
    server.envelope(res, { cancelled: true });
    return true;
  }

  if (route === '/logout' && method === 'POST') {
    const profile = profileFor(ag, instanceId);
    profile.signed_in = false;
    profile.account_label = undefined;
    profile.models = [];
    profile.auto_mode_supported = undefined;
    profile.eligibility = 'unknown';
    server.envelope(res, { signed_out: true });
    return true;
  }

  return false;
}

/** Login status the catalog reports for the engine row or multi-account instance. */
export function antigravityLogin(server, executorId = 'antigravity-acp') {
  const ag = server.antigravity;
  if (ag === undefined || ag.scenario !== server.scenario?.name) return undefined;
  const key = executorId === 'antigravity-acp' ? 'main' : executorId;
  const profile = ag.profiles.get(key);
  if (profile === undefined) return undefined;
  return profile.signed_in ? 'logged_in' : 'logged_out';
}

/**
 * `POST /executors/antigravity-acp/check` once a version is cached: the
 * binary is found (so the IDE diagnostic no longer applies) and the sign-in
 * reflects this state. Undefined before an install — the scenario's seeded
 * check (the IDE-not-CLI answer) stands.
 */
export function antigravityCheck(server, executorId = 'antigravity-acp') {
  const ag = server.antigravity;
  if (ag === undefined || ag.scenario !== server.scenario?.name || ag.active === undefined) return undefined;
  const profile = profileFor(ag, executorId === 'antigravity-acp' ? undefined : executorId);
  const entry = `C:/Users/fixture/.kiki/executors/antigravity/runtime/versions/${ag.active}/agy.exe`;
  return {
    id: executorId,
    status: profile.signed_in ? 'ready' : 'warning',
    version: ag.active,
    command: entry,
    selected_source: 'kiki-managed',
    resolved_args: ['acp'],
    login_status: profile.signed_in ? 'logged_in' : 'logged_out',
    diagnostics: [{ severity: 'info', message: `Selected source kiki-managed: ${entry}.` }],
    requirements: [{ id: executorId, label: 'Antigravity ACP CLI', role: 'program', status: 'ok', version: ag.active, path: entry }],
  };
}
