import { applyPatches, produceWithPatches } from 'immer';

import { BugIndicatingError } from '#/_base/errors/errors';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { timeRestorePhase } from '#/session/agentLifecycle/restoreTiming';
import { type CollectionView } from '#/_base/di/collection';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { event2FromRecord, type Event2, type Event2Class } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { ContentPart } from '#/kosong/contract/message';
import { OrderedHookSlot } from '#/hooks';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWireService, JOURNAL_HEAD_HASH_BYTES, JournalTailUnreadableError } from '#/wire/wire';
import { WireError, WireErrors } from '#/wire/errors';
import type { PartsTransformer } from '#/wire/record';

import { IEventDispatcher } from './eventDispatcher';
import { StateError, StateErrors } from './errors';
import {
  decodeReplayCheckpointGraph,
  encodeReplayCheckpointGraphAsync,
  type ReplayCheckpointGraph,
} from './replayCheckpointCodec';
import {
  keepsUndoCheckpoints,
  type FoldContext,
  type PatchEntry,
  type ReplayableStateKey,
} from './state';
import {
  EventStateContribution,
  foldEventStateContributions,
  type EventStateContributionRecord,
  type FoldedEventStateRegistry,
} from './stateContribution';

const MAX_DRAIN = 100;
const HISTORY_TAIL = 500;
const REPLAY_CHECKPOINT_SCOPE = 'replay-checkpoints';
const REPLAY_CHECKPOINT_KEY = 'engine-v1';
export const REPLAY_CHECKPOINT_GROWTH_BYTES = 8 * 1024 * 1024;
const REPLAY_CHECKPOINT_GROWTH_DELAY_MS = 1_000;
export const REPLAY_ABI_VERSION = 2;

interface ReplayCheckpointEnvelope {
  readonly format: 1;
  readonly replayAbi: number;
  readonly wire: {
    readonly size: number;
    readonly mtimeMs: number;
    readonly headHash?: string;
    readonly prefixSha256?: string;
  };
  readonly stateNames: readonly string[];
  readonly graph: ReplayCheckpointGraph;
}

interface ReplayCheckpointPayload {
  readonly states: readonly {
    readonly name: string;
    readonly value: unknown;
    readonly meta: StateMeta;
  }[];
}

export class CycleError extends StateError {
  constructor(readonly depth: number, readonly eventTypes: readonly string[]) {
    super(
      StateErrors.codes.STATE_CYCLE,
      `Event dispatch cascade exceeded MAX_DRAIN (${depth}); possible event cycle`,
      { details: { depth, eventTypes: eventTypes.slice(0, 20) } },
    );
    this.name = 'CycleError';
  }
}

interface StateMeta {
  history: PatchEntry[];
  checkpoints: number[];
  nextPatchId: number;
}

interface QueuedEvent {
  readonly event: Event2<any>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PreparedFold {
  readonly key: ReplayableStateKey<any>;
  readonly meta: StateMeta;
  readonly ctx: FoldContextImpl;
  readonly next: any;
  readonly patches: PatchEntry['patches'];
  readonly inversePatches: PatchEntry['inversePatches'];
}

type RestorePhase = 'new' | 'restoring' | 'ready' | 'failed';

class FoldContextImpl implements FoldContext {
  pendingCheckpoint = false;
  pendingClear = false;
  pendingUndo: number | undefined;

  constructor(
    private readonly owner: EventDispatcherService,
    readonly silent: boolean,
  ) {}

  checkpoint(): void {
    this.pendingCheckpoint = true;
  }

  clearCheckpoints(): void {
    this.pendingClear = true;
  }

  afterUndo: ((state: any) => any) | undefined;

  undoToCheckpoint(count: number, afterUndo?: (state: any) => any): void {
    this.pendingUndo = count;
    this.afterUndo = afterUndo;
  }

  emit(event: Event2<any>): void {
    if (this.silent) return;
    this.owner.enqueue(event);
  }
}

export class EventDispatcherService extends Service implements IEventDispatcher {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IEventDispatcher['hooks'] = {
    onDidRestore: new OrderedHookSlot(),
  };

  private readonly metas = new Map<ReplayableStateKey<any>, StateMeta>();
  private folded: FoldedEventStateRegistry;

  private restorePhase: RestorePhase = 'new';
  private checkpointSave: Promise<boolean> | undefined;
  private savedCheckpoint: { readonly revision: number; readonly wire: ReplayCheckpointEnvelope['wire'] } | undefined;
  private growthCheckpointTimer: ReturnType<typeof setTimeout> | undefined;
  private growthCheckpointBaseline = 0;
  private checkpointGeneration = 0;
  private disposed = false;
  private dispatching = false;
  private queue: QueuedEvent[] = [];
  private drainDepth = 0;
  private liveRevision = 0;
  private readonly deferredObservable = new Set<Event2<any>>();
  private readonly durableInFlight = new Map<Event2<any>, Promise<void>>();
  private readonly durableDispatchFailures = new WeakMap<Event2<any>, { readonly error: unknown }>();

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @EventStateContribution view: CollectionView<EventStateContributionRecord>,
    @ref(IAtomicDocumentStore) private readonly docs: LiveRef<IAtomicDocumentStore>,
    @ref(IAgentScopeContext) private readonly scope: LiveRef<IAgentScopeContext>,
    @ref(ILogService) private readonly log: LiveRef<ILogService>,
  ) {
    super();
    this.folded = this.foldContributions(view);
    this._register(
      view.onDidChange(() => {
        this.folded = this.foldContributions(view);
      }),
    );
    this._register(
      this.agentState.onDidContributeReplayable((key) => {
        if (this.restorePhase !== 'new') {
          throw new BugIndicatingError(
            `Replayable state '${key.name}' contributed while the event dispatcher is in phase '${this.restorePhase}'; replayable state owners must contribute before restore`,
          );
        }
        this.folded = this.foldContributions(view);
      }),
    );
    this._register(
      this.agentState.onDidWithdrawReplayable((key) => {
        this.metas.delete(key);
        this.liveRevision += 1;
        this.folded = this.foldContributions(view);
      }),
    );
    this._register(this.wire.onDidAppendBytes?.((appendedBytes) => {
      this.noteJournalGrowth(appendedBytes);
    }) ?? { dispose: () => {} });
    this._register({
      dispose: () => {
        this.disposed = true;
        this.checkpointGeneration += 1;
        if (this.growthCheckpointTimer !== undefined) clearTimeout(this.growthCheckpointTimer);
        this.growthCheckpointTimer = undefined;
      },
    });
  }

  private foldContributions(
    view: CollectionView<EventStateContributionRecord>,
  ): FoldedEventStateRegistry {
    return foldEventStateContributions(view.items, this.agentState.replayableKeys());
  }

  history<S>(key: ReplayableStateKey<S>): readonly PatchEntry[] {
    return this.ensureMeta(key).history;
  }

  checkpointDepth(key: ReplayableStateKey<any>): number {
    const meta = this.metas.get(key);
    return meta?.checkpoints.length ?? 0;
  }

  undo<S>(key: ReplayableStateKey<S>, patchId: number): void {
    const meta = this.ensureMeta(key);
    const head = meta.history.at(-1);
    if (head === undefined || patchId > head.id || patchId <= 0) {
      throw new BugIndicatingError(
        `undo patch id ${patchId} is outside the retained history of state '${key.name}'`,
      );
    }
    const firstRetained = meta.history[0]!.id;
    if (patchId < firstRetained) {
      throw new BugIndicatingError(
        `undo patch id ${patchId} has been trimmed from the history of state '${key.name}'`,
      );
    }
    this.rollback(key, meta, patchId - 1);
    meta.checkpoints = meta.checkpoints.filter((id) => id < patchId);
    this.liveRevision += 1;
  }

  dispatchDurably(event: Event2<any>): Promise<void> {
    const current = this.durableInFlight.get(event);
    if (current !== undefined) return current;
    const pending = this.commitDurably(event).finally(() => { this.durableInFlight.delete(event); });
    this.durableInFlight.set(event, pending);
    return pending;
  }

  private async commitDurably(event: Event2<any>): Promise<void> {
    const failure = this.durableDispatchFailures.get(event);
    if (failure !== undefined) throw failure.error;
    if (!this.deferredObservable.has(event)) {
      this.deferredObservable.add(event);
      try { await this.dispatch(event); }
      catch (error) {
        this.durableDispatchFailures.set(event, { error });
        throw error;
      }
    }
    try {
      await this.flush();
    } catch {
      await this.flush();
    }
    this.deferredObservable.delete(event);
    if ((event.constructor as Event2Class).observable) this.eventBus.publish(event);
  }

  dispatch(event: Event2<any>): Promise<void> {
    if (this.dispatching) {
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ event, resolve, reject });
      });
    }
    this.dispatching = true;
    try {
      this.runDispatch(event);
      while (this.queue.length > 0) {
        if (++this.drainDepth > MAX_DRAIN) {
          throw new CycleError(
            this.drainDepth,
            this.queue.map((entry) => entry.event.type),
          );
        }
        const entry = this.queue.shift()!;
        try {
          this.runDispatch(entry.event);
          entry.resolve();
        } catch (error) {
          entry.reject(error);
          throw error;
        }
      }
      return Promise.resolve();
    } catch (error) {
      for (const entry of this.queue.splice(0)) {
        entry.reject(error);
      }
      return Promise.reject(error);
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
      this.drainDepth = 0;
    }
  }

  enqueue(event: Event2<any>): void {
    this.queue.push({
      event,
      resolve: () => {},
      reject: (error: unknown) => onUnexpectedError(error),
    });
  }

  private runDispatch(event: Event2<any>): void {
    this.executeEvent(event, false);
  }

  private executeEvent(event: Event2<any>, silent: boolean): void {
    const folds = this.folded.folds.get(event.type);
    const prepared: PreparedFold[] = [];
    if (folds !== undefined) {
      for (const { key, fold } of folds) {
        const meta = this.ensureMeta(key);
        const ctx = new FoldContextImpl(this, silent);
        let previous = this.agentState.get(key);
        let [next, patches, inversePatches] = produceWithPatches<any>(
          previous,
          (draft: any) => fold(draft, event, ctx) as any,
        );
        if (ctx.pendingUndo !== undefined && patches.length > 0) {
          throw new BugIndicatingError(
            `Fold of event '${event.type}' on state '${key.name}' both mutates and undoes to a checkpoint`,
          );
        }
        if (
          ctx.pendingUndo !== undefined &&
          (!Number.isSafeInteger(ctx.pendingUndo) ||
            ctx.pendingUndo <= 0 ||
            meta.checkpoints.length < ctx.pendingUndo)
        ) {
          ctx.pendingUndo = undefined;
        }
        if (ctx.pendingUndo !== undefined && ctx.afterUndo !== undefined) {
          const targetId = meta.checkpoints[meta.checkpoints.length - ctx.pendingUndo]!;
          let restored = this.agentState.get(key);
          for (let index = meta.history.length - 1; index >= 0 && meta.history[index]!.id > targetId; index--) {
            restored = applyPatches(restored, [...meta.history[index]!.inversePatches]);
          }
          previous = restored;
          [next, patches, inversePatches] = produceWithPatches<any>(restored, ctx.afterUndo);
        }
        const compacted = compactArrayReplacement(previous, next, patches, inversePatches);
        prepared.push({ key, meta, ctx, next, ...compacted });
      }
    }
    for (const p of prepared) {
      this.commit(p.key, p.meta, p.ctx, event, p.next, p.patches, p.inversePatches);
    }
    if (silent) return;
    const cls = event.constructor as Event2Class;
    if (cls.durable) {
      const dehydrator = folds?.find(({ key }) => key.replayable.blobs !== undefined)?.key
        .replayable.blobs?.dehydrate;
      this.wire.appendRecord(event.serialize(), dehydrator);
    }
    this.liveRevision += 1;
    if (cls.observable && !this.deferredObservable.has(event)) {
      this.eventBus.publish(event);
    }
  }

  private commit(
    key: ReplayableStateKey<any>,
    meta: StateMeta,
    ctx: FoldContextImpl,
    event: Event2<any>,
    next: any,
    patches: PatchEntry['patches'],
    inversePatches: PatchEntry['inversePatches'],
  ): void {
    if (ctx.pendingUndo !== undefined) {
      const targetIndex = meta.checkpoints.length - ctx.pendingUndo;
      const targetId = meta.checkpoints[targetIndex]!;
      this.rollback(key, meta, targetId);
      meta.checkpoints = meta.checkpoints.slice(0, targetIndex);
      if (ctx.afterUndo === undefined) return;
    }
    this.agentState.set(key, next);
    if (ctx.pendingClear) {
      meta.history = [];
      meta.checkpoints = [];
    }
    const markerId = meta.history.at(-1)?.id ?? 0;
    if (patches.length > 0 || inversePatches.length > 0) {
      const entry: PatchEntry = {
        id: meta.nextPatchId++,
        eventType: event.type,
        patches,
        inversePatches,
      };
      meta.history.push(entry);
    }
    if (ctx.pendingCheckpoint) {
      meta.checkpoints.push(markerId);
    }
    this.trimHistory(key, meta);
  }

  private rollback(key: ReplayableStateKey<any>, meta: StateMeta, targetEntryId: number): void {
    let i = meta.history.length - 1;
    let current = this.agentState.get(key);
    while (i >= 0 && meta.history[i]!.id > targetEntryId) {
      current = applyPatches(current, [...meta.history[i]!.inversePatches]);
      i--;
    }
    this.agentState.set(key, current);
    meta.history = meta.history.slice(0, i + 1);
  }

  private trimHistory(key: ReplayableStateKey<any>, meta: StateMeta): void {
    const oldest = meta.checkpoints[0];
    if (oldest !== undefined) {
      const firstRetained = meta.history.findIndex((entry) => entry.id >= oldest);
      if (firstRetained > 0) {
        meta.history.splice(0, firstRetained);
      }
      return;
    }
    if (!keepsUndoCheckpoints(key) && meta.history.length > HISTORY_TAIL) {
      meta.history.splice(0, meta.history.length - HISTORY_TAIL);
    }
  }

  private ensureMeta(key: ReplayableStateKey<any>): StateMeta {
    let meta = this.metas.get(key);
    if (meta === undefined) {
      meta = { history: [], checkpoints: [], nextPatchId: 1 };
      this.metas.set(key, meta);
    }
    return meta;
  }

  private noteJournalGrowth(appendedBytes: number): void {
    if (this.disposed) return;
    if (appendedBytes < this.growthCheckpointBaseline) this.growthCheckpointBaseline = appendedBytes;
    if (this.restorePhase !== 'ready' || this.growthCheckpointTimer !== undefined) return;
    if (appendedBytes - this.growthCheckpointBaseline < REPLAY_CHECKPOINT_GROWTH_BYTES) return;
    const generation = this.checkpointGeneration;
    const timer = setTimeout(() => {
      if (this.growthCheckpointTimer === timer) this.growthCheckpointTimer = undefined;
      if (!this.isCheckpointGenerationCurrent(generation)) return;
      void this.saveReplayCheckpoint().catch((error: unknown) => {
        if (this.isCheckpointGenerationCurrent(generation)) onUnexpectedError(error);
      });
    }, REPLAY_CHECKPOINT_GROWTH_DELAY_MS);
    timer.unref?.();
    this.growthCheckpointTimer = timer;
  }

  private checkpointScope(): string | undefined {
    return this.scope.current?.scope(REPLAY_CHECKPOINT_SCOPE);
  }

  private isCheckpointGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.checkpointGeneration;
  }

  async saveReplayCheckpoint(): Promise<boolean> {
    const ongoing = this.checkpointSave;
    if (ongoing !== undefined) return ongoing;
    const generation = this.checkpointGeneration;
    const startedAppendedBytes = this.wire.appendedByteCount?.();
    const save = this.writeReplayCheckpoint(generation);
    this.checkpointSave = save;
    try {
      const saved = await save;
      if (this.isCheckpointGenerationCurrent(generation)) {
        const appendedBytes = this.wire.appendedByteCount?.();
        if (saved) {
          this.noteJournalGrowth(appendedBytes ?? this.growthCheckpointBaseline);
        } else if (
          startedAppendedBytes !== undefined &&
          appendedBytes !== undefined &&
          appendedBytes > startedAppendedBytes
        ) {
          this.noteJournalGrowth(appendedBytes);
        }
      }
      return saved;
    } finally {
      if (this.checkpointSave === save) this.checkpointSave = undefined;
    }
  }

  private checkpointSkipReason: string | undefined;

  replayCheckpointSkipReason(): string | undefined {
    return this.checkpointSkipReason;
  }

  private skipReplayCheckpoint(reason: string): false {
    this.checkpointSkipReason = reason;
    return false;
  }

  private checkpointStable(generation: number, revision = this.liveRevision): boolean {
    if (!this.isCheckpointGenerationCurrent(generation)) return this.skipReplayCheckpoint('disposed');
    if (this.deferredObservable.size > 0) return this.skipReplayCheckpoint('pending_events');
    if (revision !== this.liveRevision) return this.skipReplayCheckpoint('state_changed');
    return true;
  }

  private async writeReplayCheckpoint(generation: number): Promise<boolean> {
    this.checkpointSkipReason = undefined;
    const checkpointScope = this.checkpointScope();
    const docs = this.docs.current;
    if (!this.checkpointStable(generation)) return false;
    if (docs === undefined || checkpointScope === undefined || this.wire.journalIdentity === undefined) {
      return this.skipReplayCheckpoint('unavailable');
    }
    let phase = 'flush';
    try {
      const keys = this.agentState.replayableKeys()
        .filter((key) => key.replayable.durable)
        .toSorted((left, right) => left.name.localeCompare(right.name));
      await this.wire.flush();
      if (!this.checkpointStable(generation)) return false;
      const revision = this.liveRevision;
      phase = 'journal_identity';
      const wire = await this.wire.journalIdentity();
      if (!this.checkpointStable(generation, revision)) return false;
      const saved = this.savedCheckpoint;
      if (saved?.revision === revision && saved.wire.size === wire.size &&
        saved.wire.mtimeMs === wire.mtimeMs && saved.wire.headHash === wire.headHash) return true;
      phase = 'journal_digest';
      const prefixSha256 = this.wire.journalSha256 === undefined
        ? undefined
        : await this.wire.journalSha256(wire.size);
      if (this.wire.journalSha256 !== undefined && prefixSha256 === undefined) return this.skipReplayCheckpoint('journal_changed');
      if (!this.checkpointStable(generation, revision)) return false;
      phase = 'encode';
      const payload: ReplayCheckpointPayload = {
        states: keys.map((key) => ({
          name: key.name,
          value: this.agentState.get(key),
          meta: this.ensureMeta(key),
        })),
      };
      const graph = await encodeReplayCheckpointGraphAsync(payload);
      if (!this.checkpointStable(generation, revision)) return false;
      const coveredAppendedBytes = this.wire.appendedByteCount?.() ?? this.growthCheckpointBaseline;
      const envelope: ReplayCheckpointEnvelope = {
        format: 1,
        replayAbi: REPLAY_ABI_VERSION,
        wire: prefixSha256 === undefined ? wire : { ...wire, prefixSha256 },
        stateNames: keys.map((key) => key.name),
        graph,
      };
      phase = 'write';
      await docs.set(checkpointScope, REPLAY_CHECKPOINT_KEY, envelope, { cooperative: true });
      if (!this.isCheckpointGenerationCurrent(generation)) return this.skipReplayCheckpoint('disposed');
      this.savedCheckpoint = { revision, wire };
      this.growthCheckpointBaseline = coveredAppendedBytes;
      return true;
    } catch (error) {
      throw new Error(`replay checkpoint ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private async restoreReplayCheckpoint(): Promise<{ readonly tailByte?: number } | undefined> {
    const checkpointScope = this.checkpointScope();
    const docs = this.docs.current;
    if (docs === undefined || checkpointScope === undefined || this.wire.journalIdentity === undefined) {
      return undefined;
    }
    try {
      const envelope = await docs.get<ReplayCheckpointEnvelope>(
        checkpointScope,
        REPLAY_CHECKPOINT_KEY,
      );
      if (envelope?.format !== 1 || envelope.replayAbi !== REPLAY_ABI_VERSION) return undefined;
      const wire = await this.wire.journalIdentity();
      if (envelope.wire.headHash === undefined) return undefined;
      const headMatches = envelope.wire.headHash === wire.headHash;
      const keys = this.agentState.replayableKeys()
        .filter((key) => key.replayable.durable)
        .toSorted((left, right) => left.name.localeCompare(right.name));
      if (
        keys.length !== envelope.stateNames.length ||
        keys.some((key, index) => key.name !== envelope.stateNames[index])
      ) {
        return undefined;
      }
      const exact = headMatches && wire.size === envelope.wire.size && wire.mtimeMs === envelope.wire.mtimeMs;
      let tailByte: number | undefined;
      if (!exact) {
        if (wire.size < envelope.wire.size) return undefined;
        if (!headMatches && envelope.wire.size >= JOURNAL_HEAD_HASH_BYTES) return undefined;
        const sealed = this.wire.sealedJournalDigest?.();
        const prefixSha256 = isSha256(envelope.wire.prefixSha256)
          ? envelope.wire.prefixSha256
          : sealed !== undefined && sealed.size === envelope.wire.size && isSha256(sealed.sha256)
            ? sealed.sha256
            : undefined;
        if (prefixSha256 === undefined || this.wire.journalSha256 === undefined) return undefined;
        if (await this.wire.journalSha256(envelope.wire.size) !== prefixSha256) return undefined;
        if (wire.size > envelope.wire.size) tailByte = envelope.wire.size;
      }
      const payload = decodeReplayCheckpointGraph(envelope.graph) as ReplayCheckpointPayload;
      if (!Array.isArray(payload.states) || payload.states.length !== keys.length) return undefined;
      const restored: { readonly key: ReplayableStateKey<any>; readonly value: unknown; readonly meta: StateMeta }[] = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        const saved = payload.states[index];
        if (saved?.name !== key.name || !isStateMeta(saved.meta)) return undefined;
        const parsed = key.replayable.schema.safeParse(saved.value);
        if (!parsed.success) return undefined;
        const meta: StateMeta = saved.meta;
        meta.history = meta.history.map((entry) => ({
          ...entry,
          ...compactArrayReplacement(entry.inversePatches[0]?.value, entry.patches[0]?.value, entry.patches, entry.inversePatches),
        }));
        restored.push({ key, value: parsed.data, meta });
      }
      for (const entry of restored) {
        this.agentState.set(entry.key, Object.freeze(entry.value));
        this.metas.set(entry.key, entry.meta);
      }
      return { tailByte };
    } catch {
      this.resetReplayableState();
      return undefined;
    }
  }

  private resetReplayableState(): void {
    this.metas.clear();
    for (const key of this.agentState.replayableKeys()) {
      this.agentState.set(key, key.initial());
    }
  }

  async restore(): Promise<void> {
    if (this.restorePhase !== 'new') {
      throw new BugIndicatingError(
        `Agent state restore called while phase is ${this.restorePhase}`,
      );
    }
    this.restorePhase = 'restoring';
    const context = { agentId: this.scope.current?.agentId };
    const phase = <T>(name: string, action: () => Promise<T>) => timeRestorePhase(this.log.current, context, name, action);
    try {
      const checkpointRestored = await phase('checkpoint_restore', () => this.restoreReplayCheckpoint());
      if (checkpointRestored === undefined) {
        await phase('journal_replay', () => this.replayJournal());
      } else if (checkpointRestored.tailByte !== undefined) {
        try {
          await phase('journal_tail_replay', () => this.replayJournal(checkpointRestored.tailByte));
        } catch (error) {
          if (!(error instanceof JournalTailUnreadableError)) throw error;
          this.resetReplayableState();
          await phase('journal_replay', () => this.replayJournal());
        }
      }
      await phase('state_rehydrate', () => this.rehydrateStates());
      this.restorePhase = 'ready';
      if (checkpointRestored === undefined || checkpointRestored.tailByte !== undefined) {
        void this.saveReplayCheckpoint().catch(onUnexpectedError);
      }
      await phase('restore_hooks', () => this.hooks.onDidRestore.run({}));
    } catch (error) {
      this.restorePhase = 'failed';
      throw error;
    }
  }

  private async replayJournal(startByte?: number): Promise<void> {
    let recordIndex = 0;
    const source = startByte === undefined
      ? this.wire.readJournal()
      : this.wire.readJournal({ startByte });
    for await (const record of source) {
      if (record.type === 'metadata') continue;
      const cls = this.folded.events.get(record.type);
      if (cls === undefined) {
        this.reportSkippedRecord(record.type, recordIndex, false);
        recordIndex++;
        continue;
      }
      const event = event2FromRecord(cls, record);
      if (event === undefined) {
        this.reportSkippedRecord(record.type, recordIndex, true);
        recordIndex++;
        continue;
      }
      this.executeEvent(event, true);
      recordIndex++;
    }
  }

  private reportSkippedRecord(type: string, index: number, malformed: boolean): void {
    onUnexpectedError(
      new WireError(
        WireErrors.codes.WIRE_UNKNOWN_RECORD,
        malformed
          ? `Malformed wire record type '${type}' skipped during restore`
          : `Unknown wire record type '${type}' skipped during restore`,
        { details: { type, index } },
      ),
    );
  }

  private async rehydrateStates(): Promise<void> {
    const transform: PartsTransformer = (parts) =>
      this.blobService.loadParts(parts as readonly ContentPart[]) as Promise<readonly unknown[]>;
    for (const key of this.folded.states) {
      const codec = key.replayable.blobs;
      if (codec?.rehydrate === undefined) continue;
      this.agentState.set(key, Object.freeze(await codec.rehydrate(this.agentState.get(key), transform)));
    }
  }

  async flush(): Promise<void> {
    await this.wire.flush();
  }
}

function compactArrayReplacement(
  previous: unknown,
  next: unknown,
  patches: PatchEntry['patches'],
  inversePatches: PatchEntry['inversePatches'],
): Pick<PreparedFold, 'patches' | 'inversePatches'> {
  if (patches.length !== 1 || inversePatches.length !== 1 ||
      patches[0]?.op !== 'replace' || patches[0].path.length > 0 ||
      inversePatches[0]?.op !== 'replace' || inversePatches[0].path.length > 0 ||
      !isDenseArray(previous) || !isDenseArray(next)) return { patches, inversePatches };
  const forward: import('immer').Patch[] = [];
  const backward: import('immer').Patch[] = [];
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index++) {
    if (Object.is(previous[index], next[index])) continue;
    forward.push({ op: 'replace', path: [index], value: next[index] });
    backward.push({ op: 'replace', path: [index], value: previous[index] });
  }
  for (let index = previous.length - 1; index >= next.length; index--) {
    forward.push({ op: 'remove', path: [index] });
  }
  for (let index = shared; index < next.length; index++) {
    forward.push({ op: 'add', path: [index], value: next[index] });
  }
  for (let index = next.length - 1; index >= previous.length; index--) {
    backward.push({ op: 'remove', path: [index] });
  }
  for (let index = shared; index < previous.length; index++) {
    backward.push({ op: 'add', path: [index], value: previous[index] });
  }
  return { patches: forward, inversePatches: backward };
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isStateMeta(value: unknown): value is StateMeta {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<StateMeta>;
  return (
    Array.isArray(candidate.history) &&
    Array.isArray(candidate.checkpoints) &&
    Number.isSafeInteger(candidate.nextPatchId) &&
    (candidate.nextPatchId ?? 0) > 0
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IEventDispatcher,
  EventDispatcherService,
  ScopeActivation.OnScopeCreated,
  'state',
);
