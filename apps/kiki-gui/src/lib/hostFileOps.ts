/**
 * Host file-opener bridge — reveal-in-file-manager and open-with-default-app
 * for absolute host paths, backed by the narrow `reveal_host_path` /
 * `open_host_path` Rust commands (desktop build only; both commands reject
 * relative paths and are granted to the main window alone). The browser build
 * has no opener channel: callers gate on `hostFileOpsSupported` and degrade to
 * copy-path actions instead.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';

export function hostFileOpsSupported(): boolean {
  return isTauri();
}

/** Reveal an absolute host path in the platform file manager. Throws off-Tauri. */
export async function revealHostPath(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Revealing host paths requires the Kiki desktop app.');
  await invoke('reveal_host_path', { path });
}

/** Open an absolute host path with the platform default application. Throws off-Tauri. */
export async function openHostPath(path: string): Promise<void> {
  if (!isTauri()) throw new Error('Opening host paths requires the Kiki desktop app.');
  await invoke('open_host_path', { path });
}
