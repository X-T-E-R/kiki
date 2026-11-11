import { freeze } from 'immer';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  IPluginStateRegistryService,
  type IAgentPluginStateService,
  type PluginCheckpointInterpretationEntry,
  type PluginStateClockKind,
  type PluginStateJsonObject,
  type PluginStateReducerSpec,
} from './pluginState';
import { PluginStateError } from './pluginStateErrors';
import {
  MAX_PLUGIN_STATE_BYTES,
  PluginFactRecorded,
  pluginConversationStateKey,
  pluginEntryIsCurrent,
  pluginLedgerKey,
  pluginStateKeys,
  pluginWorldStateKey,
} from './pluginStateKeys';

export class PluginStateRegistryService implements IPluginStateRegistryService {
  declare readonly _serviceBrand: undefined;

  private readonly reducers = {
    conversation: new Map<string, PluginStateReducerSpec>(),
    world: new Map<string, PluginStateReducerSpec>(),
  };

  registerReducer<S extends PluginStateJsonObject>(spec: PluginStateReducerSpec<S>): IDisposable {
    const { pluginId, clock, schemaVersion, reducerVersion, maxBytes } = spec;
    if (!pluginId || !Number.isSafeInteger(schemaVersion) || schemaVersion < 0 ||
        !Number.isSafeInteger(reducerVersion) || reducerVersion < 0 ||
        (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PLUGIN_STATE_BYTES))) {
      throw new PluginStateError('plugin_state.invalid_fact', `Invalid reducer declaration for plugin '${pluginId}'.`);
    }
    const registry = this.reducers[clock];
    const previous = registry.get(pluginId);
    if (previous?.schemaVersion === schemaVersion && previous.reducerVersion === reducerVersion) {
      throw new PluginStateError('plugin_state.invalid_fact', `Plugin '${pluginId}' must change its schemaVersion or reducerVersion when replacing a reducer.`);
    }
    const entry: PluginStateReducerSpec = Object.freeze({
      pluginId, clock, schemaVersion, reducerVersion, maxBytes,
      requiredForModel: spec.requiredForModel,
      initial: spec.initial.bind(spec),
      reduce: spec.reduce.bind(spec) as PluginStateReducerSpec['reduce'],
      migrate: spec.migrate?.bind(spec),
    });
    registry.set(pluginId, entry);
    return toDisposable(() => {
      if (registry.get(pluginId) === entry) registry.delete(pluginId);
    });
  }

  getReducer(pluginId: string, clock: PluginStateClockKind): PluginStateReducerSpec | undefined {
    return this.reducers[clock].get(pluginId);
  }

  interpretationManifest(): readonly PluginCheckpointInterpretationEntry[] {
    return Object.values(this.reducers).flatMap((registry) => [...registry.values()]
      .toSorted((left, right) => left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0)
      .map(({ pluginId, clock, schemaVersion, reducerVersion }) => ({ pluginId, clock, schemaVersion, reducerVersion })));
  }
}

export class AgentPluginStateService extends Disposable implements IAgentPluginStateService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IPluginStateRegistryService private readonly registry: IPluginStateRegistryService,
  ) {
    super();
    this._register(states.contributeState(pluginConversationStateKey));
    this._register(states.contributeState(pluginWorldStateKey));
  }

  readSlice<S extends PluginStateJsonObject>(pluginId: string, clock: PluginStateClockKind): Readonly<S> | undefined {
    const entry = this.states.get(pluginStateKeys[clock])[pluginLedgerKey(pluginId)];
    if (entry === undefined || !pluginEntryIsCurrent(pluginId, clock, entry, this.registry)) return undefined;
    const data = entry.slice?.data;
    return data === undefined ? undefined : freeze(data, true) as Readonly<S>;
  }

  async recordFact(input: Parameters<IAgentPluginStateService['recordFact']>[0]): Promise<void> {
    const spec = this.registry.getReducer(input.pluginId, input.clock);
    if (spec === undefined) {
      throw new PluginStateError('plugin_state.invalid_fact', `No ${input.clock} reducer registered for plugin '${input.pluginId}'.`);
    }
    const event = new PluginFactRecorded({
      pluginId: input.pluginId,
      clock: input.clock,
      factType: input.factType,
      payload: input.payload,
      schemaVersion: spec.schemaVersion,
      reducerVersion: spec.reducerVersion,
      requiredForModel: spec.requiredForModel,
    });
    if (input.durable === false) await this.dispatcher.dispatch(event);
    else await this.dispatcher.dispatchDurably(event);
  }

  unresolvedRequiredPlugins(): readonly string[] {
    const unresolved = new Set<string>();
    for (const clock of ['conversation', 'world'] as const) {
      for (const [key, entry] of Object.entries(this.states.get(pluginStateKeys[clock]))) {
        if (!entry.required) continue;
        const pluginId = key.slice('plugin:'.length);
        if (entry.unresolved || !pluginEntryIsCurrent(pluginId, clock, entry, this.registry)) unresolved.add(pluginId);
      }
    }
    return [...unresolved].toSorted();
  }
}
