import { readBoundedJsonBody } from '../transports/http/bounded-body.js';
import {
  delegationProcedure,
  type DelegationProcedureInput,
  type DelegationProcedureName,
  type DelegationProcedureOutput,
} from './externalDelegation.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_MARGIN_MS = 10_000;

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data?: T;
  readonly details?: unknown;
}

export interface SeatCallOptions {
  readonly signal?: AbortSignal;
  /** Absolute call budget including response consumption; zero disables the deadline. */
  readonly timeoutMs?: number;
}

/** Safe context on a transport timeout. An unknown outcome must be reconciled using the original identity, not blindly retried. */
export interface SeatTimeoutDetails {
  readonly reason: 'transport.timeout';
  readonly procedure: DelegationProcedureName;
  readonly phase: 'headers' | 'body';
  readonly timeoutMs: number;
  readonly outcome: 'not_sent' | 'unknown';
  readonly dispatchId?: string;
  readonly dispatchKey?: string;
  readonly idempotencyKey?: string;
}

export interface SeatKlient {
  call<Name extends DelegationProcedureName>(
    name: Name,
    input: DelegationProcedureInput<Name>,
    options?: SeatCallOptions,
  ): Promise<DelegationProcedureOutput<Name>>;
  profiles(input?: DelegationProcedureInput<'profiles'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'profiles'>>;
  list(input?: DelegationProcedureInput<'list'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'list'>>;
  dispatch(input: DelegationProcedureInput<'dispatch'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'dispatch'>>;
  continue(input: DelegationProcedureInput<'continue'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'continue'>>;
  send(input: DelegationProcedureInput<'send'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'send'>>;
  interactions(input?: DelegationProcedureInput<'interactions'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'interactions'>>;
  respond(input: DelegationProcedureInput<'respond'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'respond'>>;
  status(input: DelegationProcedureInput<'status'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'status'>>;
  /** Defaults to the requested server wait (30s when omitted) plus a 10s transport margin, independently of the ordinary call default. */
  wait(input?: DelegationProcedureInput<'wait'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'wait'>>;
  result(input: DelegationProcedureInput<'result'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'result'>>;
  events(input: DelegationProcedureInput<'events'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'events'>>;
  transcript(input: DelegationProcedureInput<'transcript'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'transcript'>>;
  cancel(input: DelegationProcedureInput<'cancel'>, options?: SeatCallOptions): Promise<DelegationProcedureOutput<'cancel'>>;
  close(): Promise<void>;
}

export interface CreateSeatKlientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** Default ordinary call budget from entry through body decoding. Defaults to 30s; zero disables. */
  readonly timeoutMs?: number;
}

export class SeatKlientError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SeatKlientError';
  }
}

export function createSeatKlient(options: CreateSeatKlientOptions): SeatKlient {
  const endpoint = options.endpoint.replace(/\/$/u, '');
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const active = new Set<AbortController>();
  const closedResult = Promise.resolve();
  let closed = false;

  const call = async <Name extends DelegationProcedureName>(
    name: Name,
    input: DelegationProcedureInput<Name>,
    callOptions?: SeatCallOptions,
  ): Promise<DelegationProcedureOutput<Name>> => {
    const startedAt = Date.now();
    if (closed) throw new Error('seat klient closed');
    callOptions?.signal?.throwIfAborted();
    const procedure = delegationProcedure(name);
    const canonicalInput = procedure.inputSchema.parse(input) as DelegationProcedureInput<Name>;
    const body = JSON.stringify(canonicalInput);
    const timeoutMs = callOptions?.timeoutMs ?? (name === 'wait'
      ? ((canonicalInput as DelegationProcedureInput<'wait'>).timeoutMs ?? DEFAULT_TIMEOUT_MS) + WAIT_MARGIN_MS
      : options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    active.add(controller);
    let phase: SeatTimeoutDetails['phase'] = 'headers';
    let sent = false;
    const timeout = (): void => {
      const identity = canonicalInput as { dispatchId?: string; dispatchKey?: string; idempotencyKey?: string };
      const details: SeatTimeoutDetails = { reason: 'transport.timeout', procedure: name, phase, timeoutMs,
        outcome: sent ? 'unknown' : 'not_sent', dispatchId: identity.dispatchId,
        dispatchKey: identity.dispatchKey, idempotencyKey: identity.idempotencyKey };
      controller.abort(new SeatKlientError(50001, `seat call timed out after ${timeoutMs}ms`, details));
    };
    const sourceSignal = callOptions?.signal;
    const abort = (): void => controller.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener('abort', abort, { once: true });
    let rejectAborted!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = (): void => rejectAborted(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const remaining = timeoutMs - (Date.now() - startedAt);
    const timer = timeoutMs > 0 ? setTimeout(timeout, Math.max(0, remaining)) : undefined;
    const perform = async (): Promise<DelegationProcedureOutput<Name>> => {
      if (timeoutMs > 0 && remaining <= 0) timeout();
      controller.signal.throwIfAborted();
      sent = true;
      const response = await fetchImpl(
        `${endpoint}/api/klient/delegation/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) {
        void response.body?.cancel(controller.signal.reason).catch(() => {});
        controller.signal.throwIfAborted();
      }
      phase = 'body';
      const envelope = await readBoundedJsonBody(response, Infinity, controller.signal) as Envelope<unknown>;
      controller.signal.throwIfAborted();
      if (!response.ok || envelope.code !== 0) {
        throw new SeatKlientError(envelope.code, envelope.msg, envelope.details);
      }
      const output = procedure.outputSchema.parse(envelope.data) as DelegationProcedureOutput<Name>;
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) timeout();
      controller.signal.throwIfAborted();
      return output;
    };
    try {
      return await Promise.race([perform(), aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sourceSignal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      active.delete(controller);
    }
  };
  const close = (): Promise<void> => {
    if (closed) return closedResult;
    closed = true;
    for (const controller of active) controller.abort();
    active.clear();
    return closedResult;
  };

  return {
    call,
    profiles: (input = {}, callOptions) => call('profiles', input, callOptions),
    list: (input = {}, callOptions) => call('list', input, callOptions),
    dispatch: (input, callOptions) => call('dispatch', input, callOptions),
    continue: (input, callOptions) => call('continue', input, callOptions),
    send: (input, callOptions) => call('send', input, callOptions),
    interactions: (input = {}, callOptions) => call('interactions', input, callOptions),
    respond: (input, callOptions) => call('respond', input, callOptions),
    status: (input, callOptions) => call('status', input, callOptions),
    wait: (input = {}, callOptions) => call('wait', input, callOptions),
    result: (input, callOptions) => call('result', input, callOptions),
    events: (input, callOptions) => call('events', input, callOptions),
    transcript: (input, callOptions) => call('transcript', input, callOptions),
    cancel: (input, callOptions) => call('cancel', input, callOptions),
    close,
  };
}
