import { createHash } from 'node:crypto';

import {
  ISessionExternalDelegationService,
  resumeSessionById,
  type ExternalAuthority,
  type ExternalDispatchView,
  type ISessionExternalDelegationService as ExternalDelegationService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  delegationProcedure,
  type DelegationProcedureInput,
  type DelegationProcedureName,
  type DelegationProcedureOutput,
  type SeatKlient,
} from '@moonshot-ai/klient/procedures';

import { ensureMainAgent } from '../transport/mainAgent';

export interface ExternalDelegationSeatAuthority {
  readonly seatId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly workspacePath?: string;
}

export class ExternalDelegationProcedureHost {
  constructor(private readonly core: Scope) {}

  async call<Name extends DelegationProcedureName>(
    seat: ExternalDelegationSeatAuthority,
    name: Name,
    input: DelegationProcedureInput<Name>,
    signal?: AbortSignal,
  ): Promise<DelegationProcedureOutput<Name>> {
    const procedure = delegationProcedure(name);
    const canonicalInput = procedure.inputSchema.parse(input) as DelegationProcedureInput<Name>;
    const session = await resumeSessionById(this.core.accessor, seat.sessionId);
    if (session === undefined) throw new Error('Session does not exist.');
    await ensureMainAgent(session);
    const service = session.accessor.get(ISessionExternalDelegationService);
    const output = await execute(service, authorityFor(seat), seat, name, canonicalInput, signal);
    return procedure.outputSchema.parse(output) as DelegationProcedureOutput<Name>;
  }

  klient(seat: ExternalDelegationSeatAuthority): SeatKlient {
    const call = <Name extends DelegationProcedureName>(
      name: Name,
      input: DelegationProcedureInput<Name>,
      options?: { readonly signal?: AbortSignal },
    ) => this.call(seat, name, input, options?.signal);
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
      wait: (input = {}, options) => call('wait', input, options),
      result: (input) => call('result', input),
      events: (input) => call('events', input),
      transcript: (input) => call('transcript', input),
      cancel: (input) => call('cancel', input),
    };
  }
}

async function execute<Name extends DelegationProcedureName>(
  service: ExternalDelegationService,
  authority: ExternalAuthority,
  seat: ExternalDelegationSeatAuthority,
  name: Name,
  input: DelegationProcedureInput<Name>,
  signal?: AbortSignal,
): Promise<DelegationProcedureOutput<Name>> {
  switch (name) {
    case 'profiles': {
      const root = await service.list(authority);
      return {
        profiles: root.dispatchables.filter((entry) => entry.kind === 'named'),
        binding: binding(seat),
      } as DelegationProcedureOutput<Name>;
    }
    case 'list': {
      const root = await service.list(authority);
      return {
        version: root.version,
        delegationId: root.delegationId,
        lifecycle: root.lifecycle,
        dispatchables: root.dispatchables,
        children: root.children,
        continuations: root.continuations.map(publicDispatch),
        binding: binding(seat),
      } as DelegationProcedureOutput<Name>;
    }
    case 'dispatch': {
      const value = input as DelegationProcedureInput<'dispatch'>;
      return publicDispatch(await service.dispatch({ authority, ...value })) as DelegationProcedureOutput<Name>;
    }
    case 'continue': {
      const value = input as DelegationProcedureInput<'continue'>;
      return publicDispatch(await service.continue({ authority, ...value })) as DelegationProcedureOutput<Name>;
    }
    case 'send': {
      const value = input as DelegationProcedureInput<'send'>;
      const accepted = await service.send({
        authority,
        taskName: value.taskName,
        message: value.message,
        idempotencyKey: value.idempotencyKey,
      });
      return {
        message: {
          messageId: accepted.message.messageId,
          sourceTaskName: accepted.message.sourceTaskName,
          targetTaskName: accepted.message.targetTaskName,
          content: accepted.message.content,
          acceptedAt: accepted.message.acceptedAt,
          targetSeq: accepted.message.targetSeq,
        },
        deduplicated: accepted.deduplicated,
        delivery: accepted.delivery,
        payloadConflict: accepted.payloadConflict,
      } as DelegationProcedureOutput<Name>;
    }
    case 'interactions': {
      const value = input as DelegationProcedureInput<'interactions'>;
      const page = await service.interactions({ authority, cursor: value.cursor });
      return redactAgentIds(page) as DelegationProcedureOutput<Name>;
    }
    case 'respond': {
      const value = input as DelegationProcedureInput<'respond'>;
      return await service.respond({ authority, ...value }) as DelegationProcedureOutput<Name>;
    }
    case 'status': {
      const value = input as DelegationProcedureInput<'status'>;
      return publicDispatch(await service.status({ authority, dispatchId: value.dispatchId })) as DelegationProcedureOutput<Name>;
    }
    case 'wait': {
      const value = input as DelegationProcedureInput<'wait'>;
      const waited = await service.wait({ authority, ...value, signal });
      return {
        ...waited,
        dispatch: waited.dispatch === undefined ? undefined : publicDispatch(waited.dispatch),
        completedDuringWait: waited.completedDuringWait.map(publicDispatch),
        interactions: redactAgentIds(waited.interactions),
      } as DelegationProcedureOutput<Name>;
    }
    case 'result': {
      const value = input as DelegationProcedureInput<'result'>;
      const page = await service.result({ authority, ...value });
      return { ...page, dispatch: publicDispatch(page.dispatch) } as DelegationProcedureOutput<Name>;
    }
    case 'events': {
      const value = input as DelegationProcedureInput<'events'>;
      return redactAgentIds(await service.events({ authority, ...value })) as DelegationProcedureOutput<Name>;
    }
    case 'transcript': {
      const value = input as DelegationProcedureInput<'transcript'>;
      return redactAgentIds(await service.transcript({ authority, ...value })) as DelegationProcedureOutput<Name>;
    }
    case 'cancel': {
      const value = input as DelegationProcedureInput<'cancel'>;
      return publicDispatch(await service.cancel({ authority, dispatchId: value.dispatchId })) as DelegationProcedureOutput<Name>;
    }
  }
}

function binding(seat: ExternalDelegationSeatAuthority) {
  return {
    version: 1 as const,
    seatId: seat.seatId,
    sessionId: seat.sessionId,
    principalId: seat.principalId,
    workspacePath: seat.workspacePath,
  };
}

function publicDispatch(value: ExternalDispatchView): Omit<ExternalDispatchView, 'agentId'> {
  const { agentId: _agentId, ...dispatch } = value;
  return dispatch;
}

function authorityFor(seat: ExternalDelegationSeatAuthority): ExternalAuthority {
  return {
    principalFingerprint: sha256(`principal:v1:${seat.principalId}`),
    authorityFingerprint: sha256(`authority:v2:${seat.principalId}:${seat.seatId}:external-delegation`),
    configFingerprint: sha256('config:v2:main+named:immutable-new-child-bindings'),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactAgentIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactAgentIds) as T;
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'agentId' || key === 'sourceAgentId' || key === 'targetAgentId' || key === 'agent_id') continue;
    result[key] = redactAgentIds(entry);
  }
  return result as T;
}
