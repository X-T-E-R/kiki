import { describe, expect, it } from 'vitest';

import { ExternalClientRecorder } from '#/agent/execution/externalClientRecorder';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentStateService } from '#/agent/state/agentState';
import { turnKey, TurnPrompt } from '#/agent/loop/turnOps';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { Event2 } from '#/app/event/event2';

function buildRecorder() {
  const events: Event2[] = [];
  const loopEvents: unknown[] = [];
  const state = {
    nextTurnId: 7,
    cancelledTurnIds: [],
    anchorTurnIds: [],
  };
  const stateService = {
    get: () => state,
    set: (_key: unknown, value: typeof state) => Object.assign(state, value),
  };
  const dispatcher = {
    dispatch: async (event: Event2) => { events.push(event); },
    flush: async () => {},
  };
  const context = {
    appendLoopEvent: (event: unknown) => loopEvents.push(event),
  };
  const services = new Map<unknown, unknown>([
    [IAgentStateService, stateService],
    [IEventDispatcher, dispatcher],
    [IAgentContextMemoryService, context],
  ]);
  const recorder = new ExternalClientRecorder(
    {
      id: 'main',
      accessor: { get: <T>(id: unknown) => services.get(id as never) as T },
    },
    {
      connectionId: 'conn-1',
      clientName: 'Example Client',
      sessionRef: 'session-1',
      driver: 'external',
      operationId: 'op-1',
    },
  );
  return { recorder, events, loopEvents, state };
}

describe('ExternalClientRecorder', () => {
  it('allocates a turn and records native loop tool pairing without a prompt', async () => {
    const { recorder, events, loopEvents, state } = buildRecorder();
    await recorder.begin('Read', { path: 'example.txt' });
    recorder.toolCall({ toolCallId: 'call-1', name: 'Read', args: { path: 'example.txt' } });
    await recorder.toolResult({ toolCallId: 'call-1', output: 'contents' });
    await recorder.end('completed');

    expect(recorder.turnId).toBe(7);
    expect(state.nextTurnId).toBe(8);
    expect(events.map((event) => event.type)).toEqual([
      'external.activity',
      'turn.started',
      'turn.step.completed',
      'external.activity',
      'turn.ended',
    ]);
    expect(events.some((event) => event instanceof TurnPrompt)).toBe(false);
    expect(events[0]).toMatchObject({
      type: 'external.activity',
      source: { connectionId: 'conn-1', driver: 'external' },
      turnId: 7,
      phase: 'started',
    });
    expect(events[1]).toMatchObject({
      type: 'turn.started',
      source: 'external',
      origin: { kind: 'external_client', sessionRef: 'session-1' },
    });
    expect(Object.hasOwn(events[1]!, 'prompt')).toBe(false);
    expect(loopEvents).toEqual([
      { type: 'step.begin', uuid: recorder.stepId, turnId: '7', step: 1 },
      expect.objectContaining({ type: 'tool.call', toolCallId: 'call-1', name: 'Read' }),
      expect.objectContaining({
        type: 'tool.result',
        toolCallId: 'call-1',
        parentUuid: `${recorder.stepId}:tool:call-1`,
        result: { output: 'contents', isError: undefined, note: undefined, errorCode: undefined },
      }),
      { type: 'step.end', uuid: recorder.stepId, turnId: '7', step: 1, finishReason: 'completed' },
    ]);
  });

  it('saves external text as a source record instead of context text', async () => {
    const { recorder, events, loopEvents } = buildRecorder();
    await recorder.begin('kiki_save_text', { kind: 'handoff' });
    const receipt = await recorder.saveText({
      recordId: 'text-1',
      text: 'handoff',
      kind: 'handoff',
      title: 'Handoff',
      relatedOperationIds: ['op-1'],
    });
    await recorder.end('completed');

    expect(receipt).toEqual({ recordId: 'text-1', turnId: 7, operationId: 'op-1' });
    expect(events.map((event) => event.type)).toContain('external.text');
    expect(loopEvents.some((event) => (event as { type?: string }).type === 'context.append_message')).toBe(false);
    expect(events.find((event) => event.type === 'external.text')).toMatchObject({
      turnId: 7,
      text: 'handoff',
      kind: 'handoff',
      title: 'Handoff',
      relatedOperationIds: ['op-1'],
    });
  });
});
