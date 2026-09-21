import type { DesktopNativePrefs } from '@kiki/session-core/settings';
import type { ConnectionConfig } from '../state/connectionConfig';
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

export interface HostConnectionAdapter {
  discover(): Promise<LocalConnection | null>;
  cancelStartup?: () => Promise<void>;
  onBackendStage?: (callback: (payload: unknown) => void) => Promise<() => void>;
}

interface HostCapabilities {
  readonly connection: HostConnectionAdapter;
  notify?: (options: HostNotification) => Promise<void>;
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
  restartServer?: () => Promise<void>;
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
