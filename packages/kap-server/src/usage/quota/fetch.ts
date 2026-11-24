import type { ProviderQuotaMeter } from '@kiki/protocol';
import { parseQuota, quotaHeaders, type QuotaAdapter } from './adapters';
import { QuotaFailure } from './service';

async function fetchEndpoint(
  url: string,
  adapter: QuotaAdapter,
  token: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ProviderQuotaMeter[]> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: quotaHeaders(adapter, token), redirect: 'error', signal });
  } catch { throw new QuotaFailure('request_failed'); }
  if (response.status === 401 || response.status === 403) throw new QuotaFailure('auth_required', { status: response.status });
  if (response.status === 429) throw new QuotaFailure('rate_limited', { status: response.status });
  if (!response.ok) throw new QuotaFailure('request_failed', { status: response.status });
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

function isExpectedOptionalAbsence(adapterId: QuotaAdapter['id'], isSecondary: boolean, failure: QuotaFailure): boolean {
  if (adapterId === 'openrouter' && !isSecondary) return failure.status === 403;
  if (adapterId === 'stepfun' && isSecondary) return failure.status === 404 || failure.status === 403;
  return false;
}

function isOptionalEmptyAllowed(adapterId: QuotaAdapter['id'], isSecondary: boolean): boolean {
  return adapterId === 'stepfun' && isSecondary;
}

export async function fetchOfficialQuota(adapter: QuotaAdapter, token: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ProviderQuotaMeter[]> {
  const timeout = AbortSignal.timeout(8_000);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (adapter.secondaryUrl === undefined) {
    return fetchEndpoint(adapter.url, adapter, token, fetchImpl, effectiveSignal);
  }
  const [primaryOutcome, secondaryOutcome] = await Promise.allSettled([
    fetchEndpoint(adapter.url, adapter, token, fetchImpl, effectiveSignal),
    fetchEndpoint(adapter.secondaryUrl, adapter, token, fetchImpl, effectiveSignal),
  ]);
  const outcomes = [
    { isSecondary: false, outcome: primaryOutcome },
    { isSecondary: true, outcome: secondaryOutcome },
  ];
  const meters: ProviderQuotaMeter[] = [];
  const unexpectedFailures: QuotaFailure[] = [];
  const allFailures: QuotaFailure[] = [];
  for (const { isSecondary, outcome } of outcomes) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.length === 0 && !isOptionalEmptyAllowed(adapter.id, isSecondary)) {
        const emptyFailure = new QuotaFailure('invalid_response');
        allFailures.push(emptyFailure);
        unexpectedFailures.push(emptyFailure);
      } else {
        meters.push(...outcome.value);
      }
    } else {
      const failure = outcome.reason instanceof QuotaFailure ? outcome.reason : new QuotaFailure('request_failed');
      allFailures.push(failure);
      if (!isExpectedOptionalAbsence(adapter.id, isSecondary, failure)) {
        unexpectedFailures.push(failure);
      }
    }
  }
  if (allFailures.length === 0) return meters;
  if (meters.length > 0 && unexpectedFailures.length === 0) return meters;
  const primaryFailure =
    (unexpectedFailures.length > 0 ? unexpectedFailures : allFailures).find((error) => error.reason === 'auth_required') ??
    (unexpectedFailures.length > 0 ? unexpectedFailures : allFailures).find((error) => error.reason === 'rate_limited') ??
    unexpectedFailures[0] ??
    allFailures[0] ??
    new QuotaFailure('request_failed');
  if (meters.length > 0) {
    throw new QuotaFailure(primaryFailure.reason, { status: primaryFailure.status, partialMeters: meters });
  }
  throw new QuotaFailure(primaryFailure.reason, { status: primaryFailure.status });
}
