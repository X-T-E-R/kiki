import { invoke, isTauri } from '@tauri-apps/api/core';

import type { ConnectionConfig } from '../state/connectionConfig';

interface ViteLocalServerPayload {
  readonly url?: string;
  readonly token?: string;
  readonly error?: string;
}
export interface LocalConnection {
  readonly config: ConnectionConfig;
  /** Desktop credentials are process-owned and must remain memory-only. */
  readonly persist: boolean;
}

export function isDesktopRuntime(): boolean {
  return isTauri();
}

export async function detectLocalConnection(): Promise<LocalConnection | null> {
  if (isDesktopRuntime()) {
    const config = await invoke<ConnectionConfig>('desktop_connection');
    return { config, persist: false };
  }

  const response = await fetch('/__kiki/local-server');
  if (!response.ok) throw new Error(`Local server detection failed (${response.status})`);
  const payload = (await response.json()) as ViteLocalServerPayload;
  if (payload.error !== undefined) throw new Error(payload.error);
  if (payload.url === undefined) return null;
  return {
    config: { url: payload.url, token: payload.token ?? '' },
    persist: true,
  };
}
