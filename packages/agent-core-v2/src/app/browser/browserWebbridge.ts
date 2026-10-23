const BASE = 'http://127.0.0.1:10086';
const PROBE_SESSION = 'kiki-browser-setup-check';

export interface WebbridgeStatus {
  readonly running: boolean;
  readonly extensionConnected: boolean;
  readonly version: string;
  readonly versionMismatch: boolean;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) throw new Error(`WebBridge request failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024 * 1024) throw new Error('WebBridge response exceeds the size limit');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function readWebbridgeStatus(fetchImpl: typeof fetch = fetch): Promise<WebbridgeStatus | undefined> {
  try {
    const data = await boundedJson(await fetchImpl(`${BASE}/status`, { signal: AbortSignal.timeout(1_500), redirect: 'error' }));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const value = data as Record<string, unknown>;
    if (typeof value['running'] !== 'boolean' || typeof value['extension_connected'] !== 'boolean' || typeof value['version'] !== 'string') return undefined;
    return { running: value['running'], extensionConnected: value['extension_connected'], version: value['version'], versionMismatch: Boolean(value['version_mismatch']) };
  } catch { return undefined; }
}

export function webbridgeExecutionSession(connectionId: string): string {
  return `kiki-${connectionId}`;
}

export interface WebbridgeTab {
  readonly tabId: string;
  readonly url?: string;
  readonly title?: string;
  readonly active?: boolean;
  readonly groupTitle?: string;
}

function commandData(payload: unknown, action: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error(`WebBridge ${action} returned an invalid response`);
  const envelope = payload as { ok?: boolean; data?: unknown; error?: unknown };
  const data = envelope.data;
  if (envelope.ok !== true || typeof data !== 'object' || data === null || Array.isArray(data)) {
    const detail = typeof envelope.error === 'string' ? envelope.error.replace(/https?:\/\/\S+/gi, '').trim().slice(0, 180) : '';
    throw new Error(detail === '' ? `WebBridge ${action} was not confirmed` : `WebBridge ${action} was not confirmed: ${detail}`);
  }
  const record = data as Record<string, unknown>;
  if (record['success'] === false) {
    const detail = typeof record['error'] === 'string' ? record['error'].replace(/https?:\/\/\S+/gi, '').trim().slice(0, 180) : '';
    throw new Error(detail === '' ? `WebBridge ${action} was not confirmed` : `WebBridge ${action} was not confirmed: ${detail}`);
  }
  return record;
}

export async function postWebbridgeCommand(action: string, args: Readonly<Record<string, unknown>>, session: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const data = await boundedJson(await fetchImpl(`${BASE}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify({ action, args, session }),
  }));
  return commandData(data, action);
}

export function webbridgeRefs(tree: unknown): readonly string[] {
  if (typeof tree === 'string') return [...tree.matchAll(/@(e\d+)/g)].map((match) => match[1]).filter((ref): ref is string => ref !== undefined);
  if (Array.isArray(tree)) return tree.flatMap((node) => webbridgeRefs(node));
  if (typeof tree !== 'object' || tree === null) return [];
  const row = tree as Record<string, unknown>;
  const own = typeof row['ref'] === 'string' && row['ref'] !== '' ? [row['ref'].replace(/^@/, '')] : [];
  return [...own, ...webbridgeRefs(row['children'])];
}

export function webbridgeTransportUnconfirmed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const carrier = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof carrier.code === 'string' ? carrier.code : typeof carrier.cause?.code === 'string' ? carrier.cause.code : '';
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
}

export function webbridgeCommandTabId(data: Record<string, unknown>): string {
  const tabId = data['tabId'];
  if (typeof tabId !== 'number' && typeof tabId !== 'string') throw new Error('WebBridge navigate returned no tabId');
  return String(tabId);
}

export function webbridgeTabs(data: Record<string, unknown>): readonly WebbridgeTab[] {
  const tabs = data['tabs'];
  if (!Array.isArray(tabs)) throw new Error('WebBridge list_tabs returned no tab list');
  return tabs.map((tab) => {
    if (typeof tab !== 'object' || tab === null || Array.isArray(tab)) throw new Error('WebBridge list_tabs returned an invalid tab');
    const row = tab as Record<string, unknown>;
    const tabId = row['tabId'];
    if (typeof tabId !== 'number' && typeof tabId !== 'string') throw new Error('WebBridge list_tabs returned a tab without tabId');
    return {
      tabId: String(tabId),
      url: typeof row['url'] === 'string' ? row['url'] : undefined,
      title: typeof row['title'] === 'string' ? row['title'] : undefined,
      active: row['active'] === true,
      groupTitle: typeof row['groupTitle'] === 'string' ? row['groupTitle'] : undefined,
    };
  });
}

export async function probeWebbridgeConnection(fetchImpl: typeof fetch = fetch): Promise<void> {
  const data = await boundedJson(await fetchImpl(`${BASE}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ action: 'list_tabs', args: {}, session: PROBE_SESSION }),
  }));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('WebBridge returned an invalid command response');
  const envelope = data as { ok?: boolean; data?: { success?: boolean; tabs?: unknown }; error?: unknown };
  if (envelope.ok !== true || envelope.data?.success !== true || !Array.isArray(envelope.data.tabs)) throw new Error('WebBridge did not confirm the extension connection; authorize or update the extension, then retry');
}
