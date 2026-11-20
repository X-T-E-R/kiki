import { ProtocolSchema, type Protocol } from '#/kosong/protocol/protocol';
import type { ProviderAdapterDefinition } from '#/kosong/protocol/extensionRegistry';
import type { ResolutionTrace } from '#/kosong/contract/inspection';
import type { ProviderConfig } from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import type { ModelRecord } from './model';

export type ModelProtocolSource = 'model' | 'provider' | 'vendor';

export interface ExplainedModelProtocol {
  readonly protocol: Protocol;
  readonly source: ModelProtocolSource;
}

const VALID_PROTOCOLS: ReadonlySet<string> = new Set(ProtocolSchema.options);

function parseProtocolFast(value: string): Protocol {
  if (VALID_PROTOCOLS.has(value)) return value as Protocol;
  return ProtocolSchema.parse(value);
}

export function explainModelProtocol(
  model: Pick<ModelRecord, 'protocol'>,
  provider?: Pick<ProviderConfig, 'type'>,
  trace?: ResolutionTrace,
  adapter?: ProviderAdapterDefinition,
): ExplainedModelProtocol | undefined {
  if (model.protocol !== undefined) {
    trace?.record('resolved.protocol', { kind: 'config', detail: 'model.protocol' });
    return { protocol: parseProtocolFast(model.protocol), source: 'model' };
  }
  const providerType = provider?.type;
  if (providerType === undefined) return undefined;
  if (VALID_PROTOCOLS.has(providerType)) {
    trace?.record('resolved.protocol', { kind: 'config', detail: `provider type '${providerType}' is itself a wire protocol` });
    return { protocol: providerType as Protocol, source: 'provider' };
  }
  const definition = adapter ?? getProviderDefinition(providerType);
  if (definition === undefined) return undefined;
  trace?.record('resolved.protocol', { kind: 'builtin', detail: `vendor '${providerType}' declared baseProtocol` });
  return { protocol: definition.baseProtocol, source: 'vendor' };
}

export function resolveModelProtocol(
  model: Pick<ModelRecord, 'protocol'>,
  provider?: Pick<ProviderConfig, 'type'>,
  trace?: ResolutionTrace,
  adapter?: ProviderAdapterDefinition,
): Protocol | undefined {
  return explainModelProtocol(model, provider, trace, adapter)?.protocol;
}
