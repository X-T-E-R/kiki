import type { ContinuityClock } from './continuityState';

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
export interface MemoryMaintenanceState {
  readonly offer?: MemoryMaintenanceOffer;
  readonly periodicEpoch?: number;
  readonly inputIds: readonly string[];
  readonly renewalEpoch?: number;
  readonly receipts: readonly { readonly source: string; readonly id: string; readonly revision: string; readonly status: string; readonly operationId: string; readonly action: string }[];
  readonly calls: Readonly<Record<string, string>>;
}
export function initialMemoryMaintenance(): MemoryMaintenanceState {
  return { inputIds: [], receipts: [], calls: {} };
}
export function memoryMaintenanceCandidate(input: { clock: ContinuityClock; epoch: number; available: boolean; periodic: boolean; active: boolean; nearWindow: boolean; directive: boolean }): MemoryMaintenanceOffer | undefined {
  if (!input.available) return undefined;
  const clock = input.clock;
  const state = clock.memoryMaintenance ?? initialMemoryMaintenance();
  const id = clock.latestInput?.id;
  const reason: MemoryMaintenanceReason | undefined = input.directive && id !== undefined && !state.inputIds.includes(id)
    ? 'M1'
    : input.nearWindow && state.renewalEpoch !== input.epoch && state.offer?.reason === 'M1' &&
      !state.receipts.some((receipt) => receipt.source === state.offer!.source)
      ? 'M2'
      : input.active && input.periodic && state.periodicEpoch !== input.epoch &&
        ((clock.humanTurnOrdinal - (state.offer?.humanTurnOrdinal ?? 0) >= 12 && clock.workStepOrdinal - (state.offer?.workStepOrdinal ?? 0) >= 24) ||
          (clock.workStepOrdinal - (state.offer?.workStepOrdinal ?? 0) >= 64 && (clock.workTokens ?? 0) - (state.offer?.workTokens ?? 0) >= 32_000))
        ? 'M3' : undefined;
  if (reason === undefined) return undefined;
  return { reason, source: reason === 'M1' ? `input:${id}` : reason === 'M2' ? state.offer!.source
    : `material:${clock.humanInputRevision}:${clock.workStepOrdinal}`, humanTurnOrdinal: clock.humanTurnOrdinal,
    workStepOrdinal: clock.workStepOrdinal, workTokens: clock.workTokens ?? 0, inputRevision: clock.humanInputRevision, epoch: input.epoch };
}

export function memoryMaintenanceReceipts(state?: MemoryMaintenanceState): string {
  const pending = state?.receipts.filter((receipt) => receipt.status === 'pending') ?? [];
  return pending.length ? ` Earlier write receipts recorded pending proposals: ${pending.map((receipt) => `${receipt.id}@${receipt.revision} (${receipt.operationId})`).join(', ')}. Check their current review state before another proposal; pending is not active guidance.` : '';
}

export function memoryMaintenanceText(offer: MemoryMaintenanceOffer, state?: MemoryMaintenanceState): string {
  const body = offer.reason === 'M1'
    ? 'This human input may establish, change, or revoke guidance useful across tasks. If it should apply in future sessions, search and read relevant existing memory first; maintain the complete current rule with its conditions. Prefer update, and retire obsolete or fully covered entries only after the retained content is active.'
    : offer.reason === 'M2'
      ? 'Before this context window is renewed, check any still-unhandled cross-task guidance identified in this window. Task notes and durable memory have separate coverage. Do not delay necessary compaction or require an approval to finish first.'
      : 'This stretch of new work has not had a durable-memory check recently. If it produced guidance, stable decisions, or evidenced knowledge useful in future tasks, reconcile relevant existing entries and maintain only what changed. If nothing merits keeping, do not write. Task progress belongs in TodoList notes, not saved memory.';
  return `${body} Follow the current memory scope and approval policy; never store secrets. Do not submit duplicate pending proposals.${memoryMaintenanceReceipts(state)}`;
}
