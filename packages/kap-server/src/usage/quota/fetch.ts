import type { ProviderQuotaMeter } from '@kiki/protocol';
import { parseQuota, quotaHeaders, type QuotaAdapter } from './adapters';
import { QuotaFailure } from './service';

export async function fetchOfficialQuota(adapter: QuotaAdapter, token: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ProviderQuotaMeter[]> {
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetchImpl(adapter.url, { headers: quotaHeaders(adapter, token), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch { throw new QuotaFailure('request_failed'); }
  if (response.status === 401 || response.status === 403) throw new QuotaFailure('auth_required');
  if (response.status === 429) throw new QuotaFailure('rate_limited');
  if (!response.ok) throw new QuotaFailure('request_failed');
  const reader = response.body?.getReader();
  if (!reader) throw new QuotaFailure('invalid_response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new QuotaFailure('invalid_response'); }
      chunks.push(value);
    }
  } catch (error) { throw error instanceof QuotaFailure ? error : new QuotaFailure('request_failed'); }
  finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseQuota(adapter.id, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), Date.now());
  } catch { throw new QuotaFailure('invalid_response'); }
}
