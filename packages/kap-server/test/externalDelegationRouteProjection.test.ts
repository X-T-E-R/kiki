import {
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
  Error2,
  ErrorCodes,
  resumeSessionById,
  type ExternalDispatchView,
  type ISessionExternalDelegationService as ExternalDelegationService,
} from '@kiki/agent-core-v2';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { registerV2ExternalDelegationRoutes } from '../src/routes/v2/externalDelegation';

const mainAgent = vi.hoisted(() => ({ ensure: vi.fn() }));

vi.mock('@kiki/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/agent-core-v2')>();
  return { ...actual, resumeSessionById: vi.fn() };
});

vi.mock('../src/transport/mainAgent', () => ({ ensureMainAgent: mainAgent.ensure }));

type Handler = (
  req: {
    readonly id: string;
    readonly params: unknown;
    readonly body?: unknown;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly log: {
      info(bindings: Record<string, unknown>, message: string): void;
      warn(bindings: Record<string, unknown>, message: string): void;
    };
  },
  reply: {
    readonly raw: {
      readonly writableFinished: boolean;
      once(event: 'close', listener: () => void): void;
      off(event: 'close', listener: () => void): void;
    };
    send(payload: unknown): unknown;
  },
) => Promise<void>;

const authorityConfig = {
  principalId: 'example-principal',
  sessionId: 'session-operator',
  token: 'DELEGATION_SECRET',
  state: { state: 'active' } as const,
};

const dispatchView: ExternalDispatchView = {
  dispatchId: 'dispatch_replay',
  target: 'named',
  taskName: 'probe',
  profileName: 'explore',
  agentId: 'agent-1',
  actualProfile: 'explore',
  modelAlias: 'grok-4.6',
  thinkingEffort: 'high',
  status: 'queued',
  nextStep: 'wait:dispatch_replay',
  continueHint: 'dispatch:probe',
  createdAt: 1,
  usage: { input: 3, output: 5, cacheRead: 2, cacheWrite: 1 },
};

describe('external delegation route projection', () => {
  let handlers: Map<string, Handler>;
  let logger = {
    info: vi.fn<(bindings: Record<string, unknown>, message: string) => void>(),
    warn: vi.fn<(bindings: Record<string, unknown>, message: string) => void>(),
  };
  let service: {
    [K in keyof ExternalDelegationService]: ReturnType<typeof vi.fn>;
  } & {
    wait: Mock<ExternalDelegationService['wait']>;
  };

  beforeEach(() => {
    handlers = new Map();
    logger = {
      info: vi.fn<(bindings: Record<string, unknown>, message: string) => void>(),
      warn: vi.fn<(bindings: Record<string, unknown>, message: string) => void>(),
    };
    service = {
      list: vi.fn(),
      dispatch: vi.fn(),
      continue: vi.fn(),
      send: vi.fn(),
      interactions: vi.fn(),
      respond: vi.fn(),
      status: vi.fn(),
      wait: vi.fn<ExternalDelegationService['wait']>(),
      result: vi.fn(),
      events: vi.fn(),
      transcript: vi.fn(),
      cancel: vi.fn(),
      _serviceBrand: vi.fn(),
    };
    vi.mocked(resumeSessionById).mockResolvedValue({
      accessor: { get: () => service },
    } as never);
    mainAgent.ensure.mockResolvedValue(undefined);
    registerV2ExternalDelegationRoutes(
      {
        post: (path, _options, handler) => {
          handlers.set(path, handler);
        },
      },
      {} as never,
      authorityConfig,
    );
  });

  it('registers the twelve external delegation commands', () => {
    expect([...handlers.keys()].toSorted()).toEqual([
      '/sessions/:session_id/external-delegation/cancel',
      '/sessions/:session_id/external-delegation/continue',
      '/sessions/:session_id/external-delegation/dispatch',
      '/sessions/:session_id/external-delegation/events',
      '/sessions/:session_id/external-delegation/interactions',
      '/sessions/:session_id/external-delegation/list',
      '/sessions/:session_id/external-delegation/respond',
      '/sessions/:session_id/external-delegation/result',
      '/sessions/:session_id/external-delegation/send',
      '/sessions/:session_id/external-delegation/status',
      '/sessions/:session_id/external-delegation/transcript',
      '/sessions/:session_id/external-delegation/wait',
    ]);
  });

  it('returns an explicit disabled-edge response', async () => {
    handlers.clear();
    registerV2ExternalDelegationRoutes(
      {
        post: (path, _options, handler) => {
          handlers.set(path, handler);
        },
      },
      {} as never,
      {
        ...authorityConfig,
        state: {
          state: 'disabled',
          reason: 'workspace_drift',
          message: 'workspace binding changed',
        },
      },
    );

    const response = await invoke('list', {});

    expect(response).toMatchObject({
      code: 40002,
      msg: expect.stringContaining('workspace_drift'),
    });
    expect(resumeSessionById).not.toHaveBeenCalled();
  });

  it('returns the domain replay view for repeated dispatch_key requests', async () => {
    service.dispatch.mockResolvedValue(dispatchView);
    service.continue.mockResolvedValue(dispatchView);

    const first = await invoke('dispatch', {
      target: 'named',
      task_name: 'probe',
      profile_name: 'explore',
      dispatch_key: 'stable-dispatch-key',
      message: 'inspect',
    });
    const replay = await invoke('dispatch', {
      target: 'named',
      task_name: 'probe',
      profile_name: 'explore',
      dispatch_key: 'stable-dispatch-key',
      message: 'inspect',
    });
    await invoke('continue', {
      dispatch_id: 'dispatch_previous',
      dispatch_key: 'stable-continue-key',
      message: 'continue',
    });

    expect(first.data).toEqual(expect.objectContaining({ dispatchId: dispatchView.dispatchId }));
    expect(first.data).not.toHaveProperty('agentId');
    expect(replay.data).toEqual(first.data);
    expect(service.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      dispatchKey: 'stable-dispatch-key',
    }));
    expect(service.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      dispatchKey: 'stable-dispatch-key',
    }));
    expect(service.continue).toHaveBeenCalledWith(expect.objectContaining({
      dispatchId: 'dispatch_previous',
      dispatchKey: 'stable-continue-key',
    }));
  });

  it('projects send, interactions, and respond requests onto core operations', async () => {
    service.send.mockResolvedValue({
      message: {
        messageId: 'message-1',
        sessionId: 'session-operator',
        sourceAgentId: 'agent-source',
        sourceTaskName: 'root',
        targetAgentId: 'agent-target',
        targetTaskName: 'probe',
        content: 'check this',
        acceptedAt: 1,
        targetSeq: 1,
      },
      deduplicated: false,
      delivery: 'queued',
      payloadConflict: false,
    });
    service.interactions.mockResolvedValue({
      items: [{
        interactionId: 'approval-1',
        kind: 'approval',
        taskName: 'probe',
        payload: {
          sessionId: 'session-operator',
          agentId: 'agent-internal',
          toolName: 'Inspect',
          action: 'inspect files',
          display: { kind: 'generic', summary: 'Inspect files' },
        },
        createdAt: 1,
      }],
    });
    service.respond.mockResolvedValue({ interactionId: 'approval-1', status: 'resolved' });

    const sent = await invoke('send', {
      task_name: 'probe',
      message: 'check this',
      idempotency_key: 'message-key',
    });
    const interactions = await invoke('interactions', { cursor: 2 });
    const responded = await invoke('respond', {
      interaction_id: 'approval-1',
      kind: 'approval',
      response: { decision: 'approved', selected_option_id: 'allow' },
    });

    expect(sent.code).toBe(0);
    expect(interactions.data).toMatchObject({ items: [{ interactionId: 'approval-1' }] });
    expect(responded.data).toEqual({ interactionId: 'approval-1', status: 'resolved' });
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'probe',
      idempotencyKey: 'message-key',
    }));
    expect(service.interactions).toHaveBeenCalledWith(expect.objectContaining({ cursor: 2 }));
    expect(service.respond).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: 'approval-1',
      kind: 'approval',
      response: { decision: 'approved', selectedOptionId: 'allow' },
    }));
  });

  it('uses respond kind to disambiguate decision-shaped question answers', async () => {
    service.respond.mockResolvedValue({ interactionId: 'question-1', status: 'resolved' });

    const question = await invoke('respond', {
      interaction_id: 'question-1',
      kind: 'question',
      response: { decision: 'continue' },
    });
    const invalidApproval = await invoke('respond', {
      interaction_id: 'approval-1',
      kind: 'approval',
      response: { answers: { Continue: 'Yes' } },
    });

    expect(question.code).toBe(0);
    expect(invalidApproval.code).not.toBe(0);
    expect(service.respond).toHaveBeenCalledOnce();
    expect(service.respond).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: 'question-1',
      kind: 'question',
      response: { decision: 'continue' },
    }));
  });

  it('validates and forwards event and transcript detail modes', async () => {
    service.events.mockResolvedValue({ items: [] });
    service.transcript.mockResolvedValue({ items: [] });

    const events = await invoke('events', {
      dispatch_id: 'dispatch_replay',
      detail: 'turn',
    });
    const transcript = await invoke('transcript', {
      dispatch_id: 'dispatch_replay',
      detail: 'items',
    });
    const invalidEvents = await invoke('events', {
      dispatch_id: 'dispatch_replay',
      detail: 'tools',
    });
    const invalidTranscript = await invoke('transcript', {
      dispatch_id: 'dispatch_replay',
      detail: 'frames',
    });

    expect(events.code).toBe(0);
    expect(transcript.code).toBe(0);
    expect(invalidEvents.code).not.toBe(0);
    expect(invalidTranscript.code).not.toBe(0);
    expect(service.events).toHaveBeenCalledOnce();
    expect(service.events).toHaveBeenCalledWith(expect.objectContaining({ detail: 'turn' }));
    expect(service.transcript).toHaveBeenCalledOnce();
    expect(service.transcript).toHaveBeenCalledWith(expect.objectContaining({ detail: 'items' }));
  });

  it('logs stable diagnostics without persisting private failure text', async () => {
    service.list.mockRejectedValue(new Error(
      'Bearer SEAT_SECRET https://example.test/signed?token=URL_SECRET C:\\private\\workspace',
    ));

    const response = await invoke('list', {});

    expect(response).toMatchObject({
      code: expect.any(Number),
      msg: 'External delegation request failed.',
    });
    expect(response.code).not.toBe(0);
    const serialized = JSON.stringify({ response, calls: logger.warn.mock.calls });
    expect(serialized).not.toContain('SEAT_SECRET');
    expect(serialized).not.toContain('URL_SECRET');
    expect(serialized).not.toContain('private\\workspace');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'request-list',
        action: 'list',
        error_class: 'internal_error',
        error_code: undefined,
        failure_code: undefined,
      }),
      'external delegation request failed',
    );
  });

  it('preserves and logs the interaction.not_owned failure classification', async () => {
    service.respond.mockRejectedValue(new Error2(
      ErrorCodes.REQUEST_INVALID,
      'Interaction is not owned by this delegation.',
      { details: { failure_code: EXTERNAL_INTERACTION_NOT_OWNED_CODE } },
    ));

    const response = await invoke('respond', {
      interaction_id: 'approval-foreign',
      kind: 'approval',
      response: { decision: 'approved' },
    });

    expect(response).toMatchObject({
      code: expect.any(Number),
      details: { failure_code: EXTERNAL_INTERACTION_NOT_OWNED_CODE },
    });
    expect(response.code).not.toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'request-respond',
        action: 'respond',
        error_class: 'coded_error',
        error_code: ErrorCodes.REQUEST_INVALID,
        failure_code: EXTERNAL_INTERACTION_NOT_OWNED_CODE,
      }),
      'external delegation request failed',
    );
  });

  it('aborts a legacy wait when the caller disconnects and removes the close listener', async () => {
    let signal: AbortSignal | undefined;
    service.wait.mockImplementation(async (input) => {
      signal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
    });
    const routeReply = createRouteReply();

    const pending = invoke('wait', { dispatch_id: 'dispatch_replay', timeout_s: 45 }, routeReply);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(routeReply.listeners()).toBe(1);
    routeReply.close();
    const response = await pending;

    expect(signal?.aborted).toBe(true);
    expect(routeReply.listeners()).toBe(0);
    expect(response.code).not.toBe(0);
  });

  it('removes the legacy wait close listener without aborting a completed wait', async () => {
    let signal: AbortSignal | undefined;
    service.wait.mockImplementation(async (input) => {
      signal = input.signal;
      return {
        waitStatus: 'completed',
        waitedMs: 2,
        dispatch: { ...dispatchView, status: 'completed' },
        completedDuringWait: [{ ...dispatchView, status: 'completed' }],
        interactions: [],
      };
    });
    const routeReply = createRouteReply();

    const response = await invoke('wait', { dispatch_id: 'dispatch_replay' }, routeReply);
    routeReply.close();

    expect(response.code).toBe(0);
    expect(signal?.aborted).toBe(false);
    expect(routeReply.listeners()).toBe(0);
  });

  it('projects targeted timeout and wait-any without treating timeout as an error', async () => {
    service.wait
      .mockResolvedValueOnce({
        waitStatus: 'timed_out',
        waitedMs: 600_000,
        dispatch: { ...dispatchView, status: 'running' },
        completedDuringWait: [],
        interactions: [],
      })
      .mockResolvedValueOnce({
        waitStatus: 'completed',
        waitedMs: 2,
        dispatch: { ...dispatchView, status: 'completed' },
        completedDuringWait: [{ ...dispatchView, status: 'completed' }],
        interactions: [],
      });

    const timedOut = await invoke('wait', { dispatch_id: 'dispatch_replay', timeout_s: 600 });
    const any = await invoke('wait', { timeout_s: 1 });
    const invalid = await invoke('wait', { timeout_s: 601 });

    expect(timedOut).toMatchObject({ code: 0, data: { waitStatus: 'timed_out' } });
    expect(any).toMatchObject({
      code: 0,
      data: {
        waitStatus: 'completed',
        completedDuringWait: [{ dispatchId: 'dispatch_replay', status: 'completed' }],
      },
    });
    expect(invalid.code).not.toBe(0);
    expect(service.wait).toHaveBeenNthCalledWith(1, expect.objectContaining({
      dispatchId: 'dispatch_replay',
      timeoutMs: 600_000,
    }));
    expect(service.wait).toHaveBeenNthCalledWith(2, expect.objectContaining({
      dispatchId: undefined,
      timeoutMs: 1_000,
    }));
    expect(service.wait).toHaveBeenCalledTimes(2);
  });

  it('rejects result limits below four bytes and accepts the domain minimum', async () => {
    service.result.mockResolvedValue({ dispatch: dispatchView, text: 'done' });

    const rejected = await Promise.all([1, 2, 3].map((limit) =>
      invoke('result', { dispatch_id: 'dispatch_replay', limit }),
    ));
    const accepted = await invoke('result', { dispatch_id: 'dispatch_replay', limit: 4 });

    expect(rejected.every((response) => response.code !== 0)).toBe(true);
    expect(accepted.code).toBe(0);
    expect(service.result).toHaveBeenCalledOnce();
    expect(service.result).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }));
  });

  it('passes receipt and usage fields through status, result, and list views', async () => {
    service.status.mockResolvedValue(dispatchView);
    service.result.mockResolvedValue({ dispatch: dispatchView, text: 'done' });
    service.list.mockResolvedValue({
      version: 1,
      delegationId: 'delegation_1',
      lifecycle: 'active',
      dispatchables: [
        { kind: 'main' },
        {
          kind: 'named',
          profileName: 'explore',
          description: 'Map code without changing it.',
          whenToUse: 'Use for bounded evidence gathering.',
          modelAlias: 'grok-4.6',
          thinkingEffort: 'max',
          allowedModels: ['grok-4.6', 'glm-5.3-flash'],
          alternativeModels: [{
            alias: 'glm-5.3-flash',
            when: 'Use for wide scans.',
            thinkingEffort: 'max',
          }],
          tools: 'Read, Grep',
        },
      ],
      children: [],
      continuations: [dispatchView],
    });

    const status = await invoke('status', { dispatch_id: 'dispatch_replay' });
    const result = await invoke('result', { dispatch_id: 'dispatch_replay', limit: 100_000 });
    const list = await invoke('list', {});

    expect(status.data).toMatchObject({
      actualProfile: 'explore',
      nextStep: 'wait:dispatch_replay',
      continueHint: 'dispatch:probe',
      usage: { input: 3, output: 5, cacheRead: 2, cacheWrite: 1 },
    });
    expect(result.data).toMatchObject({ dispatch: { usage: { input: 3, output: 5 } } });
    expect(list.data).toMatchObject({
      dispatchables: [{ kind: 'main' }, {
        kind: 'named',
        profileName: 'explore',
        whenToUse: 'Use for bounded evidence gathering.',
        modelAlias: 'grok-4.6',
        thinkingEffort: 'max',
        allowedModels: ['grok-4.6', 'glm-5.3-flash'],
        alternativeModels: [{ alias: 'glm-5.3-flash', thinkingEffort: 'max' }],
        tools: 'Read, Grep',
      }],
      continuations: [{ actualProfile: 'explore', usage: { output: 5 } }],
    });
    expect(service.result).toHaveBeenCalledWith(expect.objectContaining({ limit: 100_000 }));
  });

  async function invoke(
    action: string,
    body: unknown,
    routeReply = createRouteReply(),
  ): Promise<{
    code: number;
    msg?: string;
    data?: any;
    details?: { failure_code?: string };
  }> {
    const handler = handlers.get(`/sessions/:session_id/external-delegation/${action}`);
    expect(handler).toBeDefined();
    await handler!(
      {
        id: `request-${action}`,
        params: { session_id: 'session-operator' },
        body,
        headers: { 'x-kiki-delegation-token': 'DELEGATION_SECRET' },
        log: logger,
      },
      routeReply.reply,
    );
    return routeReply.payload() as {
      code: number;
      msg?: string;
      data?: any;
      details?: { failure_code?: string };
    };
  }
});

function createRouteReply() {
  const closeListeners = new Set<() => void>();
  let sent: unknown;
  let writableFinished = false;
  return {
    reply: {
      raw: {
        get writableFinished() {
          return writableFinished;
        },
        once: (_event: 'close', listener: () => void) => {
          closeListeners.add(listener);
        },
        off: (_event: 'close', listener: () => void) => {
          closeListeners.delete(listener);
        },
      },
      send: (payload: unknown) => {
        sent = payload;
        writableFinished = true;
        return payload;
      },
    },
    close: () => {
      for (const listener of [...closeListeners]) listener();
    },
    listeners: () => closeListeners.size,
    payload: () => sent,
  };
}
