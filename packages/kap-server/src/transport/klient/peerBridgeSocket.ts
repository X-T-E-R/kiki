import { randomUUID } from 'node:crypto';
import type { KlientFrame } from '@kiki/klient/host';
import { SESSION_READ_BODY_BYTES } from '@kiki/klient/transports/http/bounded-body';
import {
  PEER_BRIDGE_CAPABILITY_CHUNKED_V1,
  peerBridgeAttachPayloadSchema,
  peerBridgeResponseChunkPayloadSchema,
  peerBridgeResponsePayloadSchema,
} from '@kiki/protocol';
import { AdmissionError } from '../../services/connections/admission';

export type PeerBridgeOperation = 'list' | 'read' | 'send' | 'wait' | 'create' | 'tools_list' | 'tools_call';

export interface PeerBridgeReply {
  readonly status: number;
  readonly envelope: { readonly code: number; readonly msg: string; readonly data?: unknown };
}

export interface PeerBridgeLimitsOptions {
  /** Override `KIKI_PEER_BRIDGE_MAX_RESPONSE_MB` for `tools_call` responses. Defaults to `16` MiB. */
  readonly maxToolsCallResponseBytes?: number;
  /** Environment bag used when explicit overrides are omitted. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export const DEFAULT_PEER_BRIDGE_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_PEER_BRIDGE_MAX_RESPONSE_MB = 16;
export const PEER_BRIDGE_LIST_MAX_RESPONSE_BYTES = 1024 * 1024;

const MAX_CHUNKS_PER_RESPONSE = 65_536;

interface PendingChunkBuffer {
  readonly total: number;
  status: number | undefined;
  readonly chunks: Array<string | undefined>;
  receivedCount: number;
  accumulatedBytes: number;
}

interface PendingForward {
  readonly operation: PeerBridgeOperation;
  readonly settle: (outcome: { readonly reply?: PeerBridgeReply; readonly error?: unknown }) => void;
  chunkBuffer?: PendingChunkBuffer;
}

const DEFAULT_PEER_BRIDGE_OPERATIONS: readonly PeerBridgeOperation[] = ['list', 'read', 'send', 'wait', 'create', 'tools_list', 'tools_call'];

/** Resolve the PeerBridge chunk payload limit in bytes from option or `KIKI_PEER_BRIDGE_CHUNK_BYTES`. */
export function resolvePeerBridgeChunkBytes(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (override !== undefined && Number.isFinite(override) && override >= 1024) {
    return Math.floor(override);
  }
  const raw = env['KIKI_PEER_BRIDGE_CHUNK_BYTES'];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1024) return parsed;
  }
  return DEFAULT_PEER_BRIDGE_CHUNK_BYTES;
}

/** Resolve the maximum `tools_call` response byte limit from option or `KIKI_PEER_BRIDGE_MAX_RESPONSE_MB`. */
export function resolvePeerBridgeMaxToolsCallBytes(
  opts: PeerBridgeLimitsOptions = {},
): number {
  if (
    opts.maxToolsCallResponseBytes !== undefined &&
    Number.isFinite(opts.maxToolsCallResponseBytes) &&
    opts.maxToolsCallResponseBytes > 0
  ) {
    return Math.floor(opts.maxToolsCallResponseBytes);
  }
  const env = opts.env ?? process.env;
  const raw = env['KIKI_PEER_BRIDGE_MAX_RESPONSE_MB'];
  if (raw !== undefined && raw.trim() !== '') {
    const mb = Number.parseFloat(raw.trim());
    if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  }
  return DEFAULT_PEER_BRIDGE_MAX_RESPONSE_MB * 1024 * 1024;
}

/** Split a UTF-8 string into slices each at most `maxChunkBytes` UTF-8 bytes without splitting surrogate pairs. */
export function sliceUtf8Chunks(text: string, maxChunkBytes: number): string[] {
  const limit = Math.max(1024, Math.floor(maxChunkBytes));
  if (Buffer.byteLength(text, 'utf8') <= limit) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let bytes = 0;
    let end = start;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      let charBytes: number;
      let step = 1;
      if (code < 0x80) {
        charBytes = 1;
      } else if (code < 0x800) {
        charBytes = 2;
      } else if (code >= 0xd800 && code <= 0xdbff && end + 1 < text.length) {
        const next = text.charCodeAt(end + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          charBytes = 4;
          step = 2;
        } else {
          charBytes = 3;
        }
      } else {
        charBytes = 3;
      }
      if (bytes + charBytes > limit && end > start) break;
      bytes += charBytes;
      end += step;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function maxResponseBytes(operation: PeerBridgeOperation, maxToolsCallBytes: number): number {
  if (operation === 'read') return SESSION_READ_BODY_BYTES;
  if (operation === 'tools_call') return maxToolsCallBytes;
  if (operation === 'tools_list') return 512 * 1024;
  if (operation === 'list') return PEER_BRIDGE_LIST_MAX_RESPONSE_BYTES;
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
  private peerCapabilities: ReadonlySet<string> = new Set();
  private readonly pending = new Map<string, PendingForward>();
  private readonly maxToolsCallBytes: number;
  private closed = false;

  constructor(
    readonly grantId: string | undefined,
    private readonly registry: PeerBridgeRegistry | undefined,
    private readonly send: (frame: KlientFrame) => boolean,
    limits: PeerBridgeLimitsOptions = {},
  ) {
    this.maxToolsCallBytes = resolvePeerBridgeMaxToolsCallBytes(limits);
  }

  isAttached(operation?: PeerBridgeOperation): boolean {
    if (this.closed || this.attachedOperations === undefined) return false;
    return operation === undefined || this.attachedOperations.has(operation);
  }

  /** Whether the attached peer negotiated the `chunked_v1` framing capability. */
  supportsChunkedResponses(): boolean {
    return this.peerCapabilities.has(PEER_BRIDGE_CAPABILITY_CHUNKED_V1);
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
    if (frame.type === 'bridge_response_chunk') {
      this.handleResponseChunk(frame);
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
        const entry = this.pending.get(id);
        if (entry !== undefined) entry.chunkBuffer = undefined;
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
    const requestedCaps = new Set(parsed.data.capabilities ?? []);
    const negotiatedCaps = requestedCaps.has(PEER_BRIDGE_CAPABILITY_CHUNKED_V1)
      ? [PEER_BRIDGE_CAPABILITY_CHUNKED_V1]
      : undefined;
    this.attachedOperations = new Set(operations);
    this.peerCapabilities = new Set(negotiatedCaps ?? []);
    this.registry.register(this);
    if (id !== '') {
      this.send({
        type: 'bridge_attached',
        id,
        data: negotiatedCaps === undefined ? { operations } : { operations, capabilities: negotiatedCaps },
      });
    }
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
    if (rawSize > maxResponseBytes(entry.operation, this.maxToolsCallBytes)) {
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

  private handleResponseChunk(frame: KlientFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (id === '') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    const parsed = peerBridgeResponseChunkPayloadSchema.safeParse(frame.data);
    if (!parsed.success) {
      entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
      return;
    }
    const { seq, total, status, chunk } = parsed.data;
    if (seq >= total || total > MAX_CHUNKS_PER_RESPONSE) {
      entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
      return;
    }
    const limit = maxResponseBytes(entry.operation, this.maxToolsCallBytes);
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    let buffer = entry.chunkBuffer;
    if (buffer === undefined) {
      buffer = {
        total,
        status,
        chunks: Array.from<string | undefined>({ length: total }),
        receivedCount: 0,
        accumulatedBytes: 0,
      };
      entry.chunkBuffer = buffer;
    } else {
      if (buffer.total !== total || buffer.chunks[seq] !== undefined) {
        entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
        return;
      }
      if (status !== undefined) {
        if (buffer.status !== undefined && buffer.status !== status) {
          entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
          return;
        }
        buffer.status = status;
      }
    }
    buffer.accumulatedBytes += chunkBytes;
    if (buffer.accumulatedBytes > limit) {
      entry.settle({ error: new AdmissionError(502, 'bridge_response_too_large') });
      return;
    }
    buffer.chunks[seq] = chunk;
    buffer.receivedCount += 1;
    if (buffer.receivedCount < buffer.total) return;

    if (buffer.status === undefined) {
      entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
      return;
    }
    let decodedEnvelope: unknown;
    try {
      decodedEnvelope = JSON.parse(buffer.chunks.join(''));
    } catch {
      entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
      return;
    }
    const validated = peerBridgeResponsePayloadSchema.safeParse({
      status: buffer.status,
      envelope: decodedEnvelope,
    });
    if (!validated.success) {
      entry.settle({ error: new AdmissionError(502, 'invalid_bridge_response') });
      return;
    }
    entry.settle({ reply: validated.data });
  }

  private detachInternal(): void {
    this.attachedOperations = undefined;
    this.peerCapabilities = new Set();
    this.registry?.unregister(this);
    const active = [...this.pending.values()];
    this.pending.clear();
    for (const item of active) {
      item.chunkBuffer = undefined;
      item.settle({ error: new AdmissionError(503, 'target_temporarily_unavailable') });
    }
  }
}
