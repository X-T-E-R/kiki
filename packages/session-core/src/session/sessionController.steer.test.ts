/**
 * "Send now" (steer) echo: the message is on the timeline from the keypress to
 * its delivered frame, for the main agent and a native child alike.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { TranscriptOperation } from '@kiki/transcript';
import type { SessionViewFacade } from '@kiki/klient/session-view';

import { ApiError, type AgentTranscriptResponse, type SessionTransport } from '../transport';
import { SendNowError, SessionController } from './sessionController';
import type { SessionViewState, UserBlock } from './transcript';
import { withPendingSteers } from './transcript/steer';
import { createViewState } from './transcript';
import { opsEvent, resetEvent, userTurnSnapshot } from './__fixtures__/canonicalTranscript';

const CHILD = 'agent-research';
const STEER_TEXT = 'also check the lockfile';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function queuedReceipt(promptId: string, text = STEER_TEXT) {
  return {
    prompt_id: promptId, user_message_id: promptId, status: 'queued' as const,
    content: [{ type: 'text' as const, text }], created_at: '2026-01-01T00:00:03.000Z',
  };
}

async function open() {
  const client = {
    submitPrompt: vi.fn(),
    steerPrompt: vi.fn(async (_sid: string, promptId: string) => ({ steered: true as const, prompt_ids: [promptId] })),
    abortPrompt: vi.fn(async () => ({ aborted: true, at_seq: 1 })),
    getAgentTranscript: vi.fn(async (): Promise<AgentTranscriptResponse> => ({
      agent_id: 'main', items: [], has_more: false, tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
    })),
    getTranscriptOps: vi.fn(async () => ({
      session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', batches: [], through_seq: 0, complete: true,
    })),
  };
  const view: SessionViewFacade = {
    snapshot: async () => ({
      session: { id: 'session_test' }, as_of_seq: 0, epoch: 'epoch-1', transcript: undefined,
    }) as unknown as SessionSnapshotResponse,
    transcript: {
      page: () => client.getAgentTranscript() as unknown as ReturnType<SessionViewFacade['transcript']['page']>,
      catchUp: () => client.getTranscriptOps() as unknown as ReturnType<SessionViewFacade['transcript']['catchUp']>,
    },
    subscribe: () => ({
      updateSessionCursor: () => {}, setTranscriptGrades: () => {}, updateTranscriptCursor: () => {},
      restart: () => {}, nudge: () => {}, close: () => {},
    }),
  };
  const controller = new SessionController(client as unknown as SessionTransport, view, 'session_test', {
    // Frames flush on the next microtask, so each transcript batch is visible
    // to the read after an await, as it would be one frame later in a browser.
    scheduler: { schedule: (callback: () => void) => { queueMicrotask(callback); return 1; }, cancel: () => {} },
  });
  await controller.open();
  return { controller, client };
}

/** Deliver a transcript batch and let the controller publish it. */
async function deliver(controller: SessionController, event: Parameters<SessionController['handleTranscript']>[0]) {
  controller.handleTranscript(event);
  await new Promise<void>((resolve) => { queueMicrotask(resolve); });
}

/** The user rows the timeline actually shows (queued previews are hidden there). */
function visibleUsers(state: SessionViewState): UserBlock[] {
  return state.blocks.filter((block): block is UserBlock => block.kind === 'user' && block.promptStatus !== 'queued');
}

function steerRows(state: SessionViewState): UserBlock[] {
  return visibleUsers(state).filter((block) => block.text === STEER_TEXT);
}

function queuedOp(promptId: string): TranscriptOperation {
  return {
    op: 'prompt.upsert',
    prompt: {
      promptId, status: 'queued', userMessageId: promptId,
      content: [{ type: 'text', text: STEER_TEXT }], createdAt: '2026-01-01T00:00:03.000Z',
    },
  };
}

function steeredOp(promptId: string): TranscriptOperation {
  return {
    op: 'prompt.upsert',
    prompt: {
      promptId, status: 'completed', userMessageId: promptId,
      content: [{ type: 'text', text: STEER_TEXT }], createdAt: '2026-01-01T00:00:03.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z', steeredAt: '2026-01-01T00:00:04.000Z',
    },
  };
}

/** The next step boundary delivers the steer as a turn-owned user frame (same id). */
function deliveredOps(promptId: string): TranscriptOperation[] {
  return [
    {
      op: 'step.upsert', turnId: 't1',
      step: { kind: 'step', stepId: 't1.2', turnId: 't1', ordinal: 2, state: 'running', startedAt: '2026-01-01T00:00:05.000Z' },
    },
    {
      op: 'frame.upsert', turnId: 't1', stepId: 't1.2',
      frame: {
        kind: 'text', frameId: promptId, role: 'user', text: STEER_TEXT, origin: { kind: 'user' },
        part: { partId: promptId, messageId: promptId, revision: 0, provenance: { source: 'engine' } },
      },
    },
  ];
}

describe('send now (steer) — main agent', () => {
  it('promotes a queued prompt on the same row through sending → waiting → delivery', async () => {
    const { controller, client } = await open();
    const promptId = 'queued-send-now';
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    await deliver(controller, opsEvent('main', [queuedOp(promptId)], 2));
    expect(steerRows(controller.getState())).toEqual([]);
    expect(controller.getState().queuedPromptIds).toContain(promptId);
    const steer = deferred<{ steered: true; prompt_ids: string[] }>();
    client.steerPrompt.mockReturnValue(steer.promise);
    const sent = controller.steerQueued(promptId);
    expect(steerRows(controller.getState())).toEqual([
      expect.objectContaining({ id: `user-${promptId}`, steerStatus: 'sending' }),
    ]);
    expect(controller.getState().queuedPromptIds).not.toContain(promptId);
    await deliver(controller, opsEvent('main', [steeredOp(promptId)], 3));
    expect(steerRows(controller.getState())).toHaveLength(1);
    steer.resolve({ steered: true, prompt_ids: [promptId] });
    await sent;
    expect(steerRows(controller.getState())[0]).toMatchObject({ id: `user-${promptId}`, steerStatus: 'waiting' });
    await deliver(controller, opsEvent('main', deliveredOps(promptId), 4));
    expect(steerRows(controller.getState())).toEqual([
      expect.objectContaining({ id: `user-${promptId}`, turnId: 't1' }),
    ]);
    expect(steerRows(controller.getState())[0]!.steerStatus).toBeUndefined();
    expect(controller.getPendingSteers()).toEqual([]);
    expect(client.submitPrompt).not.toHaveBeenCalled();
    controller.close();
  });

  it.each([new ApiError({ code: 40001, msg: 'needs its own turn', data: null }), new Error('network down')])(
    'restores the queued preview if promoting it fails: %s', async (error) => {
      const { controller, client } = await open();
      const promptId = 'queued-send-now';
      await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
      await deliver(controller, opsEvent('main', [queuedOp(promptId)], 2));
      client.steerPrompt.mockRejectedValue(error);
      await expect(controller.steerQueued(promptId)).rejects.toBe(error);
      expect(controller.getPendingSteers()).toEqual([]);
      expect(steerRows(controller.getState())).toEqual([]);
      expect(controller.getState().queuedPromptIds).toContain(promptId);
      expect(client.abortPrompt).not.toHaveBeenCalled();
      controller.close();
    },
  );

  it('shows the message on the very first publish, before the submit answers', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockReturnValue(new Promise(() => {}));
    void controller.sendPromptNow({ text: STEER_TEXT });
    const rows = steerRows(controller.getState());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ steerStatus: 'sending' });
    expect(client.submitPrompt).toHaveBeenCalledWith('session_test', expect.objectContaining({
      prompt_id: rows[0]!.promptId,
    }));
    controller.close();
  });

  it('keeps exactly one row, on one id, through queued → steered → delivered (no gap)', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    const steer = deferred<{ steered: true; prompt_ids: string[] }>();
    let promptId = '';
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => {
      promptId = body.prompt_id;
      // The transcript reports the parked prompt before the REST answer lands.
      await deliver(controller, opsEvent('main', [queuedOp(promptId)], 2));
      return queuedReceipt(promptId);
    });
    client.steerPrompt.mockReturnValue(steer.promise);
    const sent = controller.sendPromptNow({ text: STEER_TEXT });
    const ids = new Set<string>();
    const sample = () => {
      const rows = steerRows(controller.getState());
      expect(rows).toHaveLength(1);
      ids.add(rows[0]!.id);
      return rows[0]!;
    };
    sample();
    await vi.waitFor(() => expect(client.steerPrompt).toHaveBeenCalled());
    expect(sample()).toMatchObject({ steerStatus: 'sending' });
    // The queue strip never offers a prompt that is already on its way in.
    expect(controller.getState().queuedPromptIds).not.toContain(promptId);
    await deliver(controller, opsEvent('main', [steeredOp(promptId)], 3));
    sample();
    steer.resolve({ steered: true, prompt_ids: [promptId] });
    await expect(sent).resolves.toEqual({ promptId, outcome: 'steered' });
    expect(sample()).toMatchObject({ steerStatus: 'waiting' });
    await deliver(controller, opsEvent('main', deliveredOps(promptId), 4));
    const delivered = sample();
    expect(delivered.steerStatus).toBeUndefined();
    expect(delivered.turnId).toBe('t1');
    expect(ids).toEqual(new Set([`user-${promptId}`]));
    expect(controller.getPendingSteers()).toEqual([]);
    controller.close();
  });

  it('sends the steer to the main queue without an agent scope', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    const { promptId } = await controller.sendPromptNow({ text: STEER_TEXT });
    expect(client.submitPrompt.mock.calls[0]![1]).not.toHaveProperty('agent_id');
    expect(client.steerPrompt).toHaveBeenCalledWith('session_test', promptId, 'main');
    controller.close();
  });

  it('retires the echo as an ordinary send when the agent was already idle', async () => {
    const { controller, client } = await open();
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => ({
      ...queuedReceipt(body.prompt_id), status: 'running' as const,
    }));
    await expect(controller.sendPromptNow({ text: STEER_TEXT })).resolves.toMatchObject({ outcome: 'started' });
    expect(client.steerPrompt).not.toHaveBeenCalled();
    expect(controller.getPendingSteers()).toEqual([]);
    controller.close();
  });

  it('withdraws nothing and removes the echo when the submit itself fails', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockRejectedValue(new Error('network down'));
    const error = await controller.sendPromptNow({ text: STEER_TEXT }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SendNowError);
    expect((error as SendNowError).reason).toBe('submit');
    expect(client.abortPrompt).not.toHaveBeenCalled();
    expect(steerRows(controller.getState())).toEqual([]);
    controller.close();
  });

  it('withdraws the parked prompt when the steer is refused, so it cannot run later unseen', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    client.steerPrompt.mockRejectedValue(new ApiError({ code: 40001, msg: 'needs its own turn', data: null }));
    const error = await controller.sendPromptNow({ text: STEER_TEXT }).catch((caught: unknown) => caught);
    expect((error as SendNowError).reason).toBe('refused');
    const promptId = client.submitPrompt.mock.calls[0]![1].prompt_id as string;
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', promptId, 'main');
    expect(steerRows(controller.getState())).toEqual([]);
    controller.close();
  });

  it('keeps the prompt queued (not withdrawn) when the turn ended during the steer', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    client.steerPrompt.mockRejectedValue(new ApiError({ code: 40402, msg: 'no active turn', data: null }));
    await expect(controller.sendPromptNow({ text: STEER_TEXT })).resolves.toMatchObject({ outcome: 'queued' });
    expect(client.abortPrompt).not.toHaveBeenCalled();
    expect(controller.getPendingSteers()).toEqual([]);
    controller.close();
  });

  it('never withdraws a prompt whose steer outcome is unknown', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    client.steerPrompt.mockRejectedValue(new Error('socket hang up'));
    const error = await controller.sendPromptNow({ text: STEER_TEXT }).catch((caught: unknown) => caught);
    expect((error as SendNowError).reason).toBe('unknown');
    expect(client.abortPrompt).not.toHaveBeenCalled();
    controller.close();
  });
});

describe('send now (steer) — subagent', () => {
  it('uses the same path, scoped to the child agent, and echoes only in its view', async () => {
    const { controller, client } = await open();
    const unsubscribe = controller.subscribeAgent(CHILD, () => {});
    await deliver(controller, resetEvent(CHILD, userTurnSnapshot({ streaming: true }), 1));
    let promptId = '';
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => {
      promptId = body.prompt_id;
      return queuedReceipt(promptId);
    });
    const sent = controller.sendPromptNow({ agentId: CHILD, text: STEER_TEXT });
    expect(steerRows(controller.getAgentState(CHILD))).toHaveLength(1);
    expect(steerRows(controller.getState())).toEqual([]);
    await sent;
    expect(client.submitPrompt.mock.calls[0]![1]).toMatchObject({ agent_id: CHILD, prompt_id: promptId });
    expect(client.steerPrompt).toHaveBeenCalledWith('session_test', promptId, CHILD);
    expect(steerRows(controller.getAgentState(CHILD))[0]).toMatchObject({ steerStatus: 'waiting' });
    await deliver(controller, opsEvent(CHILD, deliveredOps(promptId), 2));
    const rows = steerRows(controller.getAgentState(CHILD));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `user-${promptId}`, turnId: 't1' });
    expect(rows[0]!.steerStatus).toBeUndefined();
    expect(controller.getPendingSteers(CHILD)).toEqual([]);
    unsubscribe();
    controller.close();
  });
});

describe('withPendingSteers', () => {
  it('returns the same state object when nothing is pending', () => {
    const state = createViewState('s');
    expect(withPendingSteers(state, [])).toBe(state);
  });

  it('does not duplicate a steer whose delivered frame is already projected', () => {
    const state: SessionViewState = {
      ...createViewState('s'),
      blocks: [{ kind: 'user', id: 'user-p1', text: STEER_TEXT, createdAt: '2026-01-01T00:00:05.000Z', userMessageId: 'p1', turnId: 't1' }],
    };
    const next = withPendingSteers(state, [{ promptId: 'p1', text: STEER_TEXT, createdAt: '2026-01-01T00:00:03.000Z', phase: 'waiting' }]);
    expect(next).toBe(state);
  });

  it('replaces the hidden queued preview and drops it from the queue strip', () => {
    const state: SessionViewState = {
      ...createViewState('s'),
      queuedPromptIds: ['p1', 'p2'],
      blocks: [{ kind: 'user', id: 'user-p1', text: STEER_TEXT, createdAt: '2026-01-01T00:00:03.000Z', promptId: 'p1', userMessageId: 'p1', promptStatus: 'queued' }],
    };
    const next = withPendingSteers(state, [{ promptId: 'p1', text: STEER_TEXT, createdAt: '2026-01-01T00:00:03.000Z', phase: 'sending' }]);
    expect(next.queuedPromptIds).toEqual(['p2']);
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toMatchObject({ id: 'user-p1', steerStatus: 'sending' });
    expect(next.blocks[0]).not.toHaveProperty('promptStatus');
  });
});
