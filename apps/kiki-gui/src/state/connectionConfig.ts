export interface ConnectionConfig {
  /** Server base URL; '' means same-origin (the Vite dev proxy). */
  readonly url: string;
  readonly token: string;
}
export interface ConnectionSelection {
  readonly config: ConnectionConfig;
  readonly persist: boolean;
  readonly source: 'desktop' | 'deep-link' | 'stored' | 'manual' | 'local-detection';
}

export function readDeepLinkConfig(
  location: Pick<Location, 'search' | 'hash'> = window.location,
): ConnectionConfig | null {
  const params = new URLSearchParams(location.search);
  const qUrl = params.get('server') ?? params.get('url');
  const qToken = params.get('token');
  if (qUrl !== null || qToken !== null) {
    return { url: qUrl ?? '', token: qToken ?? '' };
  }
  const match = /(?:^|#|&)token=([^&]+)/.exec(location.hash);
  if (match !== null) {
    return { url: '', token: decodeURIComponent(match[1] ?? '') };
  }
  return null;
}

export function readStoredConfig(
  storage: Pick<Storage, 'getItem'> = localStorage,
): ConnectionConfig | null {
  try {
    const raw = storage.getItem('kiki.connection');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return null;
    return { url: parsed.url, token: parsed.token };
  } catch {
    return null;
  }
}

export function selectInitialConnection(options: {
  readonly desktop?: ConnectionConfig;
  readonly deepLink?: ConnectionConfig | null;
  readonly stored?: ConnectionConfig | null;
}): ConnectionSelection | null {
  if (options.desktop !== undefined) {
    return { config: options.desktop, persist: false, source: 'desktop' };
  }
  if (options.deepLink !== undefined && options.deepLink !== null) {
    return { config: options.deepLink, persist: true, source: 'deep-link' };
  }
  if (options.stored !== undefined && options.stored !== null) {
    return { config: options.stored, persist: true, source: 'stored' };
  }
  return null;
}
