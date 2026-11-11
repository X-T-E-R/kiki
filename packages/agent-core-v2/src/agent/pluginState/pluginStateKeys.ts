import { freeze, original } from 'immer';
import { z } from 'zod';

import '#/agent/contextMemory/conversationTime';
import { Event2 } from '#/app/event/event2';
import { defineState, type FoldContext } from '#/state/state';

import { PluginStateError } from './pluginStateErrors';
import type {
  IPluginStateRegistryService,
  PluginFactRecordedPayload,
  PluginStateClockKind,
  PluginStateJsonObject,
  PluginStateJsonValue,
  PluginStateSliceEnvelope,
} from './pluginState';

export const MAX_PLUGIN_STATE_BYTES = 64 * 1024;

const version = z.number().int().nonnegative();
const id = z.string().min(1);
const jsonObject = z.custom<PluginStateJsonObject>((value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value));

export class PluginFactRecorded extends Event2<PluginFactRecordedPayload> {
  static override readonly type = 'plugin.fact_recorded';
  static override readonly durable = true;
  static override readonly schema = z.object({
    pluginId: id,
    clock: z.enum(['conversation', 'world']),
    factType: id,
    schemaVersion: version,
    reducerVersion: version,
    requiredForModel: z.boolean().optional(),
    payload: z.json(),
  });

  declare readonly pluginId: string;
  declare readonly clock: PluginStateClockKind;
  declare readonly factType: string;
  declare readonly schemaVersion: number;
  declare readonly reducerVersion: number;
  declare readonly requiredForModel?: boolean;
  declare readonly payload: PluginStateJsonValue;

  constructor(payload: PluginFactRecordedPayload, time?: number) {
    if (payload.payload === undefined) throw new PluginStateError('plugin_state.invalid_fact', 'Plugin facts require a JSON payload.');
    const { requiredForModel, ...fact } = payload;
    super(PluginFactRecorded.schema.parse(clonePluginJson(requiredForModel === undefined ? fact : { ...fact, requiredForModel })), time);
    freeze(this.payload, true);
    Object.freeze(this);
  }
}

const sliceSchema: z.ZodType<PluginStateSliceEnvelope> = z.object({
  pluginId: id,
  schemaVersion: version,
  reducerVersion: version,
  updatedAtRevision: version,
  data: jsonObject,
});

const entrySchema = z.object({
  slice: sliceSchema.optional(),
  required: z.boolean(),
  unresolved: z.boolean(),
});

type LedgerEntry = z.infer<typeof entrySchema>;
type Ledger = Record<string, LedgerEntry>;
const ledgerSchema = z.record(z.string(), entrySchema);

export const pluginConversationStateKey = defineState('plugin.states.conversation', (): Ledger => ({}))
  .replayable({ schema: ledgerSchema })
  .undoable()
  .on(PluginFactRecorded, (state, fact, ctx) => foldFact('conversation', state as unknown as Ledger, fact, ctx));

export const pluginWorldStateKey = defineState('plugin.states.world', (): Ledger => ({}))
  .replayable({ schema: ledgerSchema })
  .on(PluginFactRecorded, (state, fact, ctx) => foldFact('world', state as unknown as Ledger, fact, ctx));

export const pluginStateKeys = {
  conversation: pluginConversationStateKey,
  world: pluginWorldStateKey,
} as const;

export function pluginLedgerKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export function pluginEntryIsCurrent(
  pluginId: string,
  clock: PluginStateClockKind,
  entry: LedgerEntry,
  registry: IPluginStateRegistryService | undefined,
): boolean {
  const spec = registry?.getReducer(pluginId, clock);
  if (spec === undefined) return entry.slice === undefined;
  return !entry.unresolved && entry.slice?.schemaVersion === spec.schemaVersion && entry.slice.reducerVersion === spec.reducerVersion;
}

function foldFact(clock: PluginStateClockKind, draft: Ledger, fact: PluginFactRecorded, ctx: FoldContext): void {
  if (fact.clock !== clock) return;
  const key = pluginLedgerKey(fact.pluginId);
  const previous = original<Record<string, unknown>>(draft)?.[key] as LedgerEntry | undefined;
  const spec = ctx.pluginStateRegistry?.getReducer(fact.pluginId, clock);
  const required = fact.requiredForModel === true || previous?.required === true;
  if (spec === undefined || fact.schemaVersion > spec.schemaVersion || fact.reducerVersion > spec.reducerVersion) {
    draft[key] = { slice: previous?.slice, required, unresolved: true };
    return;
  }
  if (previous !== undefined && !pluginEntryIsCurrent(fact.pluginId, clock, previous, ctx.pluginStateRegistry)) {
    if (ctx.silent && previous.unresolved) {
      draft[key] = { slice: previous.slice, required, unresolved: true };
      return;
    }
    throw new PluginStateError('plugin_state.replay_required', `Reopen the agent to replay state for plugin '${fact.pluginId}' with the active reducer.`);
  }
  const old = previous?.slice;
  const limit = spec.maxBytes ?? MAX_PLUGIN_STATE_BYTES;
  const initial = old === undefined ? spec.initial() : old.data;
  const data = cloneSlice(spec.reduce(cloneSlice(initial, limit), fact.factType, fact.payload), limit);
  draft[key] = {
    required,
    unresolved: false,
    slice: {
      pluginId: fact.pluginId,
      schemaVersion: spec.schemaVersion,
      reducerVersion: spec.reducerVersion,
      updatedAtRevision: (old?.updatedAtRevision ?? 0) + 1,
      data,
    },
  };
}

function cloneSlice(data: PluginStateJsonObject, limit: number): PluginStateJsonObject {
  return jsonObject.parse(clonePluginJson(data, limit));
}

function clonePluginJson<T>(value: T, limit = MAX_PLUGIN_STATE_BYTES): T {
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, part: unknown) => {
      if (part === undefined || typeof part === 'function' || typeof part === 'symbol' ||
        (typeof part === 'number' && !Number.isFinite(part))) throw new TypeError('Value is not JSON');
      return part;
    });
  } catch (error) {
    throw new PluginStateError('plugin_state.invalid_fact', 'Plugin state and facts must be JSON values.', { cause: error });
  }
  if (Buffer.byteLength(encoded, 'utf8') > limit) {
    throw new PluginStateError('plugin_state.invalid_fact', `Plugin state or fact exceeds the ${limit}-byte limit.`);
  }
  return freeze(JSON.parse(encoded) as T, true);
}
