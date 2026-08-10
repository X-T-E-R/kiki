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

export function onTrayNewSession(callback: () => void): () => void {
  if (!isTauri()) return () => {};
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  listen('kiki://new-session', () => {
    if (!unsubscribed) callback();
  }).then((fn) => {
    unlisten = fn;
  });
  return () => {
    unsubscribed = true;
    unlisten?.();
  };
}
