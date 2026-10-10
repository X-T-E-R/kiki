import type { DesktopLogLevel, DesktopNativePrefs, DesktopUpdateState, UpdateChannel } from '@kiki/session-core/settings';

import type { ConnectionConfig, SshProfile } from '../state/connectionConfig';
import type { ResolvedTheme } from '../lib/theme';
import type { NavScopeIdentity } from '../lib/navHistory';

export interface NotificationNavigationIntent {
  readonly route: string;
  readonly homeId?: string;
  readonly scope?: NavScopeIdentity;
  readonly navigationId?: string;
}

export type DesktopUpdateMutation =
  | { readonly kind: 'checked'; readonly at: number }
  | { readonly kind: 'snooze'; readonly until: number }
  | { readonly kind: 'skip'; readonly channel: UpdateChannel; readonly version: string };

export function isDesktopUpdateSelectionChanged(error: unknown): boolean {
  return String(error).includes('Desktop update selection changed; check for updates again');
}

export interface HostNotification {
  readonly title: string;
  readonly body?: string;
  /**
   * What a click should open (`/s/<id>`, `/activity`). Carried to the shell so
   * a native click can be routed back through `onNotificationClick`.
   */
  readonly route?: string;
  /** Credential-free identity captured when the notification is produced, not clicked. */
  readonly scope?: NavScopeIdentity;
  /** Same tag replaces the previous notification where the platform supports it. */
  readonly tag?: string;
}

export interface HostSelectedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  read(): Promise<File>;
}

/**
 * One native OS file drop. Desktop shells that intercept HTML5 drag-and-drop
 * (Tauri does by default) deliver drops through this channel instead, with the
 * absolute paths the DOM File API cannot expose.
 */
export interface HostFileDrop {
  /** Absolute paths of the dropped files, in the OS's drop order. */
  readonly paths: readonly string[];
  /**
   * Drop position in CSS pixels relative to the window, when the runtime
   * reports one; subscribers use it to route the drop to the element under
   * the cursor. Undefined means "somewhere in the window".
   */
  readonly position?: { readonly x: number; readonly y: number };
}

/** One entry of `desktop_space_statuses`. */
export interface DesktopSpaceStatus {
  readonly homeId: string;
  readonly active: boolean;
  /** The backend is running (switch mode keeps others alive in the background). */
  readonly hot: boolean;
  /** Sessions waiting on an approval or a question. */
  readonly pendingCount: number;
  readonly busyCount: number;
}

/** `desktop_log_info`: the home's log folder (`logs`), where the desktop backend log lives, and the level its next launch uses. */
export interface DesktopLogInfo {
  readonly directory: string;
  readonly backendLogPath: string;
  readonly maxBytes: number;
  readonly backups: number;
  readonly logLevel: DesktopLogLevel;
  /** A level change reaches the backend on its next desktop-owned launch, never the running one. */
  readonly appliesOnNextLaunch: boolean;
}

export interface DesktopUpdate {
  readonly currentVersion: string;
  readonly version: string;
  readonly date?: string;
  readonly notes?: string;
  install(): Promise<void>;
}

export interface LocalConnection {
  readonly config: ConnectionConfig;
  readonly persist: boolean;
}

export interface SshResolvedConnection {
  readonly config: ConnectionConfig;
  readonly tunnelId: string;
  readonly serverHomeId: string;
  readonly serverInstanceId: string;
  readonly serverVersion: string;
  readonly buildId: string | null;
  readonly buildChannel: string | null;
}

export interface HostConnectionAdapter {
  discover(): Promise<LocalConnection | null>;
  listSshProfiles?: () => Promise<SshProfile[]>;
  saveSshProfile?: (profile: SshProfile) => Promise<SshProfile[]>;
  removeSshProfile?: (id: string) => Promise<SshProfile[]>;
  connectSshProfile?: (id: string, token: string) => Promise<SshResolvedConnection>;
  prepareSshProfile?: (id: string, token: string) => Promise<SshResolvedConnection>;
  resumeScopeConnection?: (homeId: string, id: string, tunnelId: string) => Promise<{ profile: SshProfile; connection: SshResolvedConnection }>;
  commitScopeConnection?: (homeId: string, id: string, tunnelId: string, reload: boolean) => Promise<void>;
  takeScopeConnection?: () => Promise<{ profile: SshProfile; connection: SshResolvedConnection } | null>;
  sshTunnelRunning?: (id: string, tunnelId: string) => Promise<boolean>;
  disconnectSshProfile?: (id: string, tunnelId: string) => Promise<void>;
  setWorkspaceScope?: (scope: 'local' | 'ssh') => void;
  cancelStartup?: () => Promise<void>;
  onBackendStage?: (callback: (payload: unknown) => void) => Promise<() => void>;
}

export interface HostSaveSink {
  readonly streaming: boolean;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<boolean>;
  abort(): Promise<void>;
}

interface HostCapabilities {
  readonly connection: HostConnectionAdapter;
  notify?: (options: HostNotification) => Promise<void>;
  /**
   * Clicks on notifications this app raised, with the `route` they carried.
   * Present where the shell reports clicks back to the page; the returned
   * function unsubscribes.
   */
  onNotificationClick?: (callback: (route: string, homeId?: string, scope?: NavScopeIdentity) => void) => () => void;
  takeNavigationIntent?: () => Promise<NotificationNavigationIntent | { readonly connectionId: string } | null>;
  /**
   * The unread count for the taskbar / dock icon (0 clears it). Best effort:
   * a platform without badges ignores it.
   */
  setUnreadBadge?: (count: number) => Promise<void>;
  /**
   * Open an http(s) URL in the system browser. Present where `window.open`
   * cannot be trusted (desktop webviews reject pop-ups, VS Code webviews have
   * no real browser window); browsers fall back to `window.open` with its
   * return value checked so a blocked pop-up surfaces as a rejection.
   */
  openUrl?: (url: string) => Promise<void>;
  isWindowVisibleAndFocused?: () => Promise<boolean>;
  saveBlob?: (blob: Blob, filename: string) => Promise<boolean>;
  openSaveSink?: (filename: string) => Promise<HostSaveSink | null>;
  pickFiles?: () => Promise<HostSelectedFile[] | null>;
  /** OS file-copy clipboard, distinct from text and screenshot clipboard data. */
  readClipboardFiles?: () => Promise<{
    readonly paths: readonly string[];
    readonly media: readonly HostSelectedFile[];
  } | null>;
  /** Lazily classify native image drops using the same media policy as clipboard files. */
  readDroppedFiles?: (paths: readonly string[]) => Promise<{
    readonly paths: readonly string[];
    readonly media: readonly HostSelectedFile[];
  }>;
  /**
   * Subscribe to native OS file drops. Present only where the shell owns
   * drag-and-drop (the desktop runtime); the returned function unsubscribes.
   */
  onFileDrop?: (callback: (drop: HostFileDrop) => void) => () => void;
  pickDirectory?: () => Promise<string | null>;
  pickDirectories?: () => Promise<readonly string[] | null>;
  revealPath?: (path: string) => Promise<void>;
  openPath?: (path: string) => Promise<void>;
  writeFileText?: (path: string, text: string) => Promise<void>;
  readDesktopPrefs?: () => Promise<DesktopNativePrefs | null>;
  writeDesktopPrefs?: (prefs: Partial<DesktopNativePrefs>) => Promise<void>;
  /**
   * The desktop's active space, as the raw `desktop_active_space` payload
   * (`{ homeId, name, color, isPrimary, … }`). The storage boot validates and
   * consumes it (see `lib/spaceStorage.ts`); an older desktop build has no such
   * command, which the storage boot reads as the main space.
   */
  activeSpace?: () => Promise<unknown>;
  /**
   * Hot or visited space slots (`desktop_space_statuses`). A space missing from
   * the list is cold: its backend is not running.
   */
  spaceStatuses?: () => Promise<readonly DesktopSpaceStatus[]>;
  /**
   * Switch mode: make `homeId` the active space (`switch_space`). The native
   * side starts a cold backend first, then reloads the window; a failure
   * leaves the current space in place.
   */
  switchSpace?: (homeId: string) => Promise<void>;
  /** Navigation staging: switch the backend only; the Router owns route/reload commit. */
  prepareSpace?: (homeId: string) => Promise<{ readonly homeId: string }>;
  /** Windows mode: open (or focus) the space's own window (`open_space`). */
  openSpace?: (homeId: string) => Promise<void>;
  /** Windows mode: source-home broker window; only a registered connection id crosses the bridge. */
  openRemoteSpace?: (connectionId: string) => Promise<void>;
  /** Windows-only. Rejects with `{ code, message }`; never overwrites an existing shortcut. */
  createSpaceShortcut?: (homeId: string) => Promise<{ readonly homeId: string; readonly path: string }>;
  restartSpace?: (homeId: string) => Promise<void>;
  restartServer?: () => Promise<void>;
  /** Desktop backend log location and level (`desktop_log_info`). */
  desktopLogInfo?: () => Promise<DesktopLogInfo>;
  /** Open the active space's log folder in the OS file manager. */
  openDesktopLogDirectory?: () => Promise<void>;
  supportsDesktopUpdates?: () => Promise<boolean>;
  checkDesktopUpdate?: (channel?: UpdateChannel) => Promise<DesktopUpdate | null>;
  mutateDesktopUpdateState?: (mutation: DesktopUpdateMutation) => Promise<DesktopUpdateState>;
  onTrayNewSession?: (callback: () => void) => () => void;
  setTheme?: (resolved: ResolvedTheme) => Promise<void>;
}

export interface BrowserHostAdapter extends HostCapabilities {
  readonly kind: 'browser';
}

export interface TauriHostAdapter extends Required<Omit<HostCapabilities, 'connection'>> {
  readonly kind: 'tauri';
  readonly connection: Required<HostConnectionAdapter>;
}

export type HostAdapter = BrowserHostAdapter | TauriHostAdapter;
