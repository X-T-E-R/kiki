/**
 * Fixture stand-in for the browser REST surface (kap-server routes/browser.ts;
 * contracts: packages/protocol/src/rest/browser.ts and rest/browser-setup.ts).
 * Wired routes only: the named setup presets, the connection list with each
 * connection's status, defaults, upsert, remove, and the status / check /
 * connect / disconnect actions.
 *
 * The status model mirrors `agent-core-v2/src/app/browser/browserControlService.ts`:
 * `idle` until something is live, `ready` once the driver answered, `running`
 * while a call is in flight, `stopping` / `disconnected` around a close, and
 * `unconfirmed` when the close was acknowledged but the daemon was not
 * confirmed gone. Nothing here invents a driver version or a session name that
 * the page could not have received from the real service.
 *
 * The preset model mirrors `browserSetupService.ts`: two managed routes report
 * their own steps and action list, the native flag gate appears as a `feature`
 * step with an `enable_feature` action, and the external route is never
 * supported — it offers its documentation and nothing else.
 *
 * Scenario seeds (all optional):
 *   browser: {
 *     defaultBrowser?: string,
 *     presets?: {                       // browser.setup[preset] overrides
 *       [preset]: { state?, error?, steps?, omitAction?, connectionId? }
 *     },
 *     connections: [{
 *       id, name, enabled, type,
 *       profilePath?, executablePath?, driverPath?, headed?,   // agent-browser-profile
 *       endpoint?,                                    // agent-browser-cdp (never returned)
 *       status: { state, generation, ... },           // what the service reports
 *       tabs?: [{ tabId, targetId, title?, url?, active?, label? }],  // the daemon's own list
 *       catalog?: [{ name, description, group?, surface?, inputSchema? }],  // backend tools
 *       check?: { state, error },                     // what check answers instead
 *       connect?: { state, error },                   // what connect answers instead
 *       disconnect?: { state, error },                // what disconnect answers instead
 *       remove?: { code, msg },                       // makes remove fail
 *       upsert?: { code, msg },                       // makes upsert fail
 *     }]
 *   }
 *
 * A `check` / `connect` / `disconnect` seed carrying `msg` refuses the call the
 * way `remove` and `upsert` already do, instead of answering with a status; a
 * `details` next to it is the structured browser failure the real route
 * forwards (`packages/protocol/src/rest/browser.ts` `browserFailureSchema`).
 *
 * `tabs` answers only while the connection is live, and says
 * `browser.disconnected` otherwise — the real service refuses instead of
 * returning an empty list. `catalog` returns `inputSchema` only for
 * `?includeSchema=true`.
 *
 * `executionHost` defaults to the scenario's `host` or 'fixture-browser-host'.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATES = ['idle', 'connecting', 'ready', 'running', 'stopping', 'disconnected', 'failed', 'unconfirmed'];
/** States in which the daemon exists and can be asked for its targets. */
const LIVE = new Set(['connecting', 'ready', 'running', 'stopping', 'unconfirmed']);

function state(server) {
  if (server.browser === undefined || server.browser.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.browser ?? {});
    server.browser = {
      scenario: server.scenario?.name,
      host: server.scenario?.data.host ?? 'fixture-browser-host',
      connections: seed.connections ?? [],
      defaultBrowser: seed.defaultBrowser,
      overrides: structuredClone(seed.presets ?? {}),
    };
  }
  return server.browser;
}

/** The record as the REST surface returns it: no endpoint, only its redacted projection. */
function record(entry, host) {
  const common = { id: entry.id, name: entry.name, enabled: entry.enabled, type: entry.type };
  const status = { executionHost: host, generation: 0, ...entry.status, browser: entry.id };
  if (entry.type === 'agent-browser-cdp') {
    let display;
    try {
      const url = new URL(entry.endpoint);
      display = `${url.protocol}//${url.host}`;
    } catch {
      display = undefined;
    }
    return {
      ...common, driverPath: entry.driverPath, endpointDisplay: display, endpointConfigured: entry.endpoint !== undefined,
      status,
    };
  }
  return {
    ...common, driverPath: entry.driverPath, profilePath: entry.profilePath, executablePath: entry.executablePath,
    headed: entry.headed,
    status,
  };
}

function find(browser, id) {
  return browser.connections.find((entry) => entry.id === id);
}

const KIMI_STORE = { id: 'install_extension', url: 'https://chromewebstore.google.com/detail/kimi-webbridge/example', target: 'chrome' };
const EDGE_STORE = { id: 'install_extension', url: 'https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/example', target: 'edge' };
const KIMI_HELP = 'https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction';
const CODEX_HELP = 'https://developers.openai.com/codex/app/chrome-extension';

/** The routes the wizard reads, in the server's own order and shapes. */
const PRESETS = {
  'kimi-webbridge': {
    preset: 'kimi-webbridge',
    displayName: 'Kimi Browser Extension',
    controlSurface: 'plugin-skill',
    pluginId: 'kimi-webbridge',
    skill: 'kimi-webbridge',
    capabilityId: 'kimi-webbridge',
    sourceUrl: KIMI_HELP,
    steps: [
      { id: 'daemon-binary', state: 'ready' },
      { id: 'daemon', state: 'ready' },
      { id: 'skill', state: 'ready' },
      { id: 'extension', state: 'user_action', reason: 'extension_not_connected',
        detail: 'Browser extension is not connected (installation cannot be inferred)' },
    ],
    actions: [{ id: 'prepare' }, { id: 'connect' }, KIMI_STORE, EDGE_STORE, { id: 'open_instructions', url: KIMI_HELP, target: 'documentation' }],
  },
  'independent-browser': {
    preset: 'independent-browser',
    displayName: 'Independent browser',
    controlSurface: 'browser-connection',
    capabilityId: 'kiki-browser',
    sourceUrl: 'https://github.com/vercel-labs/agent-browser',
    steps: [{ id: 'driver', state: 'ready' }, { id: 'chrome', state: 'ready' }],
    actions: [{ id: 'prepare' }, { id: 'connect' }],
  },
  'codex-browser': {
    preset: 'codex-browser',
    displayName: 'Codex / ChatGPT browser extension',
    controlSurface: 'external-app',
    supported: false,
    state: 'external_only',
    reason: 'external_app_required',
    sourceUrl: CODEX_HELP,
    steps: [{ id: 'desktop-app', state: 'user_action', reason: 'external_app_required' }],
    actions: [{ id: 'open_instructions', url: CODEX_HELP, target: 'documentation' }],
  },
};

/**
 * A preset as the list returns it. The managed routes take their readiness from
 * what is actually installed on this fixture host, so a scenario says "the
 * extension is missing" and the page draws a missing step rather than a seed
 * that claims a state the fixture has no evidence for.
 */
function presetStatus(browser, seed) {
  const base = PRESETS[seed];
  const override = browser.overrides?.[base.preset] ?? {};
  const steps = override.steps ?? base.steps;
  const state = override.state ?? (override.error !== undefined ? 'failed' : 'not_prepared');
  const flagOff = steps.some((step) => step.reason === 'feature_disabled');
  const served = base.actions.filter((action) => override.omitAction !== action.id);
  const actions = state === 'preparing'
    ? served.filter((action) => action.id === 'cancel')
    : flagOff && served.some((action) => action.id === 'connect')
      ? [...served, { id: 'enable_feature' }]
      : served;
  const common = {
    supported: base.supported ?? true,
    executionHost: browser.host,
    steps,
    actions,
    connectionId: override.connectionId,
    error: override.error,
  };
  if (base.controlSurface === 'external-app') {
    return { ...base, executionHost: browser.host, ...common };
  }
  return {
    preset: base.preset,
    displayName: base.displayName,
    controlSurface: base.controlSurface,
    state,
    sourceUrl: base.sourceUrl,
    pluginId: base.pluginId,
    skill: base.skill,
    capabilityId: base.capabilityId,
    ...common,
  };
}

function handleSetup(server, browser, res, path, method, body) {
  const isList = path === '/browser/setup';
  const one = isList ? null : /^\/browser\/setup\/([^/:]+)$/.exec(path);
  const action = /^\/browser\/setup\/([^/:]+):(prepare|connect|cancel)$/.exec(path);
  if (!isList && one === null && action === null) return false;

  if (isList) {
    server.envelope(res, { presets: Object.keys(PRESETS).map((id) => presetStatus(browser, id)) });
    return true;
  }
  if (one !== null) {
    const id = decodeURIComponent(one[1]);
    if (!Object.hasOwn(PRESETS, id)) { server.envelope(res, null, 40001, 'Unknown browser setup preset'); return true; }
    server.envelope(res, presetStatus(browser, id));
    return true;
  }
  const id = decodeURIComponent(action[1]);
  if (!Object.hasOwn(PRESETS, id)) { server.envelope(res, null, 40001, 'Unknown browser setup preset'); return true; }
  const name = action[2];
  const override = browser.overrides?.[id] ?? {};
  if (name === 'prepare') {
    if (body?.consent !== true) { server.envelope(res, null, 40001, 'Confirm installation and plugin enablement before preparing browser access'); return true; }
    if (override.prepareError !== undefined) {
      server.envelope(res, null, 40001, override.prepareError);
      return true;
    }
    browser.overrides = { ...browser.overrides, [id]: { ...override, state: 'ready', prepareError: undefined } };
    server.envelope(res, presetStatus(browser, id));
    return true;
  }
  if (name === 'connect') {
    if (override.state !== 'ready' && override.state !== 'connected') { server.envelope(res, presetStatus(browser, id)); return true; }
    if (id === 'independent-browser') {
      if (find(browser, 'independent-browser') === undefined) {
        browser.connections = [...browser.connections, {
          id: 'independent-browser', name: 'Independent browser', enabled: true, type: 'agent-browser-profile',
          headed: true, status: { state: 'ready', generation: 1 },
        }];
      }
      browser.overrides = { ...browser.overrides, [id]: { ...override, state: 'connected' } };
      server.envelope(res, { ...presetStatus(browser, id), connectionId: 'independent-browser' });
      return true;
    }
    browser.overrides = { ...browser.overrides, [id]: { ...override, state: 'connected', checkedAt: new Date().toISOString() } };
    server.envelope(res, presetStatus(browser, id));
    return true;
  }
  browser.overrides = { ...browser.overrides, [id]: { ...override, state: 'not_prepared' } };
  server.envelope(res, presetStatus(browser, id));
  return true;
}

function valid(status) {
  return typeof status === 'object' && status !== null && STATES.includes(status.state);
}

/** The endpoint secret for the reveal route; never part of any list. */
export function browserEndpointSecret(server, id) {
  const entry = find(state(server), id);
  return entry?.type === 'agent-browser-cdp' ? entry.endpoint : undefined;
}

/** Returns true when the request was handled. */
export function handleBrowser(server, res, path, query, method, body) {
  const browser = state(server);
  const list = () => browser.connections.map((entry) => record(entry, browser.host));

  if (handleSetup(server, browser, res, path, method, body)) return true;

  if (path === '/browser/connections' && method === 'GET') {
    server.envelope(res, { connections: list(), defaultBrowser: browser.defaultBrowser });
    return true;
  }
  if (path === '/browser/default' && method === 'PUT') {
    const next = body?.browser;
    if (next !== undefined && !ID.test(String(next))) { server.envelope(res, null, 40001, 'Invalid browser connection id'); return true; }
    if (next !== undefined && find(browser, next)?.enabled !== true) {
      server.envelope(res, null, 40001, `Browser connection "${String(next)}" is disabled`, { code: 'browser.disabled', reason: 'connection_disabled' });
      return true;
    }
    browser.defaultBrowser = next;
    server.envelope(res, { browser: next });
    return true;
  }

  const actionMatch = /^\/browser\/connections\/([^/:]+):(status|tabs|catalog|check|connect|disconnect)$/.exec(path);
  const plainMatch = /^\/browser\/connections\/([^/]+)$/.exec(path);
  const id = decodeURIComponent((actionMatch ?? plainMatch)?.[1] ?? '');
  const entry = id === '' ? undefined : find(browser, id);
  if (actionMatch !== null || plainMatch !== null) {
    if (!ID.test(id) || entry === undefined) { server.envelope(res, null, 40424, `Unknown browser connection "${id}"`); return true; }
  }
  if (actionMatch !== null) {
    const action = actionMatch[2];
    if (!['status', 'check', 'connect', 'disconnect', 'tabs', 'catalog'].includes(action)) { server.envelope(res, null, 40001, 'Unsupported browser connection action'); return true; }
    if (method !== (action === 'check' || action === 'connect' || action === 'disconnect' ? 'POST' : 'GET')) { server.envelope(res, null, 40001, 'Unsupported browser connection action'); return true; }
    // Tabs read the connected daemon and never attach or launch; a connection
    // that is not live answers with the service's own `browser.disconnected`,
    // not with an empty list.
    if (action === 'tabs') {
      if (!LIVE.has(entry.status?.state)) {
        server.envelope(res, null, 40001, `Browser connection is ${entry.status?.state ?? 'idle'}; explicitly connect it before operating`, { code: 'browser.disconnected' });
        return true;
      }
      server.envelope(res, { browser: id, status: record(entry, browser.host).status, tabs: entry.tabs ?? [] });
      return true;
    }
    // The catalogue may open the managed backend and its isolated
    // configuration; schemas are opt-in through `includeSchema=true`.
    if (action === 'catalog') {
      const capabilities = entry.catalog ?? [];
      const withSchemas = query?.get?.('includeSchema') === 'true';
      server.envelope(res, {
        browser: id, status: record(entry, browser.host).status, backendToolCount: capabilities.length,
        contextIsolation: 'opaque-context-through-window',
        capabilities: capabilities.map((capability) => ({
          name: capability.name, description: capability.description,
          group: capability.group ?? 'page', surface: capability.surface ?? 'operation',
          inputSchema: withSchemas ? capability.inputSchema : undefined,
        })),
      });
      return true;
    }
    const override = action === 'status' ? undefined : entry[action];
    // `{ code, msg }` is a refusal, the way `remove` and `upsert` seeds read;
    // `details` is the structured browser failure the real route forwards.
    if (override?.msg !== undefined) { server.envelope(res, null, override.code ?? 40001, override.msg, override.details); return true; }
    if (override !== undefined) {
      entry.status = { ...entry.status, ...override, browser: id };
    } else if (action === 'connect') {
      entry.status = {
        ...entry.status, browser: id, state: 'ready', generation: (entry.status?.generation ?? 0) + 1,
        checkedAt: new Date().toISOString(), error: undefined,
        driverVersion: entry.driverVersion, runtimeSession: entry.runtimeSession ?? `browser-${id}-session`,
        profilePath: entry.type === 'agent-browser-profile' ? entry.profilePath : undefined,
      };
    } else if (action === 'disconnect') {
      entry.status = {
        ...entry.status, browser: id, state: 'disconnected', generation: (entry.status?.generation ?? 0) + 1,
        checkedAt: new Date().toISOString(), error: undefined,
      };
    } else if (action === 'check') {
      entry.status = { ...entry.status, browser: id, checkedAt: new Date().toISOString() };
    }
    if (!valid(entry.status)) { server.envelope(res, null, 50001, 'fixture: browser status seed is not a service state'); return true; }
    server.envelope(res, record(entry, browser.host).status);
    return true;
  }

  if (plainMatch !== null && method === 'PUT') {
    if (entry?.upsert !== undefined) { server.envelope(res, null, entry.upsert.code ?? 40001, entry.upsert.msg ?? 'browser.invalid'); return true; }
    if (typeof body?.name !== 'string' || body.name.trim() === '') { server.envelope(res, null, 40001, 'browser.invalid'); return true; }
    const next = { ...(entry ?? { id, status: { state: 'idle', generation: 0 } }), id, name: body.name.trim(), enabled: body.enabled !== false, type: body.type, driverPath: body.driverPath };
    if (body.type === 'agent-browser-cdp') {
      const endpoint = body.endpoint?.action === 'set' ? body.endpoint.value : entry?.endpoint;
      // The store refuses a CDP connection with no endpoint at all.
      if (typeof endpoint !== 'string' || endpoint === '') { server.envelope(res, null, 40001, 'A CDP endpoint is required for a new connection'); return true; }
      next.endpoint = endpoint;
      next.profilePath = undefined;
      next.executablePath = undefined;
      next.headed = undefined;
    } else {
      next.profilePath = body.profilePath;
      next.executablePath = body.executablePath;
      next.headed = body.headed === true ? true : undefined;
      next.endpoint = undefined;
    }
    browser.connections = [...browser.connections.filter((candidate) => candidate.id !== id), next];
    server.envelope(res, { connection: record(next, browser.host) });
    return true;
  }
  if (plainMatch !== null && method === 'DELETE') {
    if (entry?.remove !== undefined) { server.envelope(res, null, entry.remove.code ?? 40901, entry.remove.msg ?? 'browser.busy'); return true; }
    browser.connections = browser.connections.filter((candidate) => candidate.id !== id);
    if (browser.defaultBrowser === id) browser.defaultBrowser = undefined;
    server.envelope(res, { removed: true });
    return true;
  }
  return false;
}
