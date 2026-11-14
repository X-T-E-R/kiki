/**
 * Decision sources: which service judges a reviewer action or a memory pick.
 *
 * A decision service is an ordinary connection (`type = system_one | pair_score`)
 * that owns its address, key and endpoint. Each consumer stores only a pointer
 * to it — a connection with an optional model name, or a chat model alias — so
 * one saved key serves every consumer and none of them edits another.
 */

import {
  DECISION_PROTOCOL_PATHS,
  decisionProtocolSchema,
  type DecisionCapabilitiesWire,
  type DecisionProtocol,
  type DecisionSource,
  type DecisionSourceStatus,
  type ProviderCatalogItem,
} from '@kiki/protocol';

import type { I18nKey } from '../i18n';

export type DecisionConsumer = 'reviewer' | 'memory';

export const DECISION_PROTOCOLS: readonly DecisionProtocol[] = ['openai_decisions', 'system_one', 'pair_score'];

/** The presets for adding a standalone decision connection. */
export interface DecisionConnectionPreset {
  readonly id: 'openai_decisions' | 'jev' | 'system_one' | 'pair_score';
  readonly type: DecisionProtocol;
  readonly suggestedId: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly defaultModel: string;
}

export const DECISION_CONNECTION_PRESETS: readonly DecisionConnectionPreset[] = [
  { id: 'openai_decisions', type: 'openai_decisions', suggestedId: 'decisions', baseUrl: 'https://api.openai.com/v1', defaultModel: '' },
  { id: 'jev', type: 'system_one', suggestedId: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1', apiKeyEnv: 'TYPESAFE_API_KEY', defaultModel: 'jev-latest' },
  { id: 'system_one', type: 'system_one', suggestedId: 'system-one', baseUrl: '', defaultModel: '' },
  { id: 'pair_score', type: 'pair_score', suggestedId: 'rerank', baseUrl: '', defaultModel: '' },
];

/** A connection that answers decisions rather than chat; older servers carry only its type. */
export function isDecisionConnection(provider: Pick<ProviderCatalogItem, 'type' | 'service'>): boolean {
  return provider.service === 'decision'
    || provider.type === 'system_one'
    || provider.type === 'pair_score'
    || provider.type === 'openai_decisions';
}

export function decisionProtocolOf(provider: Pick<ProviderCatalogItem, 'type' | 'decision_protocol'>): DecisionProtocol | undefined {
  if (provider.decision_protocol !== undefined) return provider.decision_protocol;
  return provider.type === 'system_one' || provider.type === 'pair_score' || provider.type === 'openai_decisions'
    ? provider.type
    : undefined;
}

/**
 * A consumer may use a protocol only for what it measures. Pair scores are
 * relevance, not the probability that an action is safe, so the reviewer
 * never offers them.
 */
export function decisionProtocolAllowed(consumer: DecisionConsumer, protocol: DecisionProtocol | 'chat_json'): boolean {
  return consumer === 'memory' || protocol !== 'pair_score';
}

/**
 * Picker value for a source: a dedicated decision connection (`connection:<id>`),
 * an attached capability on a chat connection (`connection:<id>#<protocol>`),
 * or a chat model (`model:<alias>`).
 */
export function decisionSourceValue(source: DecisionSource | undefined): string {
  if (source === undefined) return '';
  if (source.kind === 'model') return `model:${source.model}`;
  return source.protocol === undefined
    ? `connection:${source.connection}`
    : `connection:${source.connection}#${source.protocol}`;
}

/** The source a picker value stands for, keeping a model override when the same connection target stays chosen. */
export function decisionSourceFromValue(value: string, current?: DecisionSource): DecisionSource | null {
  if (value.startsWith('connection:')) {
    const raw = value.slice('connection:'.length);
    const hashIndex = raw.lastIndexOf('#');
    const connection = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const rawProtocol = hashIndex >= 0 ? raw.slice(hashIndex + 1) : undefined;
    if (connection === '') return null;
    let protocol: DecisionProtocol | undefined;
    if (rawProtocol !== undefined) {
      const parsed = decisionProtocolSchema.safeParse(rawProtocol);
      if (!parsed.success) return null;
      protocol = parsed.data;
    }
    const model = current?.kind === 'connection'
      && current.connection === connection
      && (current.protocol ?? undefined) === protocol
      ? current.model
      : undefined;
    return { kind: 'connection', connection, protocol, model };
  }
  if (value.startsWith('model:')) {
    const model = value.slice('model:'.length);
    return model === '' ? null : { kind: 'model', model };
  }
  return null;
}

/** A connection source with its model name replaced; an empty name means "use the connection's default". */
export function decisionSourceWithModel(source: Extract<DecisionSource, { kind: 'connection' }>, model: string): DecisionSource {
  const trimmed = model.trim();
  return {
    kind: 'connection',
    connection: source.connection,
    protocol: source.protocol,
    model: trimmed === '' ? undefined : trimmed,
  };
}

export function sameDecisionSource(a: DecisionSource | undefined, b: DecisionSource | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'model') return b.kind === 'model' && a.model === b.model;
  return b.kind === 'connection'
    && a.connection === b.connection
    && (a.protocol ?? '') === (b.protocol ?? '')
    && (a.model ?? '') === (b.model ?? '');
}

export type DecisionSourceProblem = 'missing_connection' | 'not_decision' | 'pair_score_reviewer' | 'missing_model' | 'auth' | 'protocol' | 'unconfigured';

export type DecisionCatalogProvider = Pick<ProviderCatalogItem, 'id' | 'type' | 'service' | 'decision_protocol' | 'default_model'> & {
  readonly decision_capabilities?: DecisionCapabilitiesWire;
};

/**
 * Resolve the protocol and default model for a connection source against a catalog item.
 */
export function resolveCatalogDecisionTarget(
  provider: DecisionCatalogProvider,
  requestedProtocol?: DecisionProtocol,
): { readonly protocol: DecisionProtocol; readonly defaultModel?: string } | null {
  const standalone = decisionProtocolOf(provider);
  if (standalone !== undefined) {
    if (requestedProtocol !== undefined && requestedProtocol !== standalone) return null;
    return { protocol: standalone, defaultModel: provider.default_model };
  }
  if (requestedProtocol === undefined) return null;
  const attached = provider.decision_capabilities?.[requestedProtocol];
  if (attached === undefined) return null;
  return { protocol: requestedProtocol, defaultModel: attached.model };
}

/**
 * What stands between a saved source and a working one, read from the
 * server's status first and the client's catalog second (for a server that
 * does not report one yet). `null` means nothing is in the way.
 */
export function decisionSourceProblem(
  consumer: DecisionConsumer,
  source: DecisionSource | undefined,
  status: DecisionSourceStatus | undefined,
  providers: readonly DecisionCatalogProvider[] | undefined,
): DecisionSourceProblem | null {
  if (source === undefined) return null;
  if (source.kind === 'connection' && providers !== undefined) {
    const provider = providers.find((item) => item.id === source.connection);
    if (provider === undefined) return 'missing_connection';
    const target = resolveCatalogDecisionTarget(provider, source.protocol);
    if (target === null) return 'not_decision';
    if (!decisionProtocolAllowed(consumer, target.protocol)) return 'pair_score_reviewer';
    if (source.model === undefined && (target.defaultModel ?? '') === '') return 'missing_model';
  }
  switch (status?.state) {
    case 'auth': return 'auth';
    case 'protocol': return 'protocol';
    case 'capability_mismatch': return 'pair_score_reviewer';
    case 'unconfigured': return 'unconfigured';
    default: return null;
  }
}

export const DECISION_SOURCE_PROBLEM_KEYS: Readonly<Record<DecisionSourceProblem, I18nKey>> = {
  missing_connection: 'st.decision.problem.missingConnection',
  not_decision: 'st.decision.problem.notDecision',
  pair_score_reviewer: 'st.decision.problem.pairScoreReviewer',
  missing_model: 'st.decision.problem.missingModel',
  auth: 'st.decision.problem.auth',
  protocol: 'st.decision.problem.protocol',
  unconfigured: 'st.decision.problem.unconfigured',
};

/**
 * Where a decision connection's requests go: its own endpoint when one is
 * set (a path resolves against the base), otherwise the base plus the
 * protocol's path. Mirrors the server, which stays the authority.
 */
export function decisionConnectionEndpoint(baseUrl: string | undefined, protocol: DecisionProtocol, override?: string): URL | null {
  if (baseUrl === undefined || baseUrl.trim() === '') return null;
  try {
    const base = new URL(baseUrl.trim());
    const path = override?.trim();
    return path !== undefined && path !== ''
      ? new URL(path, base)
      : new URL(`${base.pathname.replace(/\/$/, '')}/${DECISION_PROTOCOL_PATHS[protocol]}`, base);
  } catch {
    return null;
  }
}

export type DecisionEndpointIssue = 'invalid' | 'origin' | 'credentials';

/** An endpoint override must stay on the connection's own origin, without embedded credentials. */
export function decisionEndpointIssue(baseUrl: string | undefined, override: string): DecisionEndpointIssue | null {
  const path = override.trim();
  if (path === '') return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL((baseUrl ?? '').trim());
    url = new URL(path, base);
  } catch {
    return 'invalid';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
  if (url.username !== '' || url.password !== '') return 'credentials';
  return url.origin === base.origin ? null : 'origin';
}

/** The destination string the server reports and a probe confirms: `<connection>@<origin>`. */
export function decisionDestination(connection: string, endpoint: URL | null): string | undefined {
  return endpoint === null ? undefined : `${connection}@${endpoint.origin}`;
}

/** Where a saved decision connection or attached capability sends, from its effective address first. */
export function decisionConnectionDestination(
  provider: Pick<ProviderCatalogItem, 'id' | 'type' | 'decision_protocol' | 'base_url' | 'effective_base_url' | 'decision_endpoint'> & {
    readonly decision_capabilities?: DecisionCapabilitiesWire;
  },
  requestedProtocol?: DecisionProtocol,
): string | undefined {
  const standalone = decisionProtocolOf(provider);
  const protocol = standalone ?? requestedProtocol;
  if (protocol === undefined) return undefined;
  const override = standalone !== undefined ? provider.decision_endpoint : provider.decision_capabilities?.[protocol]?.endpoint;
  return decisionDestination(provider.id, decisionConnectionEndpoint(provider.effective_base_url ?? provider.base_url, protocol, override));
}

/** The settings card that owns which source each consumer uses: Defaults in Models & providers. */
export const DECISION_JUDGES_ROUTE = '/settings/ai?tab=defaults#st-card-decision-judges';
/** The connections card in Models & providers. */
export const DECISION_CONNECTIONS_ROUTE = '/settings/ai?tab=providers#st-card-providers';
/** The connections card opened on the add flow for a decision service. */
export const DECISION_CONNECTION_ADD_ROUTE = '/settings/ai?tab=providers#decision-connection-add';
/** The query parameter that opens one connection's row on arrival. */
export const DECISION_CONNECTION_PARAM = 'decision';
/** One connection, opened in Connections. */
export function decisionConnectionRoute(connection: string): string {
  return `/settings/ai?tab=providers&${DECISION_CONNECTION_PARAM}=${encodeURIComponent(connection)}#st-card-providers`;
}
