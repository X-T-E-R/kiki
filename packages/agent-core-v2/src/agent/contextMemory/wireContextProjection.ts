import { produce } from 'immer';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { event2FromRecord, type Event2, type Event2Class } from '#/app/event/event2';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';
import { RuntimeSetBinding } from '#/agent/runtimeBinding/runtimeBindingOps';
import type { RuntimeBinding } from '#/runtime/runtime';
import { tokenCountingKey, TokenCountingMeasured, TokenCountingRebased, TokenCountingTruncated } from '#/agent/tokenCounting/tokenCountingOps';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { PermissionSetMode, permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { planKey, type PlanState } from '#/features/plan/planOps';
import { expandedStateFolds, type FoldContext, type ReplayableStateKey } from '#/state/state';
import type { WireRecord } from '#/wire/record';
import { createContextTranscriptReducer, type ContextTranscript } from './contextTranscript';

export interface WireContextProjection {
  readonly transcript: ContextTranscript;
  readonly permissionMode: PermissionMode;
  readonly planActive: boolean;
  readonly permissionConfigured: boolean;
  readonly runtimeBinding?: RuntimeBinding;
  readonly contextTokens: Readonly<Record<'measured' | 'estimated' | 'measured+estimated', number>>;
}

const SILENT_FOLD: FoldContext = {
  silent: true, checkpoint() {}, clearCheckpoints() {}, undoToCheckpoint() {}, emit() {},
};
const PLAN_FOLDS = new Map([...expandedStateFolds(planKey)].map(([event, fold]) => [event.type, { event, fold }]));

const TOKEN_EVENTS: ReadonlyMap<string, Event2Class> = new Map<string, Event2Class>([
  [TokenCountingMeasured.type, TokenCountingMeasured], [TokenCountingRebased.type, TokenCountingRebased],
  [TokenCountingTruncated.type, TokenCountingTruncated], [AgentModelSwitch.type, AgentModelSwitch],
]);

export function createWireContextProjection(): { add(record: WireRecord): void; result(): WireContextProjection } {
  const reducer = createContextTranscriptReducer();
  let permissionMode = permissionModeKey.initial();
  let permissionConfigured = false;
  let runtimeBinding: RuntimeBinding | undefined;
  let tokenCounting = { ...tokenCountingKey.initial() };
  let plan: PlanState = planKey.initial();
  let planCheckpoints: PlanState[] = [];
  return {
    add(record) {
      reducer.add(record);
      if (record.type === RuntimeSetBinding.type) {
        const event = event2FromRecord(RuntimeSetBinding, eventRecord(record));
        if (event instanceof RuntimeSetBinding) runtimeBinding = { workspaceId: event.workspaceId, runtimeId: event.runtimeId };
      }
      const tokenClass = TOKEN_EVENTS.get(record.type);
      if (tokenClass !== undefined) {
        const event = event2FromRecord(tokenClass, eventRecord(record));
        if (event !== undefined) tokenCounting = applyFold(tokenCountingKey, tokenCounting, tokenClass, event) ?? tokenCounting;
      }
      if (record.type === PermissionSetMode.type) {
        const event = event2FromRecord(PermissionSetMode, eventRecord(record));
        if (event !== undefined) {
          permissionConfigured = true;
          const next = applyFold(permissionModeKey, permissionMode, PermissionSetMode, event);
          if (typeof next === 'string') permissionMode = next;
        }
      }
      const entry = PLAN_FOLDS.get(record.type);
      if (entry === undefined) return;
      const event = event2FromRecord(entry.event, eventRecord(record));
      if (event === undefined) return;
      let checkpoint = false;
      let clear = false;
      let undo: number | undefined;
      const next = produce(plan, draft => entry.fold(draft, event, {
        silent: true, emit() {},
        checkpoint: () => { checkpoint = true; },
        clearCheckpoints: () => { clear = true; },
        undoToCheckpoint: count => { undo = count; },
      }));
      if (undo !== undefined) {
        const index = planCheckpoints.length - undo;
        if (index < 0) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Plan undo exceeds available history');
        plan = planCheckpoints[index]!;
        planCheckpoints = planCheckpoints.slice(0, index);
      } else {
        plan = next;
        if (clear) planCheckpoints = [];
      }
      if (checkpoint) planCheckpoints.push(plan);
    },
    result: () => {
      const transcript = reducer.result();
      const context = transcript.logicalEntries;
      const measured = tokenCounting.anchors.findLast(anchor => anchor.measured)?.tokens ?? 0;
      const anchor = tokenCounting.anchors.findLast(anchor => anchor.length <= context.length);
      return {
        transcript, permissionMode, permissionConfigured, planActive: plan.active === true, runtimeBinding,
        contextTokens: {
          measured,
          estimated: estimateTokensForMessages(context),
          'measured+estimated': Math.max(measured, (anchor?.tokens ?? 0) + estimateTokensForMessages(context.slice(anchor?.length ?? 0))),
        },
      };
    },
  };
}

function applyFold<S>(key: ReplayableStateKey<S>, state: S, cls: Event2Class, event: Event2): S | undefined {
  const fold = key.replayable.folds.get(cls);
  if (fold === undefined) return undefined;
  const next = fold(state as never, event, SILENT_FOLD);
  return next === undefined ? undefined : next as S;
}

function eventRecord(record: WireRecord): { readonly type: string; readonly time?: number } & Record<string, unknown> {
  return record as { readonly type: string; readonly time?: number } & Record<string, unknown>;
}
