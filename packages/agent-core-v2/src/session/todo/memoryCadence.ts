import type { ContinuityClock } from './continuityState';
import type { MemoryWriteReceipt } from '#/tool/toolContract';

export type MemoryMaintenanceReason = 'M1' | 'M2' | 'M3';
export interface MemoryMaintenanceOffer {
  readonly reason: MemoryMaintenanceReason;
  readonly source: string;
  readonly humanTurnOrdinal: number;
  readonly workStepOrdinal: number;
  readonly workTokens: number;
  readonly inputRevision: number;
  readonly epoch: number;
}
export interface MemoryWriteAttempt {
  readonly source: string;
  readonly target: string;
  readonly handedOff?: boolean;
}
export interface MemoryWriteFailure extends MemoryWriteAttempt {
  readonly callId: string;
  readonly code: string;
}
export interface MemoryMaintenanceState {
  readonly offer?: MemoryMaintenanceOffer;
  readonly periodicEpoch?: number;
  readonly inputIds: readonly string[];
  readonly renewalEpoch?: number;
  readonly receipts: readonly (MemoryWriteReceipt & { readonly source: string })[];
  readonly calls: Readonly<Record<string, MemoryWriteAttempt | string>>;
  readonly failures?: readonly MemoryWriteFailure[];
}
export function initialMemoryMaintenance(): MemoryMaintenanceState {
  return { inputIds: [], receipts: [], calls: {}, failures: [] };
}
export function memoryWriteAttempt(callId: string, source: string, args: unknown): MemoryWriteAttempt {
  const input = args !== null && typeof args === 'object' ? args as Record<string, unknown> : {};
  const scope = typeof input['scope'] === 'string' ? input['scope'] : 'visible';
  const subject = typeof input['id'] === 'string' ? `id:${input['id']}` : typeof input['title'] === 'string' ? `title:${input['title'].trim()}` : `call:${callId}`;
  return { source, target: `${scope}/${subject}` };
}
export function normalizeMemoryAttempt(callId: string, attempt: MemoryWriteAttempt | string): MemoryWriteAttempt {
  return typeof attempt === 'string' ? { source: attempt, target: `visible/call:${callId}` } : attempt;
}
export function memoryWriteResolves(failure: MemoryWriteFailure, attempt: MemoryWriteAttempt, receipt: MemoryWriteReceipt): boolean {
  if (failure.target === attempt.target) return true;
  const targets = [receipt.target, receipt.proposedTarget].filter((target) => target !== undefined);
  if (targets.some((target) => failure.target === `${target.scope}/id:${target.id}`)) return true;
  return failure.code === 'revision_conflict' && targets.some((target) => failure.target === `visible/id:${target.id}`);
}
export function unresolvedMemoryWrites(state: MemoryMaintenanceState): readonly MemoryWriteFailure[] {
  return [...(state.failures ?? []), ...Object.entries(state.calls).map(([callId, value]) => ({ ...normalizeMemoryAttempt(callId, value), callId, code: 'result_unknown' }))]
    .filter((failure) => !failure.handedOff);
}
export function memoryMaintenanceCandidate(input: { clock: ContinuityClock; epoch: number; available: boolean; periodic: boolean; active: boolean; nearWindow: boolean; directive: boolean }): MemoryMaintenanceOffer | undefined {
  if (!input.available) return undefined;
  const clock = input.clock;
  const state = clock.memoryMaintenance ?? initialMemoryMaintenance();
  const id = clock.latestInput?.id;
  const unresolved = unresolvedMemoryWrites(state);
  const workSteps = clock.materialWorkStepOrdinal ?? clock.workStepOrdinal;
  const workTokens = clock.materialWorkTokens ?? clock.workTokens ?? 0;
  const reason: MemoryMaintenanceReason | undefined = input.directive && id !== undefined && !state.inputIds.includes(id)
    ? 'M1'
    : input.nearWindow && state.renewalEpoch !== input.epoch && unresolved.length > 0
      ? 'M2'
      : input.active && input.periodic && state.periodicEpoch !== input.epoch &&
        ((clock.humanTurnOrdinal - (state.offer?.humanTurnOrdinal ?? 0) >= 12 && workSteps - (state.offer?.workStepOrdinal ?? 0) >= 24) ||
          (workSteps - (state.offer?.workStepOrdinal ?? 0) >= 64 && workTokens - (state.offer?.workTokens ?? 0) >= 32_000))
        ? 'M3' : undefined;
  if (reason === undefined) return undefined;
  return { reason, source: reason === 'M1' ? `input:${id}` : reason === 'M2' ? `writes:${unresolved.map((failure) => failure.callId).join(',')}`
    : `material:${clock.humanInputRevision}:${workSteps}`, humanTurnOrdinal: clock.humanTurnOrdinal,
    workStepOrdinal: workSteps, workTokens, inputRevision: clock.humanInputRevision, epoch: input.epoch };
}

export function memoryMaintenanceReceipts(state?: MemoryMaintenanceState): string {
  const pending = state?.receipts.filter((receipt) => receipt.status === 'pending') ?? [];
  return pending.length ? ` Earlier receipts identified pending proposals: ${pending.map((receipt) => `${receipt.id}@${receipt.revision}${receipt.operationId ? ` (${receipt.operationId})` : ''}`).join(', ')}. A pending receipt does not establish active guidance. If their state matters now, read those IDs with include_pending=true before making another proposal; do not resubmit merely because a review has not finished.` : '';
}

export function memoryMaintenanceText(offer: MemoryMaintenanceOffer, state?: MemoryMaintenanceState): string {
  const body = offer.reason === 'M1'
    ? 'This human input may change guidance beyond the current task. First distinguish a lasting rule from a one-off request, a temporary arrangement, or an agent-derived interpretation. Apply the current request now. If lasting guidance needs a change, maintain its existing entry and preserve its scope and conditions. If current memory or an authoritative record already covers it and no saved entry needs correction, do not write. Keep task-only changes in task records.'
    : offer.reason === 'M2'
      ? 'A memory write attempted in this window still has an unresolved result or error. Before context renewal, preserve the unsaved change, target, and recovery pointer in the existing task handoff; check current state if a small lookup can resolve the uncertainty. Do not create a replacement entry or repeat a proposal merely to obtain a receipt. A deliberate no-write decision is not unfinished maintenance. Do not delay necessary compaction or wait for approval to finish.'
      : 'Consider only the new material already encountered in this work: did it establish lasting guidance or useful evidenced knowledge that is not yet captured in the right place? If so, reconcile the relevant existing entry or authoritative pointer. Otherwise continue without a memory call. Do not turn this reminder into an inventory sweep, save task progress, or rewrite unchanged guidance.';
  const failures = offer.reason === 'M2' && state !== undefined ? ` Unresolved attempts: ${unresolvedMemoryWrites(state).map((failure) => `${failure.callId} → ${failure.target} (${failure.code})`).join('; ')}.` : '';
  return `${body} Use the narrowest scope faithful to the user's intent, distinguish evidence from interpretation, and preserve any validity checks. Follow the current approval policy; pending is not active and unchanged is not a new write. Keep secrets out of memory and do not submit duplicate pending proposals.${failures}${memoryMaintenanceReceipts(state)}`;
}
