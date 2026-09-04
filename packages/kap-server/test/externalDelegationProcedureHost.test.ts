import { ISessionExternalDelegationService, resumeSessionById } from '@moonshot-ai/agent-core-v2';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalDelegationProcedureHost } from '../src/procedures/externalDelegationHost';
import { registerSeatKlientDelegationRoutes } from '../src/procedures/http';

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
  };

  beforeEach(() => {
    service.dispatch.mockReset();
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
});

describe('seat klient delegation HTTP routes', () => {
  it('accepts only the pinned seat bearer and strict canonical body', async () => {
    const app = Fastify({ logger: false });
    const call = vi.fn(async () => dispatchView);
    registerSeatKlientDelegationRoutes(
      app,
      { call } as unknown as ExternalDelegationProcedureHost,
      {
        async resolve(token) {
          return token === 'SEAT_TOKEN'
            ? { ...seat, delegationToken: 'SEAT_TOKEN' }
            : null;
        },
      },
    );

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

    await app.close();
  });
});
