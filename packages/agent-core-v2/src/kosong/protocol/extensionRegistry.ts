import type { IDisposable } from '#/_base/di/lifecycle';

import type { Protocol } from './protocol';
import type { ProtocolBaseDefinition } from './protocolBase';
import type { ProtocolEndpoint, ProtocolTrait } from './protocolTrait';

/** Dynamic provider adapter contribution registered by E1 plugins. */
export interface DynamicProviderContribution {
  readonly pluginId: string;
  readonly generation: number;
  readonly providerId: string;
  readonly baseProtocol: Protocol;
  readonly traits: readonly ProtocolTrait[];
  readonly endpoint?: ProtocolEndpoint;
  readonly hostHeaders?: 'full' | 'user-agent';
  readonly requestIdentityDeviceHeaders?: boolean;
}

/** Dynamic protocol base contribution registered by E1 plugins for custom wire transports. */
export interface DynamicProtocolBaseContribution {
  readonly pluginId: string;
  readonly generation: number;
  readonly definition: ProtocolBaseDefinition;
}

/** Registry extension interface allowing dynamic registration and generation-safe withdrawal of Kosong adapters. */
export interface IDynamicProtocolExtensionRegistry {
  registerDynamicProtocolBase(contribution: DynamicProtocolBaseContribution): IDisposable;
  registerDynamicProvider(contribution: DynamicProviderContribution): IDisposable;
  generationOfProvider(providerId: string, protocol?: Protocol): number;
}
