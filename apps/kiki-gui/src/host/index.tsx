import { isTauri } from '@tauri-apps/api/core';
import { createContext, useContext, type ReactNode } from 'react';

import { browserHost } from './browser';
import type { HostAdapter } from './host';
import { tauriHost } from './tauri';
import { isVscodeWebview, vscodeHost } from './vscode';

export * from './host';
export { browserHost } from './browser';
export { tauriHost } from './tauri';
export { vscodeHost } from './vscode';

export const hostAdapter = isTauri() ? tauriHost : isVscodeWebview() ? vscodeHost : browserHost;

const HostContext = createContext<HostAdapter>(hostAdapter);

export function HostProvider({
  children,
  host = hostAdapter,
}: {
  children: ReactNode;
  host?: HostAdapter;
}) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): HostAdapter {
  return useContext(HostContext);
}
