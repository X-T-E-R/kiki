import {
  delegationProcedure,
  type DelegationProcedureInput,
  type DelegationProcedureName,
  type DelegationProcedureOutput,
} from './externalDelegation.js';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data?: T;
  readonly details?: unknown;
}

export interface SeatKlient {
  call<Name extends DelegationProcedureName>(
    name: Name,
    input: DelegationProcedureInput<Name>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DelegationProcedureOutput<Name>>;
  profiles(input?: DelegationProcedureInput<'profiles'>): Promise<DelegationProcedureOutput<'profiles'>>;
  list(input?: DelegationProcedureInput<'list'>): Promise<DelegationProcedureOutput<'list'>>;
  dispatch(input: DelegationProcedureInput<'dispatch'>): Promise<DelegationProcedureOutput<'dispatch'>>;
  continue(input: DelegationProcedureInput<'continue'>): Promise<DelegationProcedureOutput<'continue'>>;
  send(input: DelegationProcedureInput<'send'>): Promise<DelegationProcedureOutput<'send'>>;
  interactions(input?: DelegationProcedureInput<'interactions'>): Promise<DelegationProcedureOutput<'interactions'>>;
  respond(input: DelegationProcedureInput<'respond'>): Promise<DelegationProcedureOutput<'respond'>>;
  status(input: DelegationProcedureInput<'status'>): Promise<DelegationProcedureOutput<'status'>>;
  wait(input?: DelegationProcedureInput<'wait'>, options?: { readonly signal?: AbortSignal }): Promise<DelegationProcedureOutput<'wait'>>;
  result(input: DelegationProcedureInput<'result'>): Promise<DelegationProcedureOutput<'result'>>;
  events(input: DelegationProcedureInput<'events'>): Promise<DelegationProcedureOutput<'events'>>;
  transcript(input: DelegationProcedureInput<'transcript'>): Promise<DelegationProcedureOutput<'transcript'>>;
  cancel(input: DelegationProcedureInput<'cancel'>): Promise<DelegationProcedureOutput<'cancel'>>;
  close(): Promise<void>;
}

export interface CreateSeatKlientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
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
    callOptions?: { readonly signal?: AbortSignal },
  ): Promise<DelegationProcedureOutput<Name>> => {
    if (closed) throw new Error('seat klient closed');
    const procedure = delegationProcedure(name);
    const canonicalInput = procedure.inputSchema.parse(input) as DelegationProcedureInput<Name>;
    const controller = new AbortController();
    active.add(controller);
    try {
      const response = await fetchImpl(
        `${endpoint}/api/klient/delegation/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(canonicalInput),
          signal: callOptions?.signal === undefined
            ? controller.signal
            : AbortSignal.any([controller.signal, callOptions.signal]),
        },
      );
      const envelope = (await response.json()) as Envelope<unknown>;
      if (!response.ok || envelope.code !== 0) {
        throw new SeatKlientError(envelope.code, envelope.msg, envelope.details);
      }
      return procedure.outputSchema.parse(envelope.data) as DelegationProcedureOutput<Name>;
    } finally {
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
    profiles: (input = {}) => call('profiles', input),
    list: (input = {}) => call('list', input),
    dispatch: (input) => call('dispatch', input),
    continue: (input) => call('continue', input),
    send: (input) => call('send', input),
    interactions: (input = {}) => call('interactions', input),
    respond: (input) => call('respond', input),
    status: (input) => call('status', input),
    wait: (input = {}, callOptions) => call('wait', input, callOptions),
    result: (input) => call('result', input),
    events: (input) => call('events', input),
    transcript: (input) => call('transcript', input),
    cancel: (input) => call('cancel', input),
    close,
  };
}
