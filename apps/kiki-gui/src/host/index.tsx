import { isTauri } from '@tauri-apps/api/core';
import { createContext, useContext, type ReactNode } from 'react';

import { browserHost } from './browser';
import { electronHost, isElectronHost } from './electron';
import type { HostAdapter } from './host';
import { tauriHost } from './tauri';
import { isVscodeWebview, vscodeHost } from './vscode';

export * from './host';
export * from './external';
export { browserHost } from './browser';
export { createElectronHost, electronHost, getElectronBridge, isElectronHost, type KikiElectronBridge } from './electron';
export { tauriHost } from './tauri';
export { vscodeHost } from './vscode';

export function resolveHostAdapter(): HostAdapter {
  return isElectronHost()
    ? electronHost
    : isTauri()
      ? tauriHost
      : isVscodeWebview()
        ? vscodeHost
        : browserHost;
}

export const hostAdapter: HostAdapter = resolveHostAdapter();

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
