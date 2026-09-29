import type { DesktopNativePrefs } from '@kiki/session-core/settings';
import type { ConnectionConfig, SshProfile } from '../state/connectionConfig';
import type { ResolvedTheme } from '../lib/theme';

export interface HostNotification {
  readonly title: string;
  readonly body?: string;
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
  sshTunnelRunning?: (id: string, tunnelId: string) => Promise<boolean>;
  disconnectSshProfile?: (id: string, tunnelId: string) => Promise<void>;
  setWorkspaceScope?: (scope: 'local' | 'ssh') => void;
  cancelStartup?: () => Promise<void>;
  onBackendStage?: (callback: (payload: unknown) => void) => Promise<() => void>;
}

interface HostCapabilities {
  readonly connection: HostConnectionAdapter;
  notify?: (options: HostNotification) => Promise<void>;
  /**
   * Open an http(s) URL in the system browser. Present where `window.open`
   * cannot be trusted (desktop webviews reject pop-ups, VS Code webviews have
   * no real browser window); browsers fall back to `window.open` with its
   * return value checked so a blocked pop-up surfaces as a rejection.
   */
  openUrl?: (url: string) => Promise<void>;
  isWindowVisibleAndFocused?: () => Promise<boolean>;
  saveBlob?: (blob: Blob, filename: string) => Promise<boolean>;
  pickFiles?: () => Promise<HostSelectedFile[] | null>;
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
  /** Windows mode: open (or focus) the space's own window (`open_space`). */
  openSpace?: (homeId: string) => Promise<void>;
  restartServer?: () => Promise<void>;
  supportsDesktopUpdates?: () => Promise<boolean>;
  checkDesktopUpdate?: () => Promise<DesktopUpdate | null>;
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
