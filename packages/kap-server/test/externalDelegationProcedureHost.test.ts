import assert from 'node:assert/strict';

import { ISessionExternalDelegationService, resumeSessionById } from '@kiki/agent-core-v2';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalDelegationProcedureHost } from '../src/procedures/externalDelegationHost';
import {
  createSeatKlientDelegationAuth,
  registerSeatKlientDelegationRoutes,
} from '../src/procedures/http';

const ensureMainAgent = vi.hoisted(() => vi.fn());

vi.mock('@kiki/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/agent-core-v2')>();
  return { ...actual, resumeSessionById: vi.fn() };
});

vi.mock('../src/transport/mainAgent', () => ({ ensureMainAgent }));

const seat = {
  seatId: 'seat-1',
  principalId: 'principal-1',
  sessionId: 'session-1',
  workspacePath: '/example/workspace',
};

const dispatchView = {
  dispatchId: 'dispatch-1',
  target: 'named' as const,
  taskName: 'probe',
  profileName: 'explore',
  agentId: 'agent-secret',
  status: 'queued' as const,
  createdAt: 1,
};

describe('ExternalDelegationProcedureHost', () => {
  const service = {
    dispatch: vi.fn(),
    interactions: vi.fn(),
    wait: vi.fn(),
    events: vi.fn(),
    transcript: vi.fn(),
    list: vi.fn(),
  };

  beforeEach(() => {
    for (const method of Object.values(service)) method.mockReset();
    vi.mocked(resumeSessionById).mockResolvedValue({
      accessor: {
        get(identifier: unknown) {
          assert.equal(identifier, ISessionExternalDelegationService);
          return service;
        },
      },
    } as never);
    ensureMainAgent.mockResolvedValue(undefined);
  });

  it('injects seat authority and removes raw agent identifiers', async () => {
    service.dispatch.mockResolvedValue(dispatchView);
    const host = new ExternalDelegationProcedureHost({} as never);

    const output = await host.call(seat, 'dispatch', {
      target: 'named',
      taskName: 'probe',
      message: 'inspect',
    });

    expect(output).toEqual({
      dispatchId: 'dispatch-1',
      target: 'named',
      taskName: 'probe',
      profileName: 'explore',
      status: 'queued',
      createdAt: 1,
    });
    expect(service.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      target: 'named',
      taskName: 'probe',
      message: 'inspect',
      authority: {
        principalFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        authorityFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        configFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    }));
  });

  it('projects real approval, question, and prompt origins without rewriting opaque display content', async () => {
    const host = new ExternalDelegationProcedureHost({} as never);
    service.interactions.mockResolvedValue({
      items: [{
        interactionId: 'interaction-1',
        kind: 'approval',
        taskName: 'probe',
        payload: {
          id: 'approval-internal',
          sessionId: 'session-internal',
          agentId: 'agent-internal',
          turnId: 41,
          toolCallId: 'tool-internal',
          toolName: 'Inspect',
          action: 'inspect files',
          display: {
            kind: 'generic',
            summary: 'Inspect files',
            detail: { agentId: 'customer-display', sessionId: 'customer-session' },
          },
        },
        createdAt: 1,
      }],
    });
    service.wait.mockResolvedValue({
      waitStatus: 'completed',
      waitedMs: 1,
      completedDuringWait: [],
      interactions: [{
        interactionId: 'interaction-2',
        kind: 'question',
        taskName: 'probe',
        payload: {
          id: 'question-internal',
          turnId: 42,
          toolCallId: 'question-tool-internal',
          questions: [{
            question: 'Continue?',
            header: 'Decision',
            body: 'Choose one.',
            options: [{ label: 'Yes', description: 'Continue.' }],
            multiSelect: false,
            otherLabel: 'Custom',
            otherDescription: 'Enter a custom answer.',
          }],
        },
        createdAt: 2,
      }],
    });
    service.events.mockResolvedValue({
      items: [{
        seq: 1,
        dispatchId: 'dispatch-1',
        at: 1,
        agentId: 'event-agent-internal',
        event: {
          type: 'tool.call',
          toolCallId: 'tool-1',
          title: 'Inspect',
          rawInput: { agentId: 'customer-event', agent_id: 'customer-event-snake' },
          agent_id: 'event-agent-snake-internal',
        },
      }],
    });
    service.transcript.mockResolvedValue({
      cursor: 0,
      items: [{
        kind: 'turn',
        turnId: 'turn-1',
        ordinal: 0,
        state: 'completed',
        origin: {
          kind: 'agent_message',
          messageId: 'message-1',
          senderAgentId: 'sender-agent-internal',
          senderTaskName: 'researcher',
        },
        steps: [{
          kind: 'step',
          stepId: 'step-1',
          turnId: 'turn-1',
          ordinal: 0,
          state: 'completed',
          frames: [{
            kind: 'tool',
            frameId: 'frame-1',
            toolCallId: 'tool-1',
            name: 'Inspect',
            state: 'done',
            input: { agentId: 'customer-input' },
            output: { agent_id: 'customer-output' },
            display: { agentID: 'customer-frame-display' },
            progress: { AgentId: 'customer-progress' },
          }],
        }],
      }],
    });

    const interactions = await host.call(seat, 'interactions', {});
    const waited = await host.call(seat, 'wait', {});
    const events = await host.call(seat, 'events', { dispatchId: 'dispatch-1', detail: 'turn' });
    const transcript = await host.call(seat, 'transcript', { dispatchId: 'dispatch-1', detail: 'items' });
    const combined = JSON.stringify({ interactions, waited, events, transcript });

    for (const secret of [
      'approval-internal',
      'session-internal',
      'agent-internal',
      'tool-internal',
      'question-internal',
      'question-tool-internal',
      'event-agent-internal',
      'event-agent-snake-internal',
      'sender-agent-internal',
    ]) {
      expect(combined).not.toContain(secret);
    }
    expect(interactions.items[0]?.payload).toEqual({
      toolName: 'Inspect',
      action: 'inspect files',
      display: {
        kind: 'generic',
        summary: 'Inspect files',
        detail: { agentId: 'customer-display', sessionId: 'customer-session' },
      },
    });
    expect(waited.interactions[0]?.payload).toEqual({
      questions: [{
        question: 'Continue?',
        header: 'Decision',
        body: 'Choose one.',
        options: [{ label: 'Yes', description: 'Continue.' }],
        multiSelect: false,
        otherLabel: 'Custom',
        otherDescription: 'Enter a custom answer.',
      }],
    });
    expect(events.items[0]).toMatchObject({
      event: { rawInput: { agentId: 'customer-event', agent_id: 'customer-event-snake' } },
    });
    expect(transcript).toMatchObject({
      items: [{
        origin: {
          kind: 'agent_message',
          messageId: 'message-1',
          senderTaskName: 'researcher',
        },
        steps: [{
          frames: [{
            input: { agentId: 'customer-input' },
            output: { agent_id: 'customer-output' },
            display: { agentID: 'customer-frame-display' },
            progress: { AgentId: 'customer-progress' },
          }],
        }],
      }],
    });
  });

  it('closes embedded seat klients idempotently', async () => {
    const host = new ExternalDelegationProcedureHost({} as never);
    const klient = host.klient(seat);

    await klient.close();
    await klient.close();

    await expect(klient.list()).rejects.toThrow('seat klient closed');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('aborts an active embedded seat wait when the klient closes', async () => {
    let signal: AbortSignal | undefined;
    service.wait.mockImplementation(async (input) => {
      signal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
    });
    const host = new ExternalDelegationProcedureHost({} as never);
    const klient = host.klient(seat);

    const pending = klient.wait({ dispatchId: 'dispatch-1' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await klient.close();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
  });
});

describe('seat klient delegation HTTP routes', () => {
  it('accepts only the pinned seat bearer and strict canonical body', async () => {
    const app = Fastify({ logger: false });
    const call = vi.fn(async () => dispatchView);
    const resolver = {
      async resolve(token: string) {
        return token === 'SEAT_TOKEN'
          ? { ...seat, delegationToken: 'SEAT_TOKEN' }
          : null;
      },
    };
    const auth = createSeatKlientDelegationAuth(() => resolver);
    app.addHook('onRequest', auth.onRequest);
    registerSeatKlientDelegationRoutes(
      app,
      { call } as unknown as ExternalDelegationProcedureHost,
      auth,
    );
    const observedAuthorization: Array<string | undefined> = [];
    app.addHook('onRequest', async (req) => {
      observedAuthorization.push(req.headers.authorization);
    });

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/klient/delegation/dispatch',
      headers: { authorization: 'Bearer SEAT_TOKEN' },
      payload: { target: 'named', taskName: 'probe', message: 'inspect' },
    });
    const daemon = await app.inject({
      method: 'POST',
      url: '/api/klient/delegation/dispatch',
      headers: { authorization: 'Bearer DAEMON_TOKEN' },
      payload: { target: 'named', taskName: 'probe', message: 'inspect' },
    });
    const authorityOverride = await app.inject({
      method: 'POST',
      url: '/api/klient/delegation/dispatch',
      headers: { authorization: 'Bearer SEAT_TOKEN' },
      payload: {
        target: 'named',
        taskName: 'probe',
        message: 'inspect',
        sessionId: 'session-other',
        workspacePath: '/other',
        principalId: 'principal-other',
        mode: 'yolo',
      },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/klient/delegation/dispach',
      headers: { authorization: 'Bearer SEAT_TOKEN' },
      payload: {},
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ code: 0, data: { dispatchId: 'dispatch-1' } });
    expect(call).toHaveBeenCalledWith(seat, 'dispatch', {
      target: 'named',
      taskName: 'probe',
      message: 'inspect',
    });
    expect(daemon.statusCode).toBe(401);
    expect(authorityOverride.json()).toMatchObject({ code: 40001 });
    expect(JSON.stringify(authorityOverride.json())).not.toContain('SEAT_TOKEN');
    expect(unknown.statusCode).toBe(404);
    expect(observedAuthorization).toEqual([undefined, undefined, undefined]);

    await app.close();
  });

  it('logs seat HTTP failures without credential or private error text', async () => {
    let logs = '';
    const app = Fastify({
      logger: {
        level: 'warn',
        stream: { write: (chunk: string) => { logs += chunk; } },
      },
    });
    const call = vi.fn(async () => {
      throw new Error('Bearer SEAT_SECRET https://example.test/signed?token=URL_SECRET C:\\private\\workspace');
    });
    const auth = createSeatKlientDelegationAuth(() => ({
      async resolve(token: string) {
        return token === 'SEAT_TOKEN' ? { ...seat, delegationToken: 'SEAT_TOKEN' } : null;
      },
    }));
    app.addHook('onRequest', auth.onRequest);
    registerSeatKlientDelegationRoutes(
      app,
      { call } as unknown as ExternalDelegationProcedureHost,
      auth,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/klient/delegation/list',
      headers: { authorization: 'Bearer SEAT_TOKEN' },
      payload: {},
    });
    await app.close();

    expect(response.json()).toMatchObject({ code: 40001, msg: 'External delegation request failed.' });
    expect(logs).toContain('"error_class":"internal_error"');
    expect(logs).not.toContain('SEAT_TOKEN');
    expect(logs).not.toContain('SEAT_SECRET');
    expect(logs).not.toContain('URL_SECRET');
    expect(logs).not.toContain('private\\workspace');
  });

  it('aborts a seat HTTP wait when the request disconnects', async () => {
    const app = Fastify({ logger: false });
    let signal: AbortSignal | undefined;
    const call = vi.fn(async (_seat, _name, _input, inputSignal?: AbortSignal) => {
      signal = inputSignal;
      return new Promise((_resolve, reject) => {
        inputSignal?.addEventListener('abort', () => reject(inputSignal.reason), { once: true });
      });
    });
    const auth = createSeatKlientDelegationAuth(() => ({
      async resolve(token: string) {
        return token === 'SEAT_TOKEN' ? { ...seat, delegationToken: 'SEAT_TOKEN' } : null;
      },
    }));
    app.addHook('onRequest', auth.onRequest);
    registerSeatKlientDelegationRoutes(
      app,
      { call } as unknown as ExternalDelegationProcedureHost,
      auth,
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const disconnect = new AbortController();

    const pending = fetch(`${address}/api/klient/delegation/wait`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer SEAT_TOKEN',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dispatchId: 'dispatch-1' }),
      signal: disconnect.signal,
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    disconnect.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await app.close();
  });

  it('does not abort a normally completed seat HTTP wait', async () => {
    const app = Fastify({ logger: false });
    let signal: AbortSignal | undefined;
    const call = vi.fn(async (_seat, _name, _input, inputSignal?: AbortSignal) => {
      signal = inputSignal;
      return {
        waitStatus: 'completed',
        waitedMs: 1,
        completedDuringWait: [],
        interactions: [],
      };
    });
    const auth = createSeatKlientDelegationAuth(() => ({
      async resolve(token: string) {
        return token === 'SEAT_TOKEN' ? { ...seat, delegationToken: 'SEAT_TOKEN' } : null;
      },
    }));
    app.addHook('onRequest', auth.onRequest);
    registerSeatKlientDelegationRoutes(
      app,
      { call } as unknown as ExternalDelegationProcedureHost,
      auth,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/klient/delegation/wait',
      headers: { authorization: 'Bearer SEAT_TOKEN' },
      payload: { dispatchId: 'dispatch-1' },
    });

    expect(response.json()).toMatchObject({ code: 0, data: { waitStatus: 'completed' } });
    expect(signal?.aborted).toBe(false);
    await app.close();
  });
});
