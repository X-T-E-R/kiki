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

export async function probeWebbridgeConnection(fetchImpl: typeof fetch = fetch): Promise<void> {
  const data = await boundedJson(await fetchImpl(`${BASE}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ action: 'list_tabs', args: {}, session: PROBE_SESSION }),
  }));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('WebBridge returned an invalid command response');
  const envelope = data as { ok?: boolean; data?: { success?: boolean; tabs?: unknown }; error?: unknown };
  if (envelope.ok !== true || envelope.data?.success !== true || !Array.isArray(envelope.data.tabs)) throw new Error('WebBridge did not confirm the extension connection; authorize or update the extension, then retry');
}
