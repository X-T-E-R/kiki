import { event2FromRecord, type Event2, type Event2Class } from '#/app/event/event2';
import { PermissionSetMode, permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { PlanModeCancel, PlanModeEnter, PlanModeExit, planKey, type PlanState } from '#/features/plan/planOps';
import type { FoldContext, ReplayableStateKey } from '#/state/state';
import type { WireRecord } from '#/wire/record';
import { createContextTranscriptReducer, type ContextTranscript } from './contextTranscript';

export interface WireContextProjection {
  readonly transcript: ContextTranscript;
  readonly permissionMode: PermissionMode;
  readonly planActive: boolean;
}

const SILENT_FOLD: FoldContext = {
  silent: true, checkpoint() {}, clearCheckpoints() {}, undoToCheckpoint() {}, emit() {},
};
const PLAN_EVENTS: ReadonlyMap<string, Event2Class> = new Map<string, Event2Class>([
  [PlanModeEnter.type, PlanModeEnter], [PlanModeCancel.type, PlanModeCancel], [PlanModeExit.type, PlanModeExit],
]);

export function createWireContextProjection(): { add(record: WireRecord): void; result(): WireContextProjection } {
  const reducer = createContextTranscriptReducer();
  let permissionMode = permissionModeKey.initial();
  let plan: PlanState = { ...planKey.initial() };
  return {
    add(record) {
      reducer.add(record);
      if (record.type === PermissionSetMode.type) {
        const event = event2FromRecord(PermissionSetMode, eventRecord(record));
        if (event !== undefined) {
          const next = applyFold(permissionModeKey, permissionMode, PermissionSetMode, event);
          if (typeof next === 'string') permissionMode = next;
        }
      }
      const cls = PLAN_EVENTS.get(record.type);
      if (cls === undefined) return;
      const event = event2FromRecord(cls, eventRecord(record));
      if (event === undefined) return;
      const draft: PlanState = { ...plan, revisionCount: plan.revisionCount === undefined ? undefined : { ...plan.revisionCount } };
      plan = applyFold(planKey, draft, cls, event) ?? draft;
    },
    result: () => ({ transcript: reducer.result(), permissionMode, planActive: plan.active === true }),
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
