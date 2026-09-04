import type {
  DispatchWaitRequest,
  ExternalContinueRequest,
  ExternalDispatchLookup,
  ExternalDispatchRequest,
  ExternalEventsLookup,
  ExternalInteractionsRequest,
  ExternalPageLookup,
  ExternalRespondRequest,
  ExternalSendRequest,
  ExternalTranscriptLookup,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createSeatKlient,
  delegationProcedureTable,
  type DelegationProcedureInputs,
} from '../src/procedures/index';

type WithoutAuthority<T> = T extends unknown ? Omit<T, 'authority' | 'signal'> : never;
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type CoreInputs = {
  dispatch: WithoutAuthority<ExternalDispatchRequest>;
  continue: WithoutAuthority<ExternalContinueRequest>;
  send: WithoutAuthority<ExternalSendRequest>;
  interactions: WithoutAuthority<ExternalInteractionsRequest>;
  respond: WithoutAuthority<ExternalRespondRequest>;
  status: WithoutAuthority<ExternalDispatchLookup>;
  wait: WithoutAuthority<DispatchWaitRequest>;
  result: WithoutAuthority<ExternalPageLookup>;
  events: WithoutAuthority<ExternalEventsLookup>;
  transcript: WithoutAuthority<ExternalTranscriptLookup>;
  cancel: WithoutAuthority<ExternalDispatchLookup>;
};
type AssertCoreToProcedure<Name extends keyof CoreInputs> = Mutable<CoreInputs[Name]> extends DelegationProcedureInputs[Name]
  ? true
  : never;

const parity: { readonly [Name in keyof CoreInputs]: AssertCoreToProcedure<Name> } = {
  dispatch: true,
  continue: true,
  send: true,
  interactions: true,
  respond: true,
  status: true,
  wait: true,
  result: true,
  events: true,
  transcript: true,
  cancel: true,
};
void parity;

describe('external delegation procedures', () => {
  it('owns thirteen unique procedure and MCP names with strict JSON schemas', () => {
    expect(delegationProcedureTable).toHaveLength(13);
    expect(new Set(delegationProcedureTable.map((procedure) => procedure.name)).size).toBe(13);
    expect(new Set(delegationProcedureTable.map((procedure) => procedure.mcp.toolName)).size).toBe(13);

    for (const procedure of delegationProcedureTable) {
      expect(() => z.toJSONSchema(procedure.inputSchema)).not.toThrow();
      const candidate = procedure.name === 'dispatch'
        ? { target: 'main', message: 'inspect', unexpected: true }
        : procedure.name === 'continue'
          ? { dispatchId: 'dispatch-1', message: 'inspect', unexpected: true }
          : procedure.name === 'send'
            ? { taskName: 'probe', message: 'inspect', unexpected: true }
            : procedure.name === 'respond'
              ? { interactionId: 'interaction-1', kind: 'question', response: null, unexpected: true }
              : procedure.name === 'wait'
                ? { unexpected: true }
                : procedure.name === 'profiles' || procedure.name === 'list'
                  ? { unexpected: true }
                  : { dispatchId: 'dispatch-1', unexpected: true };
      expect(procedure.inputSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('calls the seat endpoint with only canonical input and the seat bearer', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:58627/api/klient/delegation/dispatch');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer SEAT_TOKEN');
      expect(JSON.parse(String(init?.body))).toEqual({
        target: 'named',
        taskName: 'probe',
        message: 'inspect',
      });
      return new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          dispatchId: 'dispatch-1',
          target: 'named',
          taskName: 'probe',
          status: 'queued',
          createdAt: 1,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const klient = createSeatKlient({
      endpoint: 'http://127.0.0.1:58627/',
      token: 'SEAT_TOKEN',
      fetch: fetchMock,
    });

    await expect(klient.dispatch({
      target: 'named',
      taskName: 'probe',
      message: 'inspect',
    })).resolves.toMatchObject({ dispatchId: 'dispatch-1' });
  });
});
