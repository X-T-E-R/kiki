export function isElectronHost(): boolean {
  return '__KIKI_ELECTRON__' in globalThis
    && (globalThis as { __KIKI_ELECTRON__?: unknown }).__KIKI_ELECTRON__ != null;
}

export function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isVscodeWebview(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function';
}
