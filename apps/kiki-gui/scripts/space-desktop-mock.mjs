/**
 * Playwright init script that stands in for the Tauri desktop shell so the
 * spaces slice renders as it does on the desktop: `window.isTauri`, the IPC
 * bridge, and the desktop commands the GUI calls. Space switching mirrors the
 * native contract: `switch_space` / `open_space` (switch mode) tell the
 * fixture which space's backend is active, remember the space in
 * sessionStorage, and reload the page; `desktop_active_space` answers from
 * that memory on boot.
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
  const enter = async (homeId) => {
    const reply = await (await control({ action: 'space', id: homeId })).json();
    // Spaces created during the walk are not in the seed; remember them.
    const known = reply.data?.space;
    if (known !== undefined && !spaces.some((space) => space.id === known.id)) {
      const extra = JSON.parse(sessionStorage.getItem(`${KEY}.extra`) ?? '[]');
      sessionStorage.setItem(`${KEY}.extra`, JSON.stringify([...extra, known]));
    }
    sessionStorage.setItem(KEY, homeId);
    setTimeout(() => { window.location.reload(); }, 50);
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
    switch_space: ({ homeId }) => enter(homeId),
    open_space: ({ homeId }) => enter(homeId),
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
      const handler = commands[cmd];
      if (handler === undefined) {
        if (cmd.startsWith('plugin:')) return undefined;
        throw new Error(`desktop mock: no command ${cmd}`);
      }
      return handler(args ?? {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}
