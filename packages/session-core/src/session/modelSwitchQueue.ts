/**
 * Model-switch control items share the prompt queue's drain order with user
 * messages but are not messages: the engine parks them under reserved prompt
 * ids (`\u0000model-switch:<operationId>`). Session state keeps user prompts
 * only — these helpers are the single filter/interleave rule so a control id
 * never renders as an empty queue row, and a switch row lands at its real
 * shared-order slot beside the messages.
 */

/** Mirrors `MODEL_SWITCH_QUEUE_PREFIX` in agent-core-v2's promptService. */
export const MODEL_SWITCH_QUEUE_ID_PREFIX = '\u0000model-switch:';

export function isModelSwitchQueueId(promptId: string): boolean {
  return promptId.startsWith(MODEL_SWITCH_QUEUE_ID_PREFIX);
}

export function modelSwitchOperationIdFromQueueId(promptId: string): string {
  return promptId.slice(MODEL_SWITCH_QUEUE_ID_PREFIX.length);
}

export interface ModelSwitchQueueRowData {
  readonly operationId: string;
  readonly queueIndex: number;
}

export interface MessageQueueRowData {
  readonly promptId: string;
  readonly queuePosition?: number;
}

export type SessionQueueRow =
  | { readonly kind: 'message'; readonly promptId: string }
  | { readonly kind: 'modelSwitch'; readonly operationId: string };

/**
 * Interleave parked messages and model-switch control items into one drain
 * order. Messages keep their state order (the authoritative relative order);
 * a switch claims its engine-computed shared `queueIndex` ahead of the first
 * message that sits behind it.
 *
 * A message without a known position is a locally echoed one: it landed at
 * the tail of the shared order as it stood then, so its effective position is
 * "one past everything already emitted". That keeps a switch queued earlier in
 * front of it and a switch queued later behind it, without inventing engine
 * state — the next authoritative list/event read corrects any transient slot.
 */
export function mergeSessionQueueRows(
  messages: readonly MessageQueueRowData[],
  switches: readonly ModelSwitchQueueRowData[],
): readonly SessionQueueRow[] {
  const rows: SessionQueueRow[] = [];
  const pendingSwitches = switches.toSorted((left, right) => left.queueIndex - right.queueIndex);
  for (const message of messages) {
    const effectivePosition = message.queuePosition ?? rows.length + 1;
    while (pendingSwitches.length > 0 && pendingSwitches[0]!.queueIndex < effectivePosition) {
      rows.push({ kind: 'modelSwitch', operationId: pendingSwitches.shift()!.operationId });
    }
    rows.push({ kind: 'message', promptId: message.promptId });
  }
  for (const rest of pendingSwitches) {
    rows.push({ kind: 'modelSwitch', operationId: rest.operationId });
  }
  return rows;
}
