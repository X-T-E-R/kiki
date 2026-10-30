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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createSeatKlient,
  delegationProcedureTable,
  type DelegationProcedureInputs,
  type SeatKlient,
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
  it('retains declared menus, effective candidates and constraint diagnostics in strict outputs', () => {
    const binding = { version: 1, seatId: 'seat', sessionId: 'session', principalId: 'principal' };
    const profile = { kind: 'named', profileName: 'helper', restrictModelsToMenu: true,
      declaredModelMenu: ['default', 'denied'], effectiveModelAliases: ['default'], modelMenuDiagnostics: ['A caller lease cannot expand the menu.'],
      allowedModels: ['default', 'denied'], denyModels: ['denied'], preferredModels: ['default'], allowedEfforts: ['high'], preferredEfforts: ['high'], discouragedModels: ['denied'],
      alternativeModels: [] };
    const profiles = delegationProcedureTable.find((procedure) => procedure.name === 'profiles')!;
    expect(profiles.outputSchema.parse({ profiles: [profile], binding })).toEqual({ profiles: [profile], binding });
    const list = delegationProcedureTable.find((procedure) => procedure.name === 'list')!;
    const root = { version: 1, delegationId: 'delegation', lifecycle: 'active', dispatchables: [profile], children: [], continuations: [], binding };
    expect(list.outputSchema.parse(root)).toEqual(root);
    expect(profiles.outputSchema.safeParse({ profiles: [{ ...profile, restrictModelsToMenu: 'true' }], binding }).success).toBe(false);
  });
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
      expect(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      ).toBe('http://127.0.0.1:58627/api/klient/delegation/dispatch');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer SEAT_TOKEN');
      expect(JSON.parse(init?.body as string)).toEqual({
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


describe('seat call lifetime', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('does not dispatch a write whose input preparation exhausts the entry budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn<typeof fetch>();
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock, timeoutMs: 100 });
    await expect(klient.dispatch({ target: 'main', dispatchKey: 'original-key',
      get message() { vi.setSystemTime(101); return 'inspect'; } })).rejects.toMatchObject({ details: {
      outcome: 'not_sent', phase: 'headers', dispatchKey: 'original-key', timeoutMs: 100,
    } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await klient.close();
  });

  it('allows a disabled deadline while retaining cancellation and independent calls', async () => {
    vi.useFakeTimers();
    const source = new AbortController();
    let requestSignal!: AbortSignal;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      requestSignal = init!.signal!;
      return new Response(new ReadableStream());
    });
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock, timeoutMs: 10 });
    const rejected = expect(klient.events({ dispatchId: 'dispatch-1' }, { timeoutMs: 0, signal: source.signal })).rejects.toThrow('stop only this call');
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(requestSignal.aborted).toBe(false);
    source.abort(new Error('stop only this call'));
    await rejected;
    fetchMock.mockResolvedValueOnce(Response.json({ code: 0, msg: 'ok', data: { items: [] } }));
    await expect(klient.events({ dispatchId: 'dispatch-1' })).resolves.toEqual({ items: [] });
    expect(vi.getTimerCount()).toBe(0);
    await klient.close();
  });

  it.each(['headers', 'body', 'trickle'] as const)('bounds %s by a single entry deadline', async phase => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>(async () => phase === 'headers'
      ? new Promise<Response>(() => {})
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel })));
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock, timeoutMs: 100 });
    const rejected = expect(klient.events({ dispatchId: 'dispatch-1' })).rejects.toMatchObject({
      code: 50001, details: { reason: 'transport.timeout', phase: phase === 'headers' ? 'headers' : 'body', outcome: 'unknown', timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(0);
    if (phase === 'trickle') {
      for (let index = 0; index < 4; index++) {
        stream.enqueue(new TextEncoder().encode(index === 0 ? '{' : ' '));
        await vi.advanceTimersByTimeAsync(20);
      }
    }
    await vi.advanceTimersByTimeAsync(phase === 'trickle' ? 20 : 100);
    await rejected;
    if (phase !== 'headers') expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await klient.close();
  });

  it('uses the 30s default through response body consumption', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN',
      fetch: async () => new Response(new ReadableStream({ cancel })) });
    let settled = false;
    const call = klient.status({ dispatchId: 'dispatch-1' });
    void call.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(call).rejects.toMatchObject({ details: { timeoutMs: 30_000, phase: 'body' } });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    await klient.close();
  });

  it.each(['abort', 'close'] as const)('settles a stalled body on %s and cancels its reader', async reason => {
    const source = new AbortController();
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })));
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock });
    const call = klient.events({ dispatchId: 'dispatch-1' }, { signal: source.signal });
    const rejected = expect(call).rejects.toBeDefined();
    await Promise.resolve();
    if (reason === 'abort') source.abort(new Error('stop watching'));
    else await klient.close();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    await klient.close();
  });

  it('cancels a late response after timing out an uncooperative fetch', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock, timeoutMs: 10 });
    const rejected = expect(klient.list()).rejects.toMatchObject({ details: { phase: 'headers' } });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    const cancel = vi.fn();
    release(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    await klient.close();
  });

  it.each(['dispatch', 'continue', 'send'] as const)('retains an unknown %s identity without retrying the write', async name => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream()));
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock });
    const call = name === 'dispatch'
      ? klient.dispatch({ target: 'main', message: 'inspect', dispatchKey: 'original-key' }, { timeoutMs: 10 })
      : name === 'continue'
        ? klient.continue({ dispatchId: 'dispatch-1', message: 'inspect', dispatchKey: 'original-key' }, { timeoutMs: 10 })
        : klient.send({ taskName: 'helper', message: 'inspect', idempotencyKey: 'original-key' }, { timeoutMs: 10 });
    const rejected = expect(call).rejects.toMatchObject({ details: { procedure: name, outcome: 'unknown',
      ...(name === 'send' ? { idempotencyKey: 'original-key' } : { dispatchKey: 'original-key' }) } });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject(name === 'send'
      ? { idempotencyKey: 'original-key' } : { dispatchKey: 'original-key' });
    await klient.close();
  });

  it('preserves an explicit ten-minute server wait independently of the ordinary default', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    let requestSignal!: AbortSignal;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init!.signal!;
      return new Promise(resolve => { release = resolve; });
    });
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock, timeoutMs: 10 });
    const waiting = klient.wait({ dispatchId: 'dispatch-1', timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(requestSignal.aborted).toBe(false);
    release(Response.json({ code: 0, msg: 'ok', data: { waitStatus: 'timed_out', waitedMs: 600_000, completedDuringWait: [], interactions: [] } }));
    await expect(waiting).resolves.toMatchObject({ waitStatus: 'timed_out', waitedMs: 600_000 });
    expect(vi.getTimerCount()).toBe(0);
    await klient.close();
  });

  it('applies a finite wait margin and honors a deliberate transport override', async () => {
    vi.useFakeTimers();
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: async () => new Promise(() => {}) });
    const first = expect(klient.wait({ timeoutMs: 60_000 })).rejects.toMatchObject({ details: { timeoutMs: 70_000 } });
    await vi.advanceTimersByTimeAsync(70_000);
    await first;
    const second = expect(klient.wait({ timeoutMs: 60_000 }, { timeoutMs: 5 })).rejects.toMatchObject({ details: { timeoutMs: 5 } });
    await vi.advanceTimersByTimeAsync(5);
    await second;
    await klient.close();
  });

  it('forwards a signal through all convenience wrappers without sending pre-aborted calls', async () => {
    const source = new AbortController();
    source.abort(new Error('already stopped'));
    const fetchMock = vi.fn<typeof fetch>();
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock });
    const options = { signal: source.signal };
    const calls: Array<(client: SeatKlient) => Promise<unknown>> = [
      client => client.profiles({}, options), client => client.list({}, options),
      client => client.dispatch({ target: 'main', message: 'inspect' }, options),
      client => client.continue({ dispatchId: 'dispatch-1', message: 'inspect' }, options),
      client => client.send({ taskName: 'helper', message: 'inspect', idempotencyKey: 'key' }, options),
      client => client.interactions({}, options),
      client => client.respond({ interactionId: 'interaction-1', kind: 'question', response: null }, options),
      client => client.status({ dispatchId: 'dispatch-1' }, options), client => client.wait({}, options),
      client => client.result({ dispatchId: 'dispatch-1' }, options), client => client.events({ dispatchId: 'dispatch-1' }, options),
      client => client.transcript({ dispatchId: 'dispatch-1' }, options), client => client.cancel({ dispatchId: 'dispatch-1' }, options),
    ];
    for (const call of calls) await expect(call(klient)).rejects.toThrow('already stopped');
    expect(fetchMock).not.toHaveBeenCalled();
    await klient.close();
  });
});
