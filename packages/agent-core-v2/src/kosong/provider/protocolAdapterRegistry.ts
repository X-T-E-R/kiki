import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { BugIndicatingError } from '#/_base/errors/errors';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import { ChatProviderError } from '#/kosong/contract/errors';
import type { ChatProvider } from '#/kosong/contract/provider';
import type { DynamicProtocolBaseContribution, DynamicProviderContribution, ProviderAdapterDefinition } from '#/kosong/protocol/extensionRegistry';
import { IProtocolAdapterRegistry, ProtocolSchema, type ExplainedCapability, type Protocol, type ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import { getProtocolBase, type ProtocolBaseDefinition, type ProtocolBaseId, type ResolvedAdapterIdentity } from '#/kosong/protocol/protocolBase';
import type { ProtocolTrait, ResolvedTrait, TraitContext } from '#/kosong/protocol/protocolTrait';

import { getProviderDefinition, hasProviderDefinition } from './providerDefinition';

const CONFIG_DEFAULT_HEADERS_TRAIT: ProtocolTrait = {
  defaultHeaders: (ctx) => ctx.config.defaultHeaders === undefined ? undefined : { ...ctx.config.defaultHeaders },
};

type Slot<T> = { readonly pluginId: string; readonly generation: number; value?: T };

function registerSlot<T>(slots: Map<string, Slot<T>>, id: string, pluginId: string, generation: number, value: T): IDisposable {
  const previous = slots.get(id);
  if (!id || !pluginId || !Number.isSafeInteger(generation) || generation < 0 ||
    (previous !== undefined && (previous.pluginId !== pluginId || generation <= previous.generation))) {
    throw new BugIndicatingError(`Invalid or stale dynamic adapter registration for '${id}' from '${pluginId}'`);
  }
  const slot: Slot<T> = { pluginId, generation, value };
  if (previous !== undefined) previous.value = undefined;
  slots.set(id, slot);
  return toDisposable(() => { slot.value = undefined; });
}

export class ProtocolAdapterRegistry extends Disposable implements IProtocolAdapterRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly bases = new Map<string, Slot<ProtocolBaseDefinition>>();
  private readonly providers = new Map<string, Slot<ProviderAdapterDefinition>>();

  constructor() {
    super();
    this._register(toDisposable(() => {
      this.bases.clear();
      this.providers.clear();
    }));
  }

  registerDynamicProtocolBase({ definition, pluginId, generation }: DynamicProtocolBaseContribution): IDisposable {
    if (ProtocolSchema.safeParse(definition.id).success || getProtocolBase(definition.id) !== undefined) {
      throw new BugIndicatingError(`Cannot override built-in protocol base '${definition.id}'`);
    }
    return registerSlot(this.bases, definition.id, pluginId, generation, Object.freeze({
      id: definition.id,
      capability: definition.capability?.bind(definition),
      createChatProvider: definition.createChatProvider.bind(definition),
    }));
  }

  registerDynamicProvider(contribution: DynamicProviderContribution): IDisposable {
    const { providerId, baseProtocol, pluginId, generation } = contribution;
    if (hasProviderDefinition(providerId) || ProtocolSchema.safeParse(providerId).success) {
      throw new BugIndicatingError(`Cannot override built-in provider '${providerId}'`);
    }
    return registerSlot(this.providers, providerId, pluginId, generation, Object.freeze({
      id: providerId,
      baseProtocol,
      adapterBaseId: contribution.adapterBaseId,
      traits: Object.freeze(contribution.traits.map((trait) => Object.freeze({ ...trait }))),
      endpoint: contribution.endpoint === undefined ? undefined : Object.freeze({ ...contribution.endpoint }),
      hostHeaders: contribution.hostHeaders,
      requestIdentityDeviceHeaders: contribution.requestIdentityDeviceHeaders,
    }));
  }

  generationOfProvider(id: string, protocol?: Protocol): number {
    const slot = this.providers.get(id);
    return slot?.value !== undefined && (protocol === undefined || slot.value.baseProtocol === protocol) ? slot.generation : 0;
  }

  providerDefinition(id: string, protocol?: Protocol): ProviderAdapterDefinition | undefined {
    const value = this.providers.get(id)?.value;
    if (value !== undefined && (protocol === undefined || value.baseProtocol === protocol)) return value;
    return getProviderDefinition(id, protocol);
  }

  adapterCacheKey(_protocol: Protocol, providerType?: string): string | undefined {
    const provider = providerType === undefined ? undefined : this.providers.get(providerType);
    if (provider === undefined) return undefined;
    const baseId = provider.value?.adapterBaseId;
    const base = baseId === undefined ? undefined : this.bases.get(baseId);
    return JSON.stringify([provider.generation, provider.value !== undefined, baseId, base?.generation, base?.value !== undefined]);
  }

  supportedProtocols(): readonly Protocol[] {
    return ProtocolSchema.options.filter((id) => getProtocolBase(id) !== undefined);
  }

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity {
    const definition = providerType === undefined ? undefined : this.providerDefinition(providerType, protocol);
    const baseId = definition?.adapterBaseId ?? protocol;
    const context: TraitContext = { config: { protocol, providerType, modelName: '' }, providerId: providerType };
    const traits: ResolvedTrait[] = (definition?.traits ?? []).map((trait) => ({ trait, context }));
    traits.push({ trait: CONFIG_DEFAULT_HEADERS_TRAIT, context });
    return { baseId, traits };
  }

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId {
    return (providerType === undefined ? undefined : this.providerDefinition(providerType, protocol)?.adapterBaseId) ?? protocol;
  }

  resolveCapability(protocol: Protocol, modelName: string, providerType?: string): ModelCapability {
    return this.explainCapability(protocol, modelName, providerType).capability;
  }

  explainCapability(protocol: Protocol, modelName: string, providerType?: string): ExplainedCapability {
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    let traitCapability: ModelCapability | undefined;
    for (const { trait, context } of identity.traits) {
      traitCapability = trait.capability?.(modelName, context) ?? traitCapability;
    }
    if (traitCapability !== undefined) {
      return { capability: traitCapability, source: { kind: 'builtin', detail: `trait capability hook (provider '${providerType ?? 'unregistered'}')` } };
    }
    const baseCapability = this.base(identity.baseId)?.capability?.(modelName);
    if (baseCapability !== undefined) {
      return { capability: baseCapability, source: { kind: 'builtin', detail: `protocol base '${identity.baseId}' catalog` } };
    }
    return { capability: UNKNOWN_CAPABILITY, source: { kind: 'none', detail: 'no capability source knew this model' } };
  }

  createChatProvider(config: ProtocolAdapterConfig): ChatProvider {
    const slot = config.providerType === undefined ? undefined : this.providers.get(config.providerType);
    if (slot !== undefined && slot.value?.baseProtocol !== config.protocol) {
      throw new ChatProviderError(`Dynamic provider '${config.providerType}' has no active adapter for '${config.protocol}'.`);
    }
    const identity = this.resolveAdapterIdentity(config.protocol, config.providerType);
    const base = this.base(identity.baseId);
    if (base === undefined) throw new ChatProviderError(`No active protocol base registered for '${identity.baseId}'.`);
    const traits = identity.traits.map(({ trait }) => ({ trait, context: { config, providerId: config.providerType } }));
    return base.createChatProvider({ config, traits });
  }

  private base(id: ProtocolBaseId): ProtocolBaseDefinition | undefined {
    return this.bases.get(id)?.value ?? getProtocolBase(id);
  }
}

registerScopedService(LifecycleScope.App, IProtocolAdapterRegistry, ProtocolAdapterRegistry, ScopeActivation.OnScopeCreated, 'provider');
