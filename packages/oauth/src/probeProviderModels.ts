import { validateProviderCredential } from './provider-error';

export interface DraftProviderProbe {
  readonly type: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export type DraftProviderProbeResult =
  | { readonly ok: true; readonly models: string[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'network' | 'unauthorized' | 'endpoint' | 'other';
        readonly message: string;
        readonly status?: number;
      };
    };

export async function probeProviderModels(draft: DraftProviderProbe): Promise<DraftProviderProbeResult> {
  const key = draft.apiKey.trim();
  const credential = validateProviderCredential(draft.apiKey);
  if (!credential.ok && /[\u0000-\u001F\u007F]/.test(draft.apiKey)) {
    return { ok: false, error: { kind: 'other', message: credential.reason ?? 'Invalid provider credential.' } };
  }
  let url: URL;
  try {
    url = new URL(`${draft.baseUrl.trim().replace(/\/+$/, '')}/models`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new TypeError('Invalid endpoint');
    }
  } catch {
    return { ok: false, error: { kind: 'endpoint', message: 'Enter an absolute HTTP(S) provider endpoint without URL credentials.' } };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (draft.type === 'anthropic') {
    if (key !== '') headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key !== '') {
    headers['Authorization'] = `Bearer ${key}`;
  }
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, error: { kind: 'network', message: 'Could not reach the provider endpoint (or the request timed out).' } };
  }
  if (!response.ok) {
    const status = response.status;
    return {
      ok: false,
      error: status === 401 || status === 403
        ? { kind: 'unauthorized', status, message: `Provider rejected the credentials (HTTP ${status}).` }
        : status === 404
          ? { kind: 'endpoint', status, message: 'Provider models endpoint was not found (HTTP 404).' }
          : { kind: 'other', status, message: `Provider models request failed (HTTP ${status}).` },
    };
  }
  try {
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError();
    const record = payload as Record<string, unknown>;
    const entries = Array.isArray(record['data']) ? record['data'] : record['models'];
    if (!Array.isArray(entries)) throw new TypeError();
    const models = [...new Set(entries.map((entry: unknown) => {
      const raw = typeof entry === 'string' ? entry :
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['id'] ?? (entry as Record<string, unknown>)['name']
          : undefined;
      if (typeof raw !== 'string') return '';
      const id = Array.isArray(record['models']) && raw.startsWith('models/') ? raw.slice(7) : raw;
      return id.trim();
    }).filter((id: string) => id.length > 0))];
    if (models.length === 0) throw new TypeError();
    return { ok: true, models };
  } catch {
    return { ok: false, error: { kind: 'other', message: 'Provider returned an invalid or empty models list.' } };
  }
}
