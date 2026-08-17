/**
 * Desktop-specific bridge — Tauri tray / notification helpers.
 *
 * All functions degrade gracefully in the browser build.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { DesktopNativePrefs } from './settings';

export interface DesktopServerConfig {
  configPath: string;
  backupPath: string;
  subagent: {
    defaultModel: string;
    defaultEffort: string;
    timeoutMs: number;
  };
  agents: {
    enabled: boolean;
    defaultSubagentModel: string;
    defaultSubagentReasoningEffort: string;
  };
  builtinProductSkills: boolean;
  modelCatalog: {
    refreshIntervalMs: number;
    refreshOnStart: boolean;
  };
  experimentalEnv: Record<string, string>;
}

export interface DesktopServerConfigPatch {
  subagentDefaultModel: string;
  subagentDefaultEffort: string;
  subagentTimeoutMs: number;
  agentsEnabled: boolean;
  defaultSubagentModel: string;
  defaultSubagentReasoningEffort: string;
  builtinProductSkills: boolean;
  modelCatalogRefreshIntervalMs: number;
  modelCatalogRefreshOnStart: boolean;
}

export function isDesktopRuntime(): boolean {
  return isTauri();
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === 'granted';
  }
  return granted;
}

export async function showDesktopNotification(options: NotificationOptions): Promise<void> {
  if (!isTauri()) return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  sendNotification(options);
}

export async function focusMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('show_main_window');
  } catch {
    // ignore
  }
}

/**
 * Save a blob through the native save dialog (tauri-plugin-dialog) and write
 * it with tauri-plugin-fs. Resolves `false` when the user cancels the dialog.
 * Browser callers keep their blob-download path — this throws off-Tauri.
 */
export async function saveBlobNative(blob: Blob, filename: string): Promise<boolean> {
  if (!isTauri()) throw new Error('Native save requires the Kiki desktop app.');
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const path = await save({ defaultPath: filename });
  if (path === null) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(path, bytes);
  return true;
}

/** Select one or more directories through the native desktop dialog. */
export async function selectDirectoriesNative(): Promise<readonly string[] | null> {
  if (!isTauri()) throw new Error('Native directory selection requires the Kiki desktop app.');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: true });
  if (selected === null) return null;
  return typeof selected === 'string' ? [selected] : selected;
}

export async function isMainWindowVisibleAndFocused(): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    const window = getCurrentWindow();
    const [visible, focused] = await Promise.all([window.isVisible(), window.isFocused()]);
    return visible && focused;
  } catch {
    return true;
  }
}

export async function writeNativeDesktopPrefs(prefs: Partial<DesktopNativePrefs>): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('write_desktop_prefs', { prefs });
  } catch {
    // ignore
  }
}

export async function readNativeDesktopPrefs(): Promise<DesktopNativePrefs | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<DesktopNativePrefs>('read_desktop_prefs');
  } catch {
    return null;
  }
}

export async function readNativeServerConfig(): Promise<DesktopServerConfig> {
  if (!isTauri()) throw new Error('Server-file settings require the Kiki desktop app.');
  return invoke<DesktopServerConfig>('read_server_config');
}

export async function writeNativeServerConfig(
  patch: DesktopServerConfigPatch,
): Promise<DesktopServerConfig> {
  if (!isTauri()) throw new Error('Server-file settings require the Kiki desktop app.');
  return invoke<DesktopServerConfig>('write_server_config', { patch });
}

export async function restartNativeServer(): Promise<void> {
  if (!isTauri()) throw new Error('Server restart requires the Kiki desktop app.');
  await invoke('restart_server');
}

export function onTrayNewSession(callback: () => void): () => void {
  if (!isTauri()) return () => {};
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  // Fire-and-forget: the unlisten fn arrives asynchronously; callers get the
  // synchronous guard via `unsubscribed` in the meantime.
  void listen('kiki://new-session', () => {
    if (!unsubscribed) callback();
  }).then((fn) => {
    unlisten = fn;
  });
  return () => {
    unsubscribed = true;
    unlisten?.();
  };
}
