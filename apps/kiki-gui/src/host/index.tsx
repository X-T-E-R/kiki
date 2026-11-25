import { createContext, useContext, type ReactNode } from 'react';

import { browserHost } from './browser';
import type { HostAdapter } from './host';

export * from './host';
export * from './external';
export { browserHost } from './browser';
export { isElectronHost, isTauriHost, isVscodeWebview } from './detect';

const HostContext = createContext<HostAdapter>(browserHost);

export function HostProvider({
  children,
  host = browserHost,
}: {
  children: ReactNode;
  host?: HostAdapter;
}) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): HostAdapter {
  return useContext(HostContext);
}
