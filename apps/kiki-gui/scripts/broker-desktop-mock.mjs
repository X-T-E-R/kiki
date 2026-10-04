/**
 * Playwright init script for the brokered-remote walk: the Tauri shell the
 * space switcher needs in order to offer a remote Kiki as a space at all.
 *
 * `space-desktop-mock.mjs` answers from a fixture server's `/__control`. This
 * one has no fixture server: the control home is a real kap-server (A), so the
 * window's connection, its space list and its status come from A itself, and
 * every desktop command the walk touches is answered here. Nothing is faked
 * about the remote side — the remote Kiki is B, reached through A's broker.
 *
 * Only what the remote-space path reads is implemented. An unimplemented
 * desktop command says so loudly instead of hanging, so a gap in this mock
 * reads as a gap rather than as a timeout.
 *
 *   await context.addInitScript(brokerDesktopMock, { aUrl, aOwner, homeName });
 */

export function brokerDesktopMock({ aUrl, aOwner, homeName }) {
  let nextCallback = 1;
  const callbacks = new Map();
  const record = (command) => { sessionStorage.setItem('kiki.broker.commands', JSON.stringify([...(JSON.parse(sessionStorage.getItem('kiki.broker.commands') ?? '[]')), { command }])); };
  const readPrefs = () => JSON.parse(localStorage.getItem('kiki.broker.prefs') ?? 'null') ?? {
    notifications: true, closeToTray: true, updateChannel: 'stable', autoUpdate: 'notify',
    compatibility: { homeKind: 'kimi' }, window_mode: 'switch',
  };
  const commands = {
    desktop_connection: () => ({ url: aUrl, token: aOwner }),
    restart_server: () => ({ url: aUrl, token: aOwner }),
    // A is this window's own home, so it is the only entry in the directory.
    desktop_active_space: () => ({ homeId: 'main', name: homeName, path: '', credentialsShared: true }),
    desktop_space_statuses: () => [{ homeId: 'main', active: true, hot: true, pendingCount: 0, busyCount: 0 }],
    prepare_space: () => ({ homeId: 'main', name: homeName, path: '', credentialsShared: true }),
    switch_space: () => ({ homeId: 'main', name: homeName, path: '', credentialsShared: true }),
    open_space: () => ({ homeId: 'main', name: homeName, path: '', credentialsShared: true }),
    take_scope_connection: () => null,
    take_navigation_intent: () => null,
    read_desktop_prefs: () => readPrefs(),
    write_desktop_prefs: ({ prefs }) => {
      const next = { ...readPrefs(), ...prefs };
      if (prefs.windowMode !== undefined) { next.window_mode = prefs.windowMode; delete next.windowMode; }
      localStorage.setItem('kiki.broker.prefs', JSON.stringify(next));
    },
    supports_desktop_updates: () => false,
    check_desktop_update: () => null,
    desktop_log_info: () => ({ directory: '', backendLogPath: '', maxBytes: 1024, backups: 1, logLevel: 'warn', appliesOnNextLaunch: true }),
    open_desktop_log_directory: () => undefined,
    list_ssh_profiles: () => [],
    reveal_host_path: () => undefined,
    open_host_path: () => undefined,
    open_external_url: () => undefined,
    cancel_desktop_startup: () => undefined,
    // The tray badge; the walk never reads it, but the shell calls it on every
    // session-list change and must not log an error for that.
    set_unread_count: () => undefined,
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
        record(cmd);
        console.error(`broker desktop mock: no command ${cmd}`);
        throw new Error(`broker desktop mock: no command ${cmd}`);
      }
      record(cmd);
      return handler(args ?? {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}
