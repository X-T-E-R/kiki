import { randomUUID } from 'node:crypto';
import type { KlientFrame } from '@kiki/klient/host';
import { SESSION_READ_BODY_BYTES } from '@kiki/klient/transports/http/bounded-body';
import { peerBridgeAttachPayloadSchema, peerBridgeResponsePayloadSchema } from '@kiki/protocol';
import { AdmissionError } from '../../services/connections/admission';

export type PeerBridgeOperation = 'list' | 'read' | 'send' | 'wait' | 'create';

export interface PeerBridgeReply {
  readonly status: number;
  readonly envelope: { readonly code: number; readonly msg: string; readonly data?: unknown };
}

interface PendingForward {
  readonly operation: PeerBridgeOperation;
  readonly settle: (outcome: { readonly reply?: PeerBridgeReply; readonly error?: unknown }) => void;
}

const DEFAULT_PEER_BRIDGE_OPERATIONS: readonly PeerBridgeOperation[] = ['list', 'read', 'send', 'wait', 'create'];

function maxResponseBytes(operation: PeerBridgeOperation): number {
  if (operation === 'read') return SESSION_READ_BODY_BYTES;
  if (operation === 'list') return 128 * 1024;
  return 16 * 1024;
}

export class PeerBridgeRegistry {
  private readonly sessions = new Map<string, Set<PeerBridgeConnection>>();
  private readonly attachListeners = new Set<(grantId: string) => void>();

  onDidAttach(listener: (grantId: string) => void): { dispose(): void } {
    this.attachListeners.add(listener);
    return { dispose: () => { this.attachListeners.delete(listener); } };
  }

  register(connection: PeerBridgeConnection): void {
    const grantId = connection.grantId;
    if (grantId === undefined) return;
    const set = this.sessions.get(grantId) ?? new Set<PeerBridgeConnection>();
    set.add(connection);
    this.sessions.set(grantId, set);
    for (const listener of this.attachListeners) listener(grantId);
  }

  unregister(connection: PeerBridgeConnection): void {
    const grantId = connection.grantId;
    if (grantId === undefined) return;
    const set = this.sessions.get(grantId);
    if (set === undefined) return;
    set.delete(connection);
    if (set.size === 0) this.sessions.delete(grantId);
  }

  isAttached(grantId: string, operation?: PeerBridgeOperation): boolean {
    return this.select(grantId, operation) !== undefined;
  }

  forward(grantId: string, operation: PeerBridgeOperation, credential: string, body: unknown, signal: AbortSignal): Promise<PeerBridgeReply> {
    const active = this.select(grantId, operation);
    if (active === undefined) return Promise.reject(new AdmissionError(503, 'peer_bridge_offline'));
    return active.forward(operation, credential, body, signal);
  }

  private select(grantId: string, operation?: PeerBridgeOperation): PeerBridgeConnection | undefined {
    const set = this.sessions.get(grantId);
    if (set === undefined) return undefined;
    let candidate: PeerBridgeConnection | undefined;
    for (const entry of set) {
      if (entry.isAttached(operation)) candidate = entry;
    }
    return candidate;
  }
}

export class PeerBridgeConnection {
  private attachedOperations: ReadonlySet<PeerBridgeOperation> | undefined;
  private readonly pending = new Map<string, PendingForward>();
  private closed = false;

  constructor(
    readonly grantId: string | undefined,
    private readonly registry: PeerBridgeRegistry | undefined,
    private readonly send: (frame: KlientFrame) => boolean,
  ) {}

  isAttached(operation?: PeerBridgeOperation): boolean {
    if (this.closed || this.attachedOperations === undefined) return false;
    return operation === undefined || this.attachedOperations.has(operation);
  }

  receive(frame: KlientFrame): boolean {
    if (frame.type === 'bridge_attach') {
      this.handleAttach(frame);
      return true;
    }
    if (frame.type === 'bridge_detach') {
      this.handleDetach(frame);
      return true;
    }
    if (frame.type === 'bridge_response') {
      this.handleResponse(frame);
      return true;
    }
    return false;
  }

  forward(operation: PeerBridgeOperation, credential: string, body: unknown, signal: AbortSignal): Promise<PeerBridgeReply> {
    if (!this.isAttached(operation)) return Promise.reject(new AdmissionError(503, 'peer_bridge_offline'));
    if (signal.aborted) return Promise.reject(signal.reason ?? new AdmissionError(499, 'request_aborted'));
    const id = randomUUID();
    return new Promise<PeerBridgeReply>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const settle = (outcome: { readonly reply?: PeerBridgeReply; readonly error?: unknown }): void => {
        cleanup();
        if (outcome.reply !== undefined) resolve(outcome.reply);
        else reject(outcome.error ?? new AdmissionError(503, 'target_temporarily_unavailable'));
      };
      const onAbort = (): void => {
        if (!this.pending.has(id)) return;
        this.send({ type: 'bridge_cancel', id });
        settle({ error: signal.reason ?? new AdmissionError(499, 'request_aborted') });
      };
      this.pending.set(id, { operation, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      const sent = this.send({
        type: 'bridge_request',
        id,
        data: { operation, authorization: `Bearer ${credential}`, body },
      });
      if (!sent) settle({ error: new AdmissionError(503, 'peer_bridge_offline') });
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachInternal();
  }

  private handleAttach(frame: KlientFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (this.grantId === undefined || this.registry === undefined) {
      if (id !== '') this.send({ type: 'bridge_error', id, code: 40301, msg: 'peer_grant_required' });
      return;
    }
    const parsed = peerBridgeAttachPayloadSchema.safeParse(frame.data ?? {});
    if (!parsed.success) {
      if (id !== '') this.send({ type: 'bridge_error', id, code: 40001, msg: 'invalid_bridge_attach' });
      return;
    }
    const operations = [...new Set(parsed.data.operations ?? DEFAULT_PEER_BRIDGE_OPERATIONS)];
    this.attachedOperations = new Set(operations);
    this.registry.register(this);
    if (id !== '') this.send({ type: 'bridge_attached', id, data: { operations } });
  }

  private handleDetach(frame: KlientFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    this.detachInternal();
    if (id !== '') this.send({ type: 'bridge_detached', id });
  }

  private handleResponse(frame: KlientFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (id === '') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    const rawSize = Buffer.byteLength(JSON.stringify(frame.data ?? null), 'utf8');
    if (rawSize > maxResponseBytes(entry.operation)) {
      entry.settle({ error: new AdmissionError(502, 'bridge_response_too_large') });
      return;
    }
    const parsed = peerBridgeResponsePayloadSchema.safeParse(frame.data);
    if (!parsed.success) {
      entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
      return;
    }
    entry.settle({ reply: parsed.data });
  }

  private detachInternal(): void {
    this.attachedOperations = undefined;
    this.registry?.unregister(this);
    const active = [...this.pending.values()];
    this.pending.clear();
    for (const item of active) {
      item.settle({ error: new AdmissionError(503, 'target_temporarily_unavailable') });
    }
  }
}
