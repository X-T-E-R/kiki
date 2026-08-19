/**
 * Host-file write channel for the preview workspace editor.
 *
 * kap-server deliberately exposes no unconfined host-file write endpoint
 * (packages/kap-server/src/routes/workspaceFs.ts is read/mkdir-only), so the
 * GUI writes through tauri-plugin-fs in the desktop build — same permission
 * (`fs:allow-write-file`) the session export already uses. The browser build
 * has no write channel: callers gate editing on `hostFileWriteSupported` and
 * show the read-only hint instead.
 */

import { isTauri } from '@tauri-apps/api/core';

export function hostFileWriteSupported(): boolean {
  return isTauri();
}

/**
 * Write UTF-8 text to an absolute host path. Bytes go through `writeFile`
 * (not `writeTextFile`) because the granted capability is `fs:allow-write-file`.
 * Throws off-Tauri — callers must check `hostFileWriteSupported` first.
 */
export async function writeHostFileText(path: string, text: string): Promise<void> {
  if (!isTauri()) throw new Error('Writing host files requires the Kiki desktop app.');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, new TextEncoder().encode(text));
}
