/**
 * Playwright init script that stands in for the Tauri desktop shell so the
 * spaces slice renders as it does on the desktop: `window.isTauri`, the IPC
 * bridge, and the desktop commands the GUI calls. `prepare_space` stages the
 * backend and returns its identity without reloading. After Router commit,
 * `switch_space` reloads; legacy `open_space` also enters in switch mode.
 * The local-only fixture has no pending SSH reference or notification intent.
 * `desktop_active_space` answers from the staged identity on boot.
 *
 * Usage: `await context.addInitScript(spaceDesktopMock, { fixtureUrl, token, spaces, windowMode })`.
 */
export function spaceDesktopMock({ fixtureUrl, token, spaces, windowMode }) {
  const KEY = 'kiki.proof.activeSpace';
  const PREFS = 'kiki.proof.nativePrefs';
  for (const extra of JSON.parse(sessionStorage.getItem(`${KEY}.extra`) ?? '[]')) {
    if (!spaces.some((space) => space.id === extra.id)) spaces.push(extra);
  }
  const active = () => {
    const id = sessionStorage.getItem(KEY) ?? 'main';
    const hit = spaces.find((space) => space.id === id);
    return hit === undefined || id === 'main'
      ? { homeId: 'main', name: 'Main space', path: spaces[0]?.path ?? '', credentialsShared: true }
      : { homeId: hit.id, name: hit.name, color: hit.color, path: hit.path, credentialsShared: hit.credentials !== 'isolated' };
  };
  const control = (body) => fetch(`${fixtureUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const readPrefs = () => {
    const stored = JSON.parse(localStorage.getItem(PREFS) ?? 'null');
    return stored ?? {
      notifications: true, closeToTray: true, updateChannel: 'stable', autoUpdate: 'notify',
      compatibility: { homeKind: 'kimi' }, window_mode: windowMode,
    };
  };
  const prepare = async (homeId) => {
    const response = await control({ action: 'space', id: homeId });
    const reply = await response.json();
    if (!response.ok || reply.data?.error !== undefined || reply.data?.active !== homeId) {
      throw new Error(reply.data?.error ?? `desktop mock: space ${homeId} was not prepared`);
    }
    // Remember newly created registry entries immediately and after reload.
    const known = reply.data?.space;
    if (known !== undefined && !spaces.some((space) => space.id === known.id)) {
      spaces.push(known);
      const extra = JSON.parse(sessionStorage.getItem(`${KEY}.extra`) ?? '[]');
      sessionStorage.setItem(`${KEY}.extra`, JSON.stringify([...extra, known]));
    }
    sessionStorage.setItem(KEY, homeId);
    return active();
  };
  const recordNavigation = (command, homeId, status, result) => {
    const history = window.history?.state;
    const events = JSON.parse(sessionStorage.getItem(`${KEY}.navigation`) ?? '[]');
    events.push({ command, homeId, status, result, desktop: active(), path: window.location.pathname,
      history: { idx: history?.idx, key: history?.key, nav: history?.usr?.kikiNav } });
    sessionStorage.setItem(`${KEY}.navigation`, JSON.stringify(events));
  };
  const enter = async (homeId) => {
    const space = await prepare(homeId);
    setTimeout(() => { recordNavigation('reload', homeId, 'started'); window.location.reload(); }, 50);
    return space;
  };
  const callbacks = new Map();
  let nextCallback = 1;
  const commands = {
    desktop_connection: () => ({ url: fixtureUrl, token }),
    desktop_active_space: () => active(),
    desktop_space_statuses: () => {
      const current = active().homeId;
      return spaces.map((space) => ({
        homeId: space.id,
        active: space.id === current,
        hot: space.id === current || space.hot === true || space.id === 'main',
        pendingCount: space.id === current ? 0 : (space.pending ?? 0),
        busyCount: space.busy ?? 0,
      })).filter((status) => status.hot || status.active);
    },
    prepare_space: ({ homeId }) => prepare(homeId),
    switch_space: ({ homeId }) => enter(homeId),
    open_space: ({ homeId }) => enter(homeId),
    take_scope_connection: () => null,
    take_navigation_intent: () => null,
    read_desktop_prefs: () => readPrefs(),
    write_desktop_prefs: ({ prefs }) => {
      const next = { ...readPrefs(), ...prefs };
      if (prefs.windowMode !== undefined) { next.window_mode = prefs.windowMode; delete next.windowMode; }
      localStorage.setItem(PREFS, JSON.stringify(next));
    },
    supports_desktop_updates: () => false,
    check_desktop_update: () => null,
    desktop_log_info: () => ({
      directory: spaces[0]?.path ?? 'C:/Users/example/.kiki',
      backendLogPath: `${spaces[0]?.path ?? 'C:/Users/example/.kiki'}/desktop-backend.log`,
      maxBytes: 5 * 1024 * 1024,
      backups: 3,
      logLevel: sessionStorage.getItem('kiki.proof.launchLogLevel') ?? readPrefs().logLevel ?? 'warn',
      appliesOnNextLaunch: true,
    }),
    open_desktop_log_directory: () => undefined,
    restart_server: () => ({ url: fixtureUrl, token }),
    list_ssh_profiles: () => [],
    reveal_host_path: () => undefined,
    open_host_path: () => undefined,
    open_external_url: () => undefined,
    cancel_desktop_startup: () => undefined,
    'plugin:event|listen': () => nextCallback++,
    'plugin:event|unlisten': () => undefined,
    'plugin:notification|is_permission_granted': () => true,
    'plugin:window|set_theme': () => undefined,
    'plugin:window|is_visible': () => true,
    'plugin:window|is_focused': () => true,
    'plugin:window|set_title': () => undefined,
  };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: (callback) => { const id = nextCallback++; callbacks.set(id, callback); return id; },
    unregisterCallback: (id) => { callbacks.delete(id); },
    convertFileSrc: (path) => path,
    invoke: async (cmd, args) => {
      const calls = JSON.parse(sessionStorage.getItem(`${KEY}.commands`) ?? '[]');
      calls.push({ command: cmd, homeId: args?.homeId });
      sessionStorage.setItem(`${KEY}.commands`, JSON.stringify(calls));
      const handler = commands[cmd];
      if (handler === undefined) {
        if (cmd.startsWith('plugin:')) return undefined;
        console.error(`desktop mock: no command ${cmd}`);
        throw new Error(`desktop mock: no command ${cmd}`);
      }
      const navigation = ['prepare_space', 'switch_space', 'open_space'].includes(cmd);
      if (navigation) recordNavigation(cmd, args?.homeId, 'started');
      try {
        const result = await handler(args ?? {});
        if (navigation) recordNavigation(cmd, args?.homeId, 'ok', result);
        return result;
      } catch (error) {
        if (navigation) recordNavigation(cmd, args?.homeId, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}
