import { z } from 'zod';
import { assertProviderCredential, assertProviderHeaders } from '@kiki/oauth';
import type { DecisionProtocol, DecisionSource, DecisionSourceStatus, MemoryAdvisorFailure } from '@kiki/protocol';
import type { AuthProvider, IModelCatalog, Model } from './catalog';
import type { RequestAdmissionPort, RequestAttribution } from './requestAdmission';

export class DecisionRequestError extends Error {
  constructor(readonly reason: MemoryAdvisorFailure) {
    super(reason);
    this.name = 'DecisionRequestError';
  }
}
export type DecisionIdentity = Pick<Model, 'id' | 'name' | 'providerName'>;
export interface ResolvedDecisionSource extends DecisionIdentity {
  readonly protocol: 'chat_json' | DecisionProtocol;
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly authProvider: AuthProvider;
  readonly credentialSource?: DecisionSourceStatus['credential_source'];
  readonly credentialEnv?: string;
  readonly chatModel?: Model;
  readonly alias?: string;
}
export function decisionEndpoint(baseUrl: string | undefined, protocol: ResolvedDecisionSource['protocol'], override?: string): URL {
  if (baseUrl === undefined) throw new DecisionRequestError('unconfigured');
  try {
    const base = new URL(baseUrl);
    const url = override === undefined
      ? new URL(protocol === 'chat_json' ? base.pathname : `${base.pathname.replace(/\/$/, '')}/${protocol === 'system_one' ? 'systemone' : 'rerank'}`, base)
      : new URL(override, base);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || url.username || url.password || url.origin !== base.origin || (protocol === 'chat_json' && override !== undefined)) throw new DecisionRequestError('protocol');
    return url;
  } catch (error) {
    if (error instanceof DecisionRequestError) throw error;
    throw new DecisionRequestError('protocol');
  }
}
export function resolveDecisionSource(catalog: IModelCatalog, source: DecisionSource): ResolvedDecisionSource {
  if (source.kind === 'model') return resolveLegacyDecisionModel(catalog.get(source.model), 'chat_json', undefined, source.model);
  const connection = catalog.getConnectionEndpoint(source.connection);
  if (connection.protocol === undefined) throw new DecisionRequestError('protocol');
  const endpoint = decisionEndpoint(connection.baseUrl, connection.protocol, connection.decisionEndpoint);
  const name = source.model ?? connection.defaultModel;
  if (!name) throw new DecisionRequestError('unconfigured');
  return { id: `connection:${source.connection}/${name}`, name, providerName: source.connection, protocol: connection.protocol, endpoint,
    headers: connection.headers, authProvider: connection.authProvider, credentialSource: connection.credentialSource, credentialEnv: connection.credentialEnv };
}
export function resolveLegacyDecisionModel(model: Model, protocol: ResolvedDecisionSource['protocol'], override?: string, alias = model.id): ResolvedDecisionSource {
  return { id: model.id, name: model.name, providerName: model.providerName, protocol, endpoint: decisionEndpoint(model.baseUrl, protocol, override), headers: model.headers,
    authProvider: model.authProvider, credentialSource: model.credentialSource, credentialEnv: model.credentialEnv, chatModel: model, alias };
}
export function describeDecisionSource(catalog: IModelCatalog, source: DecisionSource, reviewer = false): DecisionSourceStatus {
  try {
    return decisionSourceStatus(resolveDecisionSource(catalog, source), reviewer);
  } catch (error) {
    return { state: error instanceof DecisionRequestError && error.reason === 'protocol' ? 'protocol' : 'unconfigured',
      connection: source.kind === 'connection' ? source.connection : undefined, model: source.model };
  }
}
export function decisionSourceStatus(source: ResolvedDecisionSource, reviewer = false): DecisionSourceStatus {
  return { state: reviewer && source.protocol === 'pair_score' ? 'capability_mismatch' : source.credentialSource === 'none' && source.credentialEnv !== undefined ? 'auth' : 'ready',
    connection: source.providerName, model: source.alias ?? source.name, protocol: source.protocol, origin: source.endpoint.origin,
    destination: `${source.providerName}@${source.endpoint.origin}`, credential_source: source.credentialSource, credential_env: source.credentialEnv };
}
export async function requestDecision(input: {
  readonly source: ResolvedDecisionSource;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly attribution: RequestAttribution;
  readonly admission?: RequestAdmissionPort;
  readonly fetcher?: typeof fetch;
  readonly onStart?: () => void;
}): Promise<Record<string, unknown>> {
  const { source, signal } = input;
  signal.throwIfAborted();
  const auth = await source.authProvider.getAuth();
  signal.throwIfAborted();
  const headers = new Headers({ ...source.headers, ...auth?.headers });
  if (auth?.apiKey !== undefined) {
    assertProviderCredential(auth.apiKey);
    headers.set('Authorization', `Bearer ${auth.apiKey}`);
  }
  headers.set('Content-Type', 'application/json');
  assertProviderHeaders(Object.fromEntries(headers));
  if ((source.credentialSource === 'none' && source.credentialEnv !== undefined) || (source.credentialSource === 'oauth' && auth === undefined)) throw new DecisionRequestError('auth');
  const permit = await input.admission?.acquire({ ...input.attribution, attemptId: crypto.randomUUID(), modelId: source.id, providerId: source.providerName }, signal);
  try {
    signal.throwIfAborted();
    input.onStart?.();
    const response = await (input.fetcher ?? fetch)(source.endpoint, { method: 'POST', redirect: 'error', signal, headers: Object.fromEntries(headers), body: JSON.stringify(input.body) });
    if (!response.ok) throw new DecisionRequestError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limited' : 'protocol');
    let value: unknown;
    try { value = await response.json(); }
    catch { signal.throwIfAborted(); throw new DecisionRequestError('invalid_output'); }
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    signal.throwIfAborted();
    if (!parsed.success) throw new DecisionRequestError('invalid_output');
    return parsed.data;
  } finally {
    permit?.release();
  }
}
