/**
 * Host-file write channel for the preview workspace editor.
 *
 * kap-server deliberately exposes no unconfined host-file write endpoint
 * (packages/kap-server/src/routes/workspaceFs.ts is read/mkdir-only), so the
 * GUI writes through a narrow Rust command in the desktop build. The browser
 * build has no write channel: callers gate editing on `hostFileWriteSupported`
 * and show the read-only hint instead.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';

export function hostFileWriteSupported(): boolean {
  return isTauri();
}

/**
 * Write UTF-8 text to an absolute host path through the native host-file command.
 * Throws off-Tauri — callers must check `hostFileWriteSupported` first.
 */
export async function writeHostFileText(path: string, text: string): Promise<void> {
  if (!isTauri()) throw new Error('Writing host files requires the Kiki desktop app.');
  await invoke('write_host_file_text', { path, text });
}
