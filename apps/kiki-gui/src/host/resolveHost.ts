import { browserHost } from './browser';
import { isTauriHost, isVscodeWebview } from './detect';
import type { HostAdapter } from './host';

export async function resolveHostAdapter(): Promise<HostAdapter> {
  if (isTauriHost()) return (await import('./tauri')).tauriHost;
  if (isVscodeWebview()) return (await import('./vscode')).vscodeHost;
  return browserHost;
}
