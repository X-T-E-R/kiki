/**
 * "Send now" (steer) echo: the message is on the timeline from the keypress to
 * its delivered frame, for the main agent and a native child alike.
 */
import { describe, expect, it, vi } from 'vitest';

import type { PromptSteerResult, SessionSnapshotResponse } from '@kiki/protocol';
import type { TranscriptOperation } from '@kiki/transcript';
import type { SessionViewFacade } from '@kiki/klient/session-view';

import { ApiError, type AgentTranscriptResponse, type SessionTransport } from '../transport';
import { SendNowError, SessionController } from './sessionController';
import type { SessionViewState, UserBlock } from './transcript';
import { withPendingSteers } from './transcript/steer';
import { createViewState } from './transcript';
import { emptySnapshot, opsEvent, resetEvent, userTurnSnapshot } from './__fixtures__/canonicalTranscript';

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
    steerPrompt: vi.fn(async (_sid: string, promptId: string): Promise<PromptSteerResult> => ({ steered: true, prompt_ids: [promptId] })),
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

function steeredOp(promptId: string, text = STEER_TEXT): TranscriptOperation {
  return {
    op: 'prompt.upsert',
    prompt: {
      promptId, status: 'completed', userMessageId: promptId,
      content: [{ type: 'text', text }], createdAt: '2026-01-01T00:00:03.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z', steeredAt: '2026-01-01T00:00:04.000Z',
    },
  };
}

/** The next step boundary delivers the steer as a turn-owned user frame (same id). */
function deliveredOps(promptId: string, text = STEER_TEXT): TranscriptOperation[] {
  return [
    {
      op: 'step.upsert', turnId: 't1',
      step: { kind: 'step', stepId: 't1.2', turnId: 't1', ordinal: 2, state: 'running', startedAt: '2026-01-01T00:00:05.000Z' },
    },
    {
      op: 'frame.upsert', turnId: 't1', stepId: 't1.2',
      frame: {
        kind: 'text', frameId: promptId, role: 'user', text, origin: { kind: 'user' },
        part: { partId: promptId, messageId: promptId, revision: 0, provenance: { source: 'engine' } },
      },
    },
  ];
}

describe('queued submission receipt ordering', () => {
  it.each(['running', 'completed', 'aborted', 'failed', 'blocked'] as const)('does not restore a queued strip after canonical %s outruns its receipt', async (status) => {
    const { controller, client } = await open();
    try {
      await deliver(controller, resetEvent('main', emptySnapshot(), 1));
      const receipt = deferred<ReturnType<typeof queuedReceipt>>();
      client.submitPrompt.mockReturnValue(receipt.promise);
      const sent = controller.sendPrompt({ text: STEER_TEXT, promptId: 'queued-original' });
      await deliver(controller, opsEvent('main', [queuedOp('queued-original')], 2));
      expect(controller.getState().queuedPromptIds).toEqual(['queued-original']);
      await deliver(controller, opsEvent('main', [{
        op: 'prompt.upsert', prompt: {
          promptId: 'queued-original', userMessageId: 'queued-original', status,
          content: [{ type: 'text', text: STEER_TEXT }], createdAt: '2026-01-01T00:00:03.000Z',
        },
      }], 3));
      expect(controller.getState().queuedPromptIds).toEqual([]);
      receipt.resolve(queuedReceipt('queued-original'));
      await sent;
      expect(controller.getState().queuedPromptIds).toEqual([]);
      expect(client.submitPrompt).toHaveBeenCalledTimes(1);
      expect(client.steerPrompt).not.toHaveBeenCalled();
    } finally { controller.close(); }
  });

  it('keeps older queue items through immediate send, drains once, and reopens without the consumed row', async () => {
    const { controller, client } = await open();
    const reopened = await open();
    try {
      const original = queuedOp('original');
      const later = queuedOp('later');
      await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
      await deliver(controller, opsEvent('main', [original, later], 2));
      const submit = deferred<ReturnType<typeof queuedReceipt>>();
      client.submitPrompt.mockReturnValue(submit.promise);
      const sending = controller.sendPromptNow({ text: 'new immediate input', promptId: 'new-now' });
      expect(controller.getState().queuedPromptIds).toEqual(['original', 'later']);
      await deliver(controller, opsEvent('main', [steeredOp('original'), ...deliveredOps('original')], 3));
      expect(controller.getState().queuedPromptIds).toEqual(['later']);
      submit.resolve(queuedReceipt('new-now', 'new immediate input'));
      await sending;
      expect(client.steerPrompt).toHaveBeenCalledExactlyOnceWith('session_test', 'new-now', 'main');
      await deliver(controller, opsEvent('main', [steeredOp('new-now', 'new immediate input'), ...deliveredOps('new-now', 'new immediate input')], 4));
      expect(controller.getState().queuedPromptIds).toEqual(['later']);
      expect(controller.getState().blocks.filter(block => block.kind === 'user' && block.userMessageId === 'original')).toHaveLength(1);
      expect(controller.getState().blocks.find(block => block.kind === 'user' && block.userMessageId === 'new-now')).toMatchObject({ text: 'new immediate input' });
      const reload = { ...userTurnSnapshot({ streaming: true }), prompts: [
        ...(later.op === 'prompt.upsert' ? [later.prompt] : []),
        ...[steeredOp('original'), steeredOp('new-now', 'new immediate input')].flatMap(op => op.op === 'prompt.upsert' ? [op.prompt] : []),
      ] };
      await deliver(reopened.controller, resetEvent('main', reload, 1));
      expect(reopened.controller.getState().queuedPromptIds).toEqual(['later']);
      expect(reopened.client.submitPrompt).not.toHaveBeenCalled();
      expect(client.submitPrompt).toHaveBeenCalledTimes(1);
      expect(client.abortPrompt).not.toHaveBeenCalled();
    } finally { controller.close(); reopened.controller.close(); }
  });

  it('keeps a canonical queued edit, attachment, timing and position when the original receipt arrives late', async () => {
    const { controller, client } = await open();
    try {
      await deliver(controller, resetEvent('main', emptySnapshot(), 1));
      const receipt = deferred<ReturnType<typeof queuedReceipt>>();
      client.submitPrompt.mockReturnValue(receipt.promise);
      const sent = controller.sendPrompt({ text: STEER_TEXT, promptId: 'queued-edited' });
      const content = [{ type: 'text' as const, text: 'edited while the reply was in flight' },
        { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/retained.png' } }];
      await deliver(controller, opsEvent('main', [{
        op: 'prompt.upsert', prompt: {
          promptId: 'queued-edited', userMessageId: 'logical-edited', status: 'queued', content,
          createdAt: '2026-01-01T00:00:03.000Z', appendTiming: 'tasks_done', revision: 2, queuePosition: 3,
        },
      }], 2));
      const before = controller.getState();
      receipt.resolve(queuedReceipt('queued-edited'));
      await sent;
      expect(controller.getState().queuedPromptIds).toEqual(['queued-edited']);
      expect(controller.getState().queuedPromptMeta).toEqual(before.queuedPromptMeta);
      expect(controller.getState().blocks).toEqual(before.blocks);
    } finally { controller.close(); }
  });
});

describe('submission preservation degradation', () => {
  it.each(['QuotaExceededError', 'SecurityError'])('still submits complete media when backup fails with %s and accepts an ack despite failed cleanup', async (name) => {
    const { controller, client } = await open();
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new DOMException('unavailable', name); }),
      removeItem: vi.fn(() => { throw new DOMException('unavailable', name); }),
    };
    vi.stubGlobal('localStorage', storage);
    try {
      const content = [{ type: 'text' as const, text: 'keep this image' },
        { type: 'image' as const, source: { kind: 'base64' as const, media_type: 'image/png', data: 'AAAA' } }];
      const receipt = deferred<Omit<ReturnType<typeof queuedReceipt>, 'content'> & { content: typeof content }>();
      client.submitPrompt.mockReturnValue(receipt.promise);
      const onPreservation = vi.fn();
      const onAcknowledged = vi.fn();
      const sent = controller.sendPrompt({ text: 'keep this image', content, promptId: 'media-degraded', onPreservation, onAcknowledged });
      expect(onPreservation).toHaveBeenCalledWith(false);
      expect(client.submitPrompt).toHaveBeenCalledExactlyOnceWith('session_test', expect.objectContaining({ content, prompt_id: 'media-degraded' }));
      expect(onAcknowledged).not.toHaveBeenCalled();
      receipt.resolve({ ...queuedReceipt('media-degraded'), content });
      await expect(sent).resolves.toMatchObject({ prompt_id: 'media-degraded', status: 'queued' });
      expect(onAcknowledged).toHaveBeenCalledTimes(1);
      expect(controller.getState().blocks.find(block => block.kind === 'user' && block.promptId === 'media-degraded')).toMatchObject({ queuedContent: content, text: 'keep this image', media: [{ kind: 'image', url: 'data:image/png;base64,AAAA', mime: 'image/png' }] });
    } finally { controller.close(); vi.unstubAllGlobals(); }
  });
});

describe('send now (steer) — main agent', () => {
  it.each(['running', 'completed', 'steered'] as const)('prefers canonical %s over a late durable queued disposition without a second steer', async (status) => {
    const { controller, client } = await open();
    controller.setEphemeralHint(false);
    const receipt = deferred<ReturnType<typeof queuedReceipt> & { admission: 'admitted'; delivery_state: 'queued'; delivery_reason: 'target_changed' }>();
    client.submitPrompt.mockReturnValue(receipt.promise);
    try {
      await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
      const sending = controller.sendPromptNow({ promptId: 'late-disposition', text: STEER_TEXT });
      await deliver(controller, opsEvent('main', [status === 'steered' ? steeredOp('late-disposition') : {
        op: 'prompt.upsert', prompt: { promptId: 'late-disposition', userMessageId: 'late-disposition', status,
          content: [{ type: 'text', text: STEER_TEXT }], createdAt: '2026-01-01T00:00:03.000Z' },
      }, ...(status === 'steered' ? [] : deliveredOps('late-disposition'))], 2));
      receipt.resolve({ ...queuedReceipt('late-disposition'), admission: 'admitted', delivery_state: 'queued', delivery_reason: 'target_changed' });
      await expect(sending).resolves.toEqual({ promptId: 'late-disposition', outcome: status === 'steered' ? 'steered' : 'started' });
      expect(controller.getState().queuedPromptIds).toEqual([]);
      if (status === 'steered') {
        expect(steerRows(controller.getState())).toHaveLength(1);
        expect(controller.getPendingSteers()).toEqual([expect.objectContaining({ promptId: 'late-disposition', phase: 'waiting' })]);
        await deliver(controller, opsEvent('main', deliveredOps('late-disposition'), 3));
      }
      expect(controller.getPendingSteers()).toEqual([]);
      expect(controller.getState().blocks.filter(block => block.kind === 'user' && block.userMessageId === 'late-disposition')).toHaveLength(1);
      expect(client.steerPrompt).not.toHaveBeenCalled();
      expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    } finally { controller.close(); }
  });

  it('returns the actual legacy executor deferral rather than claiming a steer', async () => {
    const { controller, client } = await open();
    client.submitPrompt.mockResolvedValue(queuedReceipt('external-deferred'));
    client.steerPrompt.mockImplementation(async () => ({ steered: true as const, prompt_ids: ['external-deferred'],
      delivery_state: 'queued' as const, delivery_reason: 'executor_deferred' as const }));
    try {
      await expect(controller.sendPromptNow({ promptId: 'external-deferred', text: STEER_TEXT })).resolves.toEqual({
        promptId: 'external-deferred', outcome: 'queued', reason: 'executor_deferred',
      });
      expect(controller.getPendingSteers()).toEqual([]);
      expect(client.submitPrompt).toHaveBeenCalledTimes(1);
      expect(client.abortPrompt).not.toHaveBeenCalled();
    } finally { controller.close(); }
  });

  it.each(['restoring', 'held', 'admitted'] as const)('persists the steer intent for a saved session and never duplicates server delivery after %s', async (admission) => {
    const { controller, client } = await open();
    controller.setEphemeralHint(false);
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => ({
      ...queuedReceipt(body.prompt_id), admission, delivery_state: admission === 'admitted' ? 'steered' : undefined,
    }));
    const sent = await controller.sendPromptNow({ promptId: 'saved-now', text: STEER_TEXT });
    expect(sent).toEqual({ promptId: 'saved-now', outcome: admission === 'admitted' ? 'steered' : admission });
    expect(client.submitPrompt).toHaveBeenCalledWith('session_test', expect.objectContaining({ admission: 'durable', delivery_mode: 'steer', prompt_id: 'saved-now' }));
    expect(client.steerPrompt).not.toHaveBeenCalled();
    expect(controller.getPendingSteers()).toEqual([expect.objectContaining({ promptId: 'saved-now', phase: 'waiting' })]);
    controller.close();
  });

  it.each(['queued', 'steered'] as const)('hands a late durable %s receipt to the queue or canonical frame without claiming consumption', async (delivery) => {
    const { controller, client } = await open();
    controller.setEphemeralHint(false);
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockResolvedValue({ ...queuedReceipt('late-now'), admission: 'restoring' });
    const read = vi.fn(async () => ({ ...queuedReceipt('late-now'), admission: 'admitted', delivery_state: delivery,
      delivery_reason: delivery === 'queued' ? 'target_changed' : undefined }));
    Object.assign(client, { getDurableIngress: read });
    await controller.sendPromptNow({ promptId: 'late-now', text: STEER_TEXT });
    await deliver(controller, opsEvent('main', [queuedOp('late-now')], 2));
    expect(controller.getState().queuedPromptIds).not.toContain('late-now');
    await vi.waitFor(() => { expect(controller.getDurableIngress()[0]?.admission).toBe('admitted'); });
    expect(controller.getDurableIngress()[0]?.delivery_reason).toBe(delivery === 'queued' ? 'target_changed' : undefined);
    if (delivery === 'queued') {
      expect(controller.getPendingSteers()).toEqual([]);
      expect(controller.getState().queuedPromptIds).toContain('late-now');
      expect(steerRows(controller.getState())).toEqual([]);
    } else {
      expect(controller.getPendingSteers()).toEqual([expect.objectContaining({ promptId: 'late-now', phase: 'waiting' })]);
      expect(steerRows(controller.getState())).toEqual([expect.objectContaining({ promptId: 'late-now', steerStatus: 'waiting' })]);
      await deliver(controller, opsEvent('main', [steeredOp('late-now'), ...deliveredOps('late-now')], 3));
      expect(controller.getPendingSteers()).toEqual([]);
      expect(steerRows(controller.getState())).toEqual([expect.objectContaining({ userMessageId: 'late-now', turnId: 't1' })]);
    }
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    expect(client.steerPrompt).not.toHaveBeenCalled();
    expect(client.abortPrompt).not.toHaveBeenCalled();
    controller.close();
  });

  it('pauses receipt observation while suspended, stops at held, and never resumes or cancels the request', async () => {
    vi.useFakeTimers();
    const { controller, client } = await open();
    try {
      controller.setEphemeralHint(false);
      client.submitPrompt.mockResolvedValue({ ...queuedReceipt('held-now'), admission: 'restoring' });
      const read = vi.fn(async () => ({ ...queuedReceipt('held-now'), admission: 'held' }));
      Object.assign(client, { getDurableIngress: read });
      await controller.sendPromptNow({ promptId: 'held-now', text: STEER_TEXT });
      controller.suspend();
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).not.toHaveBeenCalled();
      await controller.resume();
      await vi.advanceTimersByTimeAsync(500);
      expect(read).toHaveBeenCalledExactlyOnceWith('session_test', 'held-now', 'main');
      expect(controller.getDurableIngress()[0]?.admission).toBe('held');
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(controller.getPendingSteers()).toEqual([expect.objectContaining({ promptId: 'held-now' })]);
      expect(client.submitPrompt).toHaveBeenCalledTimes(1);
      expect(client.steerPrompt).not.toHaveBeenCalled();
      expect(client.abortPrompt).not.toHaveBeenCalled();
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('stops pending receipt reads on close without cancelling server-owned delivery', async () => {
    vi.useFakeTimers();
    const { controller, client } = await open();
    try {
      controller.setEphemeralHint(false);
      client.submitPrompt.mockResolvedValue({ ...queuedReceipt('closed-now'), admission: 'restoring' });
      const read = vi.fn();
      Object.assign(client, { getDurableIngress: read });
      await controller.sendPromptNow({ promptId: 'closed-now', text: STEER_TEXT });
      controller.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).not.toHaveBeenCalled();
      expect(client.submitPrompt).toHaveBeenCalledTimes(1);
      expect(client.abortPrompt).not.toHaveBeenCalled();
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('serializes receipt reads across now IDs and ignores an in-flight result from before suspension', async () => {
    vi.useFakeTimers();
    const { controller, client } = await open();
    try {
      controller.setEphemeralHint(false);
      client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => ({ ...queuedReceipt(body.prompt_id), admission: 'restoring' }));
      const first = deferred<ReturnType<typeof queuedReceipt> & { admission: string }>();
      const read = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ ...queuedReceipt('serial-b'), admission: 'admitted', delivery_state: 'queued' });
      Object.assign(client, { getDurableIngress: read });
      await controller.sendPromptNow({ promptId: 'serial-a', text: STEER_TEXT });
      await controller.sendPromptNow({ promptId: 'serial-b', text: STEER_TEXT });
      await vi.advanceTimersByTimeAsync(2000);
      expect(read).toHaveBeenCalledExactlyOnceWith('session_test', 'serial-a', 'main');
      controller.suspend();
      await controller.resume();
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(1);
      first.resolve({ ...queuedReceipt('serial-a'), admission: 'held' });
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.getDurableIngress().find(item => item.prompt_id === 'serial-a')?.admission).toBe('restoring');
      await vi.advanceTimersByTimeAsync(500);
      expect(read).toHaveBeenNthCalledWith(2, 'session_test', 'serial-b', 'main');
      expect(controller.getPendingSteers().map(item => item.promptId)).toEqual(['serial-a']);
      expect(client.submitPrompt).toHaveBeenCalledTimes(2);
      expect(client.steerPrompt).not.toHaveBeenCalled();
      expect(client.abortPrompt).not.toHaveBeenCalled();
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('keeps ordinary durable submission free of immediate delivery intent', async () => {
    const { controller, client } = await open();
    controller.setEphemeralHint(false);
    client.submitPrompt.mockResolvedValue({ ...queuedReceipt('ordinary'), admission: 'restoring' });
    await controller.sendPrompt({ promptId: 'ordinary', text: STEER_TEXT });
    expect(client.submitPrompt.mock.calls[0]![1].delivery_mode).toBeUndefined();
    expect(client.steerPrompt).not.toHaveBeenCalled();
    controller.close();
  });

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

  it.each([false, true])('confirms every consecutive send at one response boundary with merged=%s, preserving media and reload order', async (merged) => {
    const { controller } = await open();
    const ids = ['send-a', 'send-b', 'send-c'];
    const image = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/photo.png' } };
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    await deliver(controller, opsEvent('main', ids.map((id, index) => {
      const op = queuedOp(id);
      return op.op === 'prompt.upsert' ? { ...op, prompt: { ...op.prompt,
        content: [{ type: 'text', text: `message ${index}` }, ...(index === 1 ? [image] : [])] } } : op;
    }), 2));
    await Promise.all(ids.map((id) => controller.steerQueued(id)));
    expect(controller.getPendingSteers()).toHaveLength(3);
    const receipts = ids.map((id, index): TranscriptOperation => {
      const op = steeredOp(id);
      return op.op === 'prompt.upsert' ? { ...op, prompt: { ...op.prompt,
        content: [{ type: 'text', text: `message ${index}` }, ...(index === 1 ? [image] : [])] } } : op;
    });
    await deliver(controller, opsEvent('main', receipts, 3));
    const ops: TranscriptOperation[] = [{ ...deliveredOps(ids[0]!)[0]! }, {
      op: 'attachment.upsert', attachment: { attachmentId: 'image-b', mediaType: 'image/png',
        source: { kind: 'url', url: 'https://example.test/photo.png' }, owner: { kind: 'frame', turnId: 't1', stepId: 't1.2', frameId: ids[1]! } },
    }, ...(merged ? ids.slice(0, 1) : ids).map((id, index): TranscriptOperation => ({ op: 'frame.upsert', turnId: 't1', stepId: 't1.2', frame: {
      kind: 'text', frameId: id, role: 'user', text: merged ? 'message 0message 1message 2' : `message ${index}`, origin: { kind: 'user' },
      part: { partId: id, messageId: id, revision: 0, provenance: { source: 'engine' } },
      attachmentIds: index === 1 ? ['image-b'] : undefined,
    } }))];
    await deliver(controller, opsEvent('main', ops, 4));
    const rows = visibleUsers(controller.getState()).filter((row) => ids.includes(row.userMessageId ?? ''));
    expect(rows.map((row) => [row.userMessageId, row.text, row.steerStatus, row.turnId]))
      .toEqual(ids.map((id, index) => [id, `message ${index}`, undefined, 't1']));
    expect(rows[1]?.media).toMatchObject([{ kind: 'image', url: 'https://example.test/photo.png' }]);
    expect(controller.getPendingSteers()).toEqual([]);
    expect(controller.getState().queuedPromptIds).toEqual([]);
    const snapshot = userTurnSnapshot({ streaming: true });
    const currentTurn = snapshot.items.find((item) => item.kind === 'turn')!;
    expect(currentTurn.kind).toBe('turn');
    if (currentTurn.kind === 'turn') {
      const reload = { ...snapshot, prompts: receipts.flatMap((op) => op.op === 'prompt.upsert' ? [op.prompt] : []), items: [{ ...currentTurn, steps: [...currentTurn.steps,
        { kind: 'step' as const, stepId: 't1.2', turnId: 't1', ordinal: 2, state: 'running' as const,
          frames: ops.flatMap((op) => op.op === 'frame.upsert' ? [op.frame] : []) }] }],
        attachments: ops.flatMap((op) => op.op === 'attachment.upsert' ? [op.attachment] : []) };
      await deliver(controller, resetEvent('main', reload, 5));
      expect(visibleUsers(controller.getState()).filter((row) => ids.includes(row.userMessageId ?? '')).map((row) => row.userMessageId)).toEqual(ids);
    }
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

  it('reports a model boundary as queued rather than claiming immediate insertion', async () => {
    const { controller, client } = await open();
    const promptId = 'queued-model-change';
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    await deliver(controller, opsEvent('main', [queuedOp(promptId)], 2));
    client.steerPrompt.mockResolvedValueOnce({ steered: false, prompt_ids: [promptId], delivery_state: 'queued', delivery_reason: 'model_switch_boundary' });
    await expect(controller.steerQueued(promptId)).resolves.toEqual({ outcome: 'queued', reason: 'model_switch_boundary' });
    expect(controller.getState().queuedPromptIds).toContain(promptId);
    expect(controller.getPendingSteers()).toEqual([]);
    controller.close();
  });

  it('reconciles an obsolete queue entry instead of surfacing the old 40402 error', async () => {
    const { controller, client } = await open();
    const promptId = 'stale-send-now';
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    await deliver(controller, opsEvent('main', [queuedOp(promptId)], 2));
    client.steerPrompt.mockRejectedValueOnce(new ApiError({ code: 40402, msg: 'one or more prompts are not pending', data: null }));
    await expect(controller.steerQueued(promptId)).resolves.toEqual({ outcome: 'not_pending', reason: 'prompt_no_longer_pending' });
    expect(controller.getPendingSteers()).toEqual([]);
    expect(client.abortPrompt).not.toHaveBeenCalled();
    controller.close();
  });

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

  it('captures profile and execution controls with the send-now message identity', async () => {
    const { controller, client } = await open();
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => ({
      ...queuedReceipt(body.prompt_id), status: 'running' as const,
    }));
    const execution = { executor: 'external-example', profile: 'selected-runtime' };
    await expect(controller.sendPromptNow({ text: STEER_TEXT, promptId: 'selected-message',
      profile: 'selected-profile', execution, model: 'selected-model', thinking: 'high',
      permissionMode: 'manual', planMode: true, planGate: 'gated' }))
      .resolves.toEqual({ promptId: 'selected-message', outcome: 'started' });
    expect(client.submitPrompt).toHaveBeenCalledExactlyOnceWith('session_test', {
      content: [{ type: 'text', text: STEER_TEXT }], prompt_id: 'selected-message',
      profile: 'selected-profile', execution, model: 'selected-model', thinking: 'high',
      permission_mode: 'manual', plan_mode: true, plan_gate: 'gated',
    });
    expect(client.steerPrompt).not.toHaveBeenCalled();
    expect(client.abortPrompt).not.toHaveBeenCalled();
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

  it.each(['abort', 'network', 'timeout', 'invalid_response'])('preserves the same send-now identity after an unconfirmed %s transport failure without replay', async (reason) => {
    const { controller, client } = await open();
    controller.setEphemeralHint(false);
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    const failure = new ApiError({ code: -1, msg: 'Result unavailable', data: null, source: 'transport', reason });
    client.submitPrompt.mockRejectedValue(failure);
    const onAcknowledged = vi.fn();
    const error = await controller.sendPromptNow({ promptId: 'uncertain-now', text: STEER_TEXT, onAcknowledged }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SendNowError);
    expect((error as SendNowError).reason).toBe('unknown');
    expect((error as SendNowError).cause).toBe(failure);
    expect(controller.getPendingSteers()).toEqual([expect.objectContaining({ promptId: 'uncertain-now', text: STEER_TEXT, phase: 'waiting' })]);
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    expect(client.steerPrompt).not.toHaveBeenCalled();
    expect(client.abortPrompt).not.toHaveBeenCalled();
    await deliver(controller, opsEvent('main', [steeredOp('uncertain-now'), ...deliveredOps('uncertain-now')], 2));
    expect(controller.getPendingSteers()).toEqual([]);
    expect(steerRows(controller.getState())).toEqual([expect.objectContaining({ userMessageId: 'uncertain-now', turnId: 't1' })]);
    controller.close();
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    expect(client.abortPrompt).not.toHaveBeenCalled();
  });

  it('removes the echo after a confirmed server rejection without cancelling or resubmitting', async () => {
    const { controller, client } = await open();
    controller.setEphemeralHint(false);
    client.submitPrompt.mockRejectedValue(new ApiError({ code: 40001, msg: 'Invalid request', data: null }));
    const error = await controller.sendPromptNow({ promptId: 'rejected-now', text: STEER_TEXT }).catch((caught: unknown) => caught);
    expect((error as SendNowError).reason).toBe('submit');
    expect(controller.getPendingSteers()).toEqual([]);
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    expect(client.abortPrompt).not.toHaveBeenCalled();
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
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', promptId, 'main', true);
    expect(steerRows(controller.getState())).toEqual([]);
    controller.close();
  });

  it('classifies a refused steer as unknown when withdrawing the queued prompt fails', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => {
      await deliver(controller, opsEvent('main', [queuedOp(body.prompt_id)], 2));
      return queuedReceipt(body.prompt_id);
    });
    client.steerPrompt.mockRejectedValue(new ApiError({ code: 40001, msg: 'needs its own turn', data: null }));
    const abortError = new Error('queue withdrawal unavailable');
    client.abortPrompt.mockRejectedValue(abortError);
    const error = await controller.sendPromptNow({ text: STEER_TEXT }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SendNowError);
    expect((error as SendNowError).reason).toBe('unknown');
    expect((error as SendNowError).cause).toBe(abortError);
    const promptId = client.submitPrompt.mock.calls[0]![1].prompt_id as string;
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', promptId, 'main', true);
    expect(controller.getState().queuedPromptIds).toContain(promptId);
    expect(steerRows(controller.getState())).toEqual([]);
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('does not cancel a new turn or restore the draft when steer rejection races its queued prompt starting', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    let promptId = '';
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => {
      promptId = body.prompt_id;
      return queuedReceipt(promptId);
    });
    client.steerPrompt.mockRejectedValue(new ApiError({ code: 40001, msg: 'must start a new turn', data: null }));
    client.abortPrompt.mockResolvedValue({ aborted: false, at_seq: 2 });
    client.getAgentTranscript.mockImplementation(async () => ({
      agent_id: 'main', items: [], has_more: false, tasks: [], interactions: [], attachments: [], todos: [], meta: {},
      prompts: [{ promptId, userMessageId: promptId, status: 'running' as const, content: [{ type: 'text' as const, text: STEER_TEXT }], createdAt: '2026-01-01T00:00:03.000Z' }],
    }));
    const acknowledged = vi.fn();
    await expect(controller.sendPromptNow({ text: STEER_TEXT, onAcknowledged: acknowledged })).resolves.toMatchObject({ promptId: expect.any(String), outcome: 'started' });
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(client.abortPrompt).toHaveBeenCalledExactlyOnceWith('session_test', promptId, 'main', true);
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('does not restore a draft when a refused steer races an unknown queue transition', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    client.steerPrompt.mockRejectedValue(new ApiError({ code: 40001, msg: 'must start a new turn', data: null }));
    client.abortPrompt.mockResolvedValue({ aborted: false, at_seq: 2 });
    const outcome = await controller.sendPromptNow({ text: STEER_TEXT }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(SendNowError);
    expect((outcome as SendNowError).reason).toBe('unknown');
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', expect.any(String), 'main', true);
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('does not claim an obsolete queued prompt was inserted when the turn ended during steer', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    client.steerPrompt.mockRejectedValue(new ApiError({ code: 40402, msg: 'no active turn', data: null }));
    await expect(controller.sendPromptNow({ text: STEER_TEXT })).resolves.toMatchObject({ outcome: 'not_pending', reason: 'prompt_no_longer_pending' });
    expect(client.abortPrompt).not.toHaveBeenCalled();
    expect(controller.getPendingSteers()).toEqual([]);
    controller.close();
  });

  it('uses an explicit no-longer-pending receipt instead of treating it as an accepted steer', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    client.submitPrompt.mockImplementation(async (_sid: string, body: { prompt_id: string }) => queuedReceipt(body.prompt_id));
    client.steerPrompt.mockImplementation(async (_sid: string, promptId: string) => ({ steered: false, prompt_ids: [promptId], delivery_reason: 'prompt_no_longer_pending' }));
    await expect(controller.sendPromptNow({ text: STEER_TEXT })).resolves.toMatchObject({ outcome: 'not_pending', reason: 'prompt_no_longer_pending' });
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
    const presentation = { spans: [{ start: 0, end: STEER_TEXT.length, kind: 'selection' as const, quote: STEER_TEXT }] };
    const next = withPendingSteers(state, [{ promptId: 'p1', text: STEER_TEXT, presentation, createdAt: '2026-01-01T00:00:03.000Z', phase: 'sending' }]);
    expect(next.queuedPromptIds).toEqual(['p2']);
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toMatchObject({ id: 'user-p1', steerStatus: 'sending', presentation });
    expect(next.blocks[0]).not.toHaveProperty('promptStatus');
  });
});


describe('queued submit acknowledgement before transcript recovery', () => {
  it('retains the queued message for retry when cancelling it fails', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', emptySnapshot(), 1));
    client.submitPrompt.mockResolvedValue(queuedReceipt('cancel-retry'));
    await controller.sendPrompt({ promptId: 'cancel-retry', text: STEER_TEXT });
    client.abortPrompt.mockRejectedValueOnce(new Error('Cancel request unavailable'));
    await expect(controller.abortPrompt('cancel-retry')).rejects.toThrow('Cancel request unavailable');
    expect(controller.getState().queuedPromptIds).toEqual(['cancel-retry']);
    expect(controller.getState().blocks.find(block => block.kind === 'user')).toMatchObject({ text: STEER_TEXT, promptStatus: 'queued' });
    expect(controller.getState().blocks.some(block => block.kind === 'notice')).toBe(false);
    await deliver(controller, resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().queuedPromptIds).toEqual(['cancel-retry']);
    controller.close();
  });

  it('does not let an older empty reset erase a queued ack, and canonical abort prevents resurrection', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', emptySnapshot(), 1));
    client.submitPrompt.mockResolvedValue({ ...queuedReceipt('new-message'), revision: 0 });
    await controller.sendPrompt({ promptId: 'new-message', text: STEER_TEXT });
    expect(controller.getState().queuedPromptIds).toEqual(['new-message']);
    await deliver(controller, resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().queuedPromptIds).toEqual(['new-message']);
    expect(controller.getState().queuedPromptMeta['new-message']).toMatchObject({ revision: 0 });
    expect(controller.getState().blocks.filter(block => block.kind === 'user' && block.promptId === 'new-message')).toHaveLength(1);
    await deliver(controller, opsEvent('main', [{ op: 'prompt.upsert', prompt: {
      promptId: 'new-message', status: 'aborted', userMessageId: 'new-message', abortedBeforeStart: true,
      content: [{ type: 'text', text: STEER_TEXT }], createdAt: '2026-01-01T00:00:03Z', finishedAt: '2026-01-01T00:00:04Z',
    } }], 3));
    await deliver(controller, resetEvent('main', emptySnapshot(), 4));
    expect(controller.getState().queuedPromptIds).toEqual([]);
    expect(controller.getState().blocks.some(block => block.kind === 'user' && block.promptId === 'new-message')).toBe(false);
    expect(controller.getState().blocks.some(block => block.kind === 'notice')).toBe(false);
    controller.close();
  });
  it('removes a held cron occurrence by prompt id and reconciles without removing ordinary drafts', async () => {
    const { controller, client } = await open();
    const prompts = ['first-draft', 'cron-fire', 'second-draft'].map((promptId, queuePosition) => ({
      promptId, userMessageId: promptId, status: 'queued' as const, queuePosition,
      originKind: promptId === 'cron-fire' ? 'cron_job' as const : undefined,
      originDeliveryMode: promptId === 'cron-fire' ? 'idle' as const : undefined,
      content: [{ type: 'text' as const, text: promptId }], createdAt: '2026-01-01T00:00:03.000Z',
    }));
    await deliver(controller, resetEvent('main', emptySnapshot({ prompts }), 1));
    expect(controller.getState().queuedPromptMeta['cron-fire']).toMatchObject({ cronDeliveryMode: 'idle' });
    await controller.abortPrompt('cron-fire');
    expect(client.abortPrompt).toHaveBeenCalledExactlyOnceWith('session_test', 'cron-fire', undefined, true);
    expect(controller.getState().queuedPromptIds).toEqual(['first-draft', 'second-draft']);
    await deliver(controller, opsEvent('main', [{ op: 'prompt.upsert', prompt: {
      ...prompts[1]!, status: 'aborted', abortedBeforeStart: true, queuePosition: undefined, finishedAt: '2026-01-01T00:00:04.000Z',
    } }], 2));
    expect(controller.getState().queuedPromptIds).toEqual(['first-draft', 'second-draft']);
    expect(controller.getState().queuedPromptMeta['cron-fire']).toBeUndefined();
    expect(controller.getState().blocks.some(block => block.kind === 'user' && block.promptId === 'cron-fire')).toBe(false);
    controller.close();
  });

  it('converges a stale queued removal without erasing an already started turn', async () => {
    const { controller, client } = await open();
    const queued = { promptId: 'stale', userMessageId: 'stale', status: 'queued' as const, queuePosition: 0,
      content: [{ type: 'text' as const, text: 'waiting' }], createdAt: '2026-01-01T00:00:03.000Z' };
    await deliver(controller, resetEvent('main', emptySnapshot({ prompts: [queued] }), 1));
    client.abortPrompt.mockResolvedValueOnce({ aborted: false, at_seq: 1 });
    await controller.abortPrompt('stale');
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', 'stale', undefined, true);
    expect(controller.getState().queuedPromptIds).toEqual([]);
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.promptId === 'stale' && block.promptStatus === 'queued')).toBe(false);
    await deliver(controller, opsEvent('main', [{ op: 'prompt.upsert', prompt: { ...queued, status: 'running', queuePosition: undefined } }], 2));
    expect(controller.getState().queuedPromptIds).toEqual([]);
    controller.close();
  });

  it('explicit removal before its transcript upsert is not replayed by an empty reset', async () => {
    const { controller, client } = await open();
    await deliver(controller, resetEvent('main', emptySnapshot(), 1));
    client.submitPrompt.mockResolvedValue(queuedReceipt('remove-me'));
    await controller.sendPrompt({ promptId: 'remove-me', text: STEER_TEXT });
    await controller.abortPrompt('remove-me');
    await deliver(controller, resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().queuedPromptIds).toEqual([]);
    controller.close();
  });
});
