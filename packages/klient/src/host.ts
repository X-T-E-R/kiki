import { RPCError } from './core/errors.js';
import type { KlientProcedure } from './transports/codec.js';

export { RPCError };
export { IAgentPanelService } from './transports/agentPanelService.js';
export type { EventSourceRef, IDisposable, ScopeRef } from './core/channel.js';
export {
  createContractDispatcher as createKlientDispatcher,
  type ContractDispatcher as KlientDispatcher,
} from './transports/contractDispatcher.js';
export type { ScopeLike } from './transports/memory/dispatcher.js';
export {
  decodeJsonFrame,
  encodeJsonFrame,
  eventSourceFromTarget,
  isTransportScope,
  parseKlientCallRequest,
  scopeRefFromProcedure,
  scopeRefFromTarget,
  type KlientCallRequest,
  type KlientFrame,
  type KlientProcedure,
  type KlientTarget,
  type TransportScope,
} from './transports/codec.js';

export interface KlientBatchCallItem {
  readonly id: string;
  readonly procedure: KlientProcedure;
  readonly params: unknown[];
}

export interface KlientBatchRequest {
  readonly calls: readonly KlientBatchCallItem[];
}

export interface KlientBatchLine {
  readonly id: string;
  readonly envelope: {
    readonly code: number;
    readonly msg: string;
    readonly data?: unknown;
    readonly request_id?: string;
    readonly details?: unknown;
    readonly reason?: string;
  };
}

export interface RawKlientBatchItem {
  readonly id: string;
  readonly raw: unknown;
}

export function parseKlientBatchEnvelope(
  value: unknown,
  maxBatchSize: number,
): readonly RawKlientBatchItem[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RPCError(40001, 'invalid klient batch body');
  }
  const calls = (value as Record<string, unknown>)['calls'];
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new RPCError(40001, 'klient batch calls must be a non-empty array');
  }
  if (calls.length > maxBatchSize) {
    throw new RPCError(40001, `klient batch exceeds maximum of ${maxBatchSize} calls`);
  }
  const seen = new Set<string>();
  const items: RawKlientBatchItem[] = [];
  for (const raw of calls) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RPCError(40001, 'invalid klient batch call item');
    }
    const id = (raw as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new RPCError(40001, 'klient batch call item requires a non-empty string id');
    }
    if (seen.has(id)) {
      throw new RPCError(40001, `duplicate klient batch call id: ${id}`);
    }
    seen.add(id);
    items.push({ id, raw });
  }
  return items;
}
