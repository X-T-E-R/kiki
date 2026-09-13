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
} from '@kiki/agent-core-v2';
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
          activity: {
            activeToolCalls: [{ toolCallId: 'call-1', name: 'Read', since: 1 }],
          },
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
    })).resolves.toMatchObject({
      dispatchId: 'dispatch-1',
      activity: { activeToolCalls: [{ toolCallId: 'call-1', name: 'Read', since: 1 }] },
    });
  });

  it('closes the HTTP client idempotently and aborts active calls', async () => {
    let aborted = false;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(init.signal?.reason);
      }, { once: true });
    }));
    const klient = createSeatKlient({
      endpoint: 'http://127.0.0.1:58627',
      token: 'SEAT_TOKEN',
      fetch: fetchMock,
    });
    const pending = klient.list();
    const first = klient.close();
    const second = klient.close();

    expect(first).toBe(second);
    await first;
    await expect(pending).rejects.toBeDefined();
    await expect(klient.list()).rejects.toThrow('seat klient closed');
    expect(aborted).toBe(true);
  });

  it('validates every transcript variant and rejects malformed structured items', () => {
    const schema = delegationProcedureTable.find((procedure) => procedure.name === 'transcript')!.outputSchema;
    const textPage = {
      items: [{ index: 0, role: 'assistant', text: 'done' }],
      nextCursor: 1,
    };
    const itemsPage = {
      cursor: 0,
      nextCursor: 3,
      items: [
        {
          kind: 'turn',
          turnId: 'turn-1',
          ordinal: 0,
          state: 'completed',
          origin: {
            kind: 'agent_message',
            messageId: 'message-1',
            senderTaskName: 'researcher',
          },
          prompt: 'inspect',
          steps: [{
            kind: 'step',
            stepId: 'step-1',
            turnId: 'turn-1',
            ordinal: 0,
            state: 'completed',
            frames: [
              { kind: 'text', frameId: 'frame-text', role: 'assistant', text: 'done' },
              { kind: 'thinking', frameId: 'frame-thinking', text: 'inspect' },
              {
                kind: 'tool',
                frameId: 'frame-tool',
                toolCallId: 'tool-1',
                name: 'Inspect',
                state: 'done',
                input: { agentId: 'customer-input' },
                output: { ok: true },
                display: { title: 'Inspect' },
                progress: { current: 1 },
              },
            ],
            usage: {
              inputOther: 1,
              output: 2,
              inputCacheRead: 3,
              inputCacheCreation: 4,
            },
          }],
          usage: { total: 3 },
        },
        {
          kind: 'marker',
          markerId: 'marker-1',
          marker: 'checkpoint',
          payload: { agentId: 'customer-marker' },
        },
        {
          kind: 'taskref',
          refId: 'ref-1',
          taskId: 'task-1',
        },
      ],
    };

    expect(schema.safeParse(textPage).success).toBe(true);
    expect(schema.safeParse(itemsPage).success).toBe(true);
    expect(schema.safeParse({
      ...itemsPage,
      items: [{
        ...itemsPage.items[0],
        origin: {
          kind: 'agent_message',
          messageId: 'message-1',
          senderAgentId: 'agent-internal',
          senderTaskName: 'researcher',
        },
      }],
    }).success).toBe(false);
    expect(schema.safeParse({ cursor: 0, items: [{ kind: 'turn' }] }).success).toBe(false);
    expect(schema.safeParse({ cursor: 0, items: [{ kind: 'unknown' }] }).success).toBe(false);
  });
});
