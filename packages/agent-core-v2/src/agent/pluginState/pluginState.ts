import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

/** JSON value types permitted inside persisted E11 plugin state envelopes. */
export type PluginStateJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly PluginStateJsonValue[]
  | { readonly [key: string]: PluginStateJsonValue };

/** JSON object root required for each plugin's state slice. */
export type PluginStateJsonObject = { readonly [key: string]: PluginStateJsonValue };

/** Clock classification separating conversation-undoable state from monotonic world-time ledgers. */
export type PluginStateClockKind = 'conversation' | 'world';

/** Single plugin's versioned state envelope stored inside `plugin.states.conversation` or `plugin.states.world`. */
export interface PluginStateSliceEnvelope<S extends PluginStateJsonObject = PluginStateJsonObject> {
  readonly pluginId: string;
  readonly schemaVersion: number;
  readonly reducerVersion: number;
  readonly updatedAtRevision: number;
  readonly data: S;
}

/** Persisted wire payload for `plugin.fact_recorded` events written through Kiki's single-writer journal. */
export interface PluginFactRecordedPayload {
  readonly pluginId: string;
  readonly clock: PluginStateClockKind;
  readonly factType: string;
  readonly schemaVersion: number;
  readonly reducerVersion: number;
  readonly requiredForModel?: boolean;
  readonly payload: PluginStateJsonValue;
}

/**
 * Deterministic pure reducer specification for one clock. A version pair identifies an immutable interpretation.
 * New versions must reduce every historical factType and payload from canonical wire, starting from initial().
 * migrate converts existing slice data, not historical fact payloads.
 */
export interface PluginStateReducerSpec<S extends PluginStateJsonObject = PluginStateJsonObject> {
  readonly pluginId: string;
  readonly clock: PluginStateClockKind;
  readonly schemaVersion: number;
  readonly reducerVersion: number;
  readonly maxBytes?: number;
  readonly requiredForModel?: boolean;
  initial(): S;
  reduce(state: Readonly<S>, factType: string, payload: PluginStateJsonValue): S;
  migrate?(oldData: PluginStateJsonObject, fromSchemaVersion: number): S;
}

/** Checkpoint manifest entry binding a saved replay checkpoint to exact plugin reducer versions. */
export interface PluginCheckpointInterpretationEntry {
  readonly pluginId: string;
  readonly clock: PluginStateClockKind;
  readonly schemaVersion: number;
  readonly reducerVersion: number;
}

/** App-scoped registry of E11 plugin state reducers consulted during live dispatch and cold replay. */
export interface IPluginStateRegistryService {
  readonly _serviceBrand: undefined;

  registerReducer<S extends PluginStateJsonObject>(spec: PluginStateReducerSpec<S>): IDisposable;
  getReducer(
    pluginId: string,
    clock: PluginStateClockKind,
  ): PluginStateReducerSpec<PluginStateJsonObject> | undefined;
  interpretationManifest(): readonly PluginCheckpointInterpretationEntry[];
}

export const IPluginStateRegistryService: ServiceIdentifier<IPluginStateRegistryService> =
  createDecorator<IPluginStateRegistryService>('pluginStateRegistryService');

/** Agent-scoped host service owning `plugin.states.conversation` and `plugin.states.world` envelopes. */
export interface IAgentPluginStateService {
  readonly _serviceBrand: undefined;

  readSlice<S extends PluginStateJsonObject>(
    pluginId: string,
    clock: PluginStateClockKind,
  ): Readonly<S> | undefined;

  recordFact(input: {
    readonly pluginId: string;
    readonly clock: PluginStateClockKind;
    readonly factType: string;
    readonly payload: PluginStateJsonValue;
    readonly durable?: boolean;
  }): Promise<void>;

  unresolvedRequiredPlugins(): readonly string[];
}

export const IAgentPluginStateService: ServiceIdentifier<IAgentPluginStateService> =
  createDecorator<IAgentPluginStateService>('agentPluginStateService');
