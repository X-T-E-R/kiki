import { ProtocolSchema, type Protocol } from '#/kosong/protocol/protocol';
import type { ResolutionTrace } from '#/kosong/contract/inspection';
import type { ProviderConfig } from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import type { ModelRecord } from './model';

export type ModelProtocolSource = 'model' | 'provider' | 'vendor';

export interface ExplainedModelProtocol {
  readonly protocol: Protocol;
  readonly source: ModelProtocolSource;
}

export function explainModelProtocol(
  model: Pick<ModelRecord, 'protocol'>,
  provider?: Pick<ProviderConfig, 'type'>,
  trace?: ResolutionTrace,
): ExplainedModelProtocol | undefined {
  if (model.protocol !== undefined) {
    trace?.record('resolved.protocol', { kind: 'config', detail: 'model.protocol' });
    return { protocol: ProtocolSchema.parse(model.protocol), source: 'model' };
  }
  const providerType = provider?.type;
  if (providerType === undefined) return undefined;
  const parsed = ProtocolSchema.safeParse(providerType);
  if (parsed.success) {
    trace?.record('resolved.protocol', { kind: 'config', detail: `provider type '${providerType}' is itself a wire protocol` });
    return { protocol: parsed.data, source: 'provider' };
  }
  const definition = getProviderDefinition(providerType);
  if (definition === undefined) return undefined;
  trace?.record('resolved.protocol', { kind: 'builtin', detail: `vendor '${providerType}' declared baseProtocol` });
  return { protocol: definition.baseProtocol, source: 'vendor' };
}

export function resolveModelProtocol(
  model: Pick<ModelRecord, 'protocol'>,
  provider?: Pick<ProviderConfig, 'type'>,
  trace?: ResolutionTrace,
): Protocol | undefined {
  return explainModelProtocol(model, provider, trace)?.protocol;
}
