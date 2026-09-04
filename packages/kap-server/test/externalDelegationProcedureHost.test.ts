import { ISessionExternalDelegationService, resumeSessionById } from '@moonshot-ai/agent-core-v2';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalDelegationProcedureHost } from '../src/procedures/externalDelegationHost';
import {
  createSeatKlientDelegationAuth,
  registerSeatKlientDelegationRoutes,
} from '../src/procedures/http';

const ensureMainAgent = vi.hoisted(() => vi.fn());

vi.mock('@moonshot-ai/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/agent-core-v2')>();
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
          expect(identifier).toBe(ISessionExternalDelegationService);
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

  it('projects host-owned identities without rewriting opaque customer payloads', async () => {
    const host = new ExternalDelegationProcedureHost({} as never);
    service.interactions.mockResolvedValue({
      items: [{
        interactionId: 'interaction-1',
        kind: 'approval',
        taskName: 'probe',
        payload: { agentId: 'customer-interaction', agent_id: 'customer-interaction-snake' },
        createdAt: 1,
        agentId: 'internal-interaction',
        agent_id: 'internal-interaction-snake',
        agentID: 'internal-interaction-id',
        AgentId: 'internal-interaction-case',
      }],
    });
    service.wait.mockResolvedValue({
      waitStatus: 'completed',
      waitedMs: 1,
      dispatch: {
        ...dispatchView,
        agent_id: 'internal-wait-snake',
        agentID: 'internal-wait-id',
        AgentId: 'internal-wait-case',
      },
      completedDuringWait: [],
      interactions: [{
        interactionId: 'interaction-2',
        kind: 'question',
        taskName: 'probe',
        payload: { agentId: 'customer-wait' },
        createdAt: 2,
        agentId: 'internal-wait-interaction',
      }],
    });
    service.events.mockResolvedValue({
      items: [{
        seq: 1,
        dispatchId: 'dispatch-1',
        at: 1,
        agentId: 'internal-event-item',
        event: {
          type: 'tool.call',
          toolCallId: 'tool-1',
          title: 'Inspect',
          rawInput: { agentId: 'customer-event', agent_id: 'customer-event-snake' },
          agent_id: 'internal-event-snake',
          agentID: 'internal-event-id',
          AgentId: 'internal-event-case',
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
        origin: { agentId: 'customer-origin' },
        steps: [{
          kind: 'step',
          stepId: 'step-1',
          turnId: 'turn-1',
          ordinal: 0,
          state: 'completed',
          agent_id: 'internal-step',
          frames: [{
            kind: 'tool',
            frameId: 'frame-1',
            toolCallId: 'tool-1',
            name: 'Inspect',
            state: 'done',
            input: { agentId: 'customer-input' },
            output: { agent_id: 'customer-output' },
            display: { agentID: 'customer-display' },
            progress: { AgentId: 'customer-progress' },
            agentId: 'internal-frame',
          }],
        }],
        agentID: 'internal-turn',
      }],
    });

    const interactions = await host.call(seat, 'interactions', {});
    const waited = await host.call(seat, 'wait', {});
    const events = await host.call(seat, 'events', { dispatchId: 'dispatch-1', detail: 'turn' });
    const transcript = await host.call(seat, 'transcript', { dispatchId: 'dispatch-1', detail: 'items' });
    const combined = JSON.stringify({ interactions, waited, events, transcript });

    for (const secret of [
      'internal-interaction',
      'internal-interaction-snake',
      'internal-interaction-id',
      'internal-interaction-case',
      'agent-secret',
      'internal-wait-snake',
      'internal-wait-id',
      'internal-wait-case',
      'internal-wait-interaction',
      'internal-event-item',
      'internal-event-snake',
      'internal-event-id',
      'internal-event-case',
      'internal-step',
      'internal-frame',
      'internal-turn',
    ]) {
      expect(combined).not.toContain(secret);
    }
    expect(interactions.items[0]?.payload).toEqual({
      agentId: 'customer-interaction',
      agent_id: 'customer-interaction-snake',
    });
    expect(waited.interactions[0]?.payload).toEqual({ agentId: 'customer-wait' });
    expect(events.items[0]).toMatchObject({
      event: { rawInput: { agentId: 'customer-event', agent_id: 'customer-event-snake' } },
    });
    expect(transcript).toMatchObject({
      items: [{
        origin: { agentId: 'customer-origin' },
        steps: [{
          frames: [{
            input: { agentId: 'customer-input' },
            output: { agent_id: 'customer-output' },
            display: { agentID: 'customer-display' },
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
});
