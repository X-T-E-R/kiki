import { getMaxListeners } from 'node:events';

import { type ToolCall } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import { IAgentProfileService } from '#/index';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { ModelRequestTiming } from '#/kosong/model/modelRequester';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { ContinuationStepRequest, MessageStepRequest } from '#/agent/loop/stepRequest';
import {
  AssistantDelta,
  ThinkingDelta,
  TurnStarted,
  TurnStepInterrupted,
  TurnStepStarted,
} from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { RetryStepRequest } from '#/agent/prompt/promptStepRequests';
import type { ExecutableTool } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IEventBus } from '#/app/event/eventBus';
import { userCancellationReason } from '#/_base/utils/abort';

import {
  agentService,
  createTestAgent,
  permissionModeServices,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

describe('Agent loop', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(() => {
    ctx = createTestAgent(permissionModeServices('manual'));
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('resolves the loop service from the agent scope by interface', () => {
    expect(loop).toBeDefined();
  });

  it('keeps settled pending while an admission is held', async () => {
    const admission = loop.tryAcquireQuiescence();
    expect(admission).toBeDefined();
    let settled = false;
    const waiting = loop.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    admission!.dispose();
    await waiting;
    expect(settled).toBe(true);
  });

  it('preserves standalone steps for a prepared turn without relaxing history quiescence', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'prepared turn' });
    ctx.mockNextResponse({ type: 'text', text: 'standalone step' });
    const standalone = loop.enqueue(new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'standalone' }], toolCalls: [] }));
    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    const admission = loop.tryAcquireQuiescence({ pendingSteps: 'preserve' });
    expect(admission).toBeDefined();
    const prepared = loop.enqueue(new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'prepared' }], toolCalls: [] }, { admission: 'newTurn' }), { at: 'head' });
    expect(loop.status().state).toBe('idle');
    admission!.dispose();
    const turn = (await prepared.assigned).turn;
    expect((await standalone.assigned).turn.id).toBe(turn.id);
    expect((await turn.result).type).toBe('completed');
  });

  it('runs a text-only agent turn from prompt to completion', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools      { "names": [], "time": "<time>" }
      [wire] prompt.accepted             { "promptId": "<msg-1>", "time": "<time>" }
      [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Hello" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
      [wire] prompt.enqueued             { "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
      [wire] prompt.launch_committed     { "launchId": "<uuid-1>", "promptId": "<msg-1>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "managed": true }
      [emit] turn.started                { "time": "<time>", "turnId": 0, "origin": { "kind": "user" }, "prompt": "Hello", "promptId": "<msg-1>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
      [emit] context.spliced             { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] turn.prompt                 { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
      [wire] plugin.session_start        { "content": null, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] thinking.delta              { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "<think-1>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "thinking", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-4>", "delta": "<text-1>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "length": 2, "tokens": 11, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "contextTokens": 11 }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "think", "think": "<think-1>" } } }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "<text-1>" } } }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
      [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "think", "think": "<think-1>" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "<text-1>" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  });

  it('merges text deltas across a vacuous reasoning part instead of splitting the text', async () => {
    const assistantDeltas: AssistantDelta[] = [];
    const thinkingDeltas: ThinkingDelta[] = [];
    const bus = ctx.get(IEventBus);
    const subscriptions = [
      bus.subscribe(AssistantDelta, (event) => assistantDeltas.push(event)),
      bus.subscribe(ThinkingDelta, (event) => thinkingDeltas.push(event)),
    ];
    try {
      ctx.mockNextResponse(
        { type: 'text', text: 'Hello, ' },
        { type: 'think', think: '' },
        { type: 'text', text: 'world' },
      );
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await ctx.untilTurnEnd();
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
    }

    expect(assistantDeltas.map((event) => event.delta)).toEqual(['Hello, ', 'world']);
    expect(new Set(assistantDeltas.map((event) => event.partId)).size).toBe(1);
    expect(thinkingDeltas).toHaveLength(0);
  });

  it('persists a turn.ended wire record with the end reason and duration', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    const record = (await ctx.persistedWireRecords()).find((entry) => entry.type === 'turn.ended');
    expect(record).toMatchObject({ turnId: 0, reason: 'completed' });
    expect(record?.['durationMs']).toEqual(expect.any(Number));
    expect(record?.['time']).toEqual(expect.any(Number));
  });

  it('awaits the wire flush before the turn exits so the streamed step is durable', async () => {
    profile.update({ activeToolNames: [] });

    const wire = ctx.wire;
    const originalFlush = wire.flush.bind(wire);
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let flushObserved = false;
    wire.flush = async () => {
      await flushGate;
      flushObserved = true;
      return originalFlush();
    };

    ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    expect(flushObserved).toBe(false);
    releaseFlush();
    await ctx.wire.flush();
    expect(flushObserved).toBe(true);

    const persisted = await ctx.persistedWireRecords();
    const contentParts = persisted.filter(
      (entry) =>
        entry.type === 'context.append_loop_event' &&
        (entry as { event?: { type?: string } }).event?.type === 'content.part',
    );
    expect(contentParts).toHaveLength(2);
    expect(
      contentParts.some((entry) => JSON.stringify(entry).includes('"type":"think"')),
    ).toBe(true);
    expect(
      contentParts.some((entry) => JSON.stringify(entry).includes('"type":"text"')),
    ).toBe(true);
  });

  it('fails the turn after a filtered step completes', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools      { "names": [], "time": "<time>" }
      [wire] prompt.accepted             { "promptId": "<msg-1>", "time": "<time>" }
      [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Hello" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
      [wire] prompt.enqueued             { "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
      [wire] prompt.launch_committed     { "launchId": "<uuid-1>", "promptId": "<msg-1>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "managed": true }
      [emit] turn.started                { "time": "<time>", "turnId": 0, "origin": { "kind": "user" }, "prompt": "Hello", "promptId": "<msg-1>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
      [emit] context.spliced             { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] turn.prompt                 { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
      [wire] plugin.session_start        { "content": null, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "blocked" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "length": 2, "tokens": 8, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "contextTokens": 8 }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "blocked" } } }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "filtered", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "filtered", "rawFinishReason": "filtered" } }
      [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "filtered", "providerFinishReason": "filtered", "rawFinishReason": "filtered" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "blocked" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "filtered", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "filtered", "rawFinishReason": "filtered" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "interruptReason": "filtered" }
    `);

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );

    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'filtered',
    });
  });

  it('marks a completed turn as truncated when the provider stops at max tokens', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial answer' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: true,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'max_tokens',
      providerFinishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const turnEnded = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'completed' });
  });

  it('stops the turn when provider reports tool_calls without any tool call structure', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      finishReason: 'tool_calls',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'other',
      providerFinishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    });
  });

  it('lets a loop error handler recover a non-context loop error by retrying', async () => {
    profile.update({ activeToolNames: [] });
    const seenErrors: Array<{ readonly step: number | undefined; readonly message: string }> = [];

    loop.registerLoopErrorHandler({
      id: 'test-recover-generate-error',
      match: () => true,
      handle: async (hookCtx) => {
        seenErrors.push({
          step: hookCtx.step,
          message: hookCtx.error instanceof Error ? hookCtx.error.message : String(hookCtx.error),
        });
        if (seenErrors.length === 1) {
          ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
          if (hookCtx.failedDriver !== undefined) {
            loop.enqueue(hookCtx.failedDriver, { at: 'head' });
            return true;
          }
        }
        return undefined;
      },
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(seenErrors).toEqual([
      { step: 1, message: 'Unexpected generate call #1' },
    ]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('reports an untyped LLM error message without an internal-code prefix', async () => {
    profile.update({ activeToolNames: [] });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.interrupted',
        args: expect.objectContaining({
          reason: 'error',
          message: 'Unexpected generate call #1',
        }),
      }),
    );
  });

  it('records step.end with finishReason error when a step fails', async () => {
    profile.update({ activeToolNames: [] });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    const begins = wireLoopEvents(ctx, 'step.begin');
    const ends = wireLoopEvents(ctx, 'step.end');
    expect(begins).toHaveLength(1);
    expect(ends).toEqual([
      expect.objectContaining({ uuid: begins[0]!['uuid'], finishReason: 'error' }),
    ]);
  });

  it('records step.end with finishReason interrupted when the turn is cancelled mid-step', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel();
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    expect(loop.status().lastTurnResult).toBe('cancelled');
    subscription.dispose();

    const begins = wireLoopEvents(ctx, 'step.begin');
    const ends = wireLoopEvents(ctx, 'step.end');
    expect(begins).toHaveLength(1);
    expect(ends).toEqual([
      expect.objectContaining({ uuid: begins[0]!['uuid'], finishReason: 'interrupted' }),
    ]);
  });

  it('does not run loop error handlers for aborted turns', async () => {
    let called = false;
    loop.registerLoopErrorHandler({
      id: 'test-abort-not-recoverable',
      match: () => {
        called = true;
        return true;
      },
      handle: async () => undefined,
    });
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    const result = await loop.run({ turnId: 0, signal: controller.signal });

    expect(result.type).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('fails with the error handler error when recovery throws', async () => {
    const recoveryError = new Error('recovery failed');
    loop.registerLoopErrorHandler({
      id: 'test-throw-recovery-error',
      match: () => true,
      handle: async () => {
        throw recoveryError;
      },
    });

    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 0 });

    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.error).toBe(recoveryError);
    }
  });

  it('runs an agent turn through registered tool approval and execution', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up moon' }],
    });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools          { "names": [ "Lookup" ], "time": "<time>" }
      [wire] prompt.accepted                 { "promptId": "<msg-1>", "time": "<time>" }
      [emit] prompt.submitted                { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
      [wire] prompt.enqueued                 { "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
      [wire] prompt.launch_committed         { "launchId": "<uuid-1>", "promptId": "<msg-1>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
      [emit] turn.prompt                     { "time": "<time>", "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true }
      [emit] turn.started                    { "time": "<time>", "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up moon", "promptId": "<msg-1>" }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_message          { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
      [emit] context.spliced                 { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [emit] prompt.started                  { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] turn.prompt                     { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
      [wire] plugin.session_start            { "content": null, "time": "<time>" }
      [emit] turn.step.started               { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event       { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "tools": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "I will look it up." }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] tool.call.delta                 { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                    { "model": "mock-model", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured         { "length": 2, "tokens": 20, "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "contextTokens": 20 }
      [emit] context.append_loop_event       { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } } }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" } }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [ { "approvalId": "<approval-1>", "toolCallId": "call_lookup", "since": "<time>" } ], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] requestApproval                 { "id": "<approval-1>", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Lookup
    messages:
      user: text "Look up moon"
  `);

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] permission.approval.resolved        { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" }, "decision": "approved", "selectedLabel": "approve" }
      [emit] agent.activity.updated              { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [emit] tool.call.started                   { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [emit] agent.activity.updated              { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_lookup", "name": "Lookup", "since": "<time>" } ], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event           { "time": "<time>", "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } } }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
      [emit] tool.result                         { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "output": "lookup-result" }
      [emit] agent.activity.updated              { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event           { "time": "<time>", "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "lookup-result" } } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "lookup-result" } }, "time": "<time>" }
      [emit] context.append_loop_event           { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" } }
      [emit] turn.step.completed                 { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [emit] turn.step.started                   { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
      [emit] agent.activity.updated              { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event           { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 } }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.request                         { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta                     { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "partId": "<uuid-6>", "delta": "The lookup result is lookup-result." }
      [emit] agent.activity.updated              { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated                { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured             { "length": 4, "tokens": 37, "time": "<time>" }
      [emit] agent.status.updated                { "time": "<time>", "contextTokens": 37 }
      [emit] context.append_loop_event           { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "The lookup result is lookup-result." } } }
      [emit] context.append_loop_event           { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
      [emit] turn.step.completed                 { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated              { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "The lookup result is lookup-result." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                          { "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                          { "time": "<time>", "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    messages:
      <last>
      assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
      tool[call_lookup]: text "lookup-result"
  `);
  });

  it('withholds truncated tool calls when the provider finish reason is truncated', async () => {
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    const local = createTestAgent(permissionModeServices('yolo'));
    try {
      local.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
      local.get(IAgentToolRegistryService).register(lookupTool);
      local.mockNextProviderResponse({
        parts: [
          {
            type: 'function',
            id: 'call_cut',
            name: 'Lookup',
            arguments: '{"query":"mo',
          },
        ],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });
      local.mockNextResponse({ type: 'text', text: 'retrying with a shorter query.' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await local.untilTurnEnd();

      const toolMessage = local.contextData().history.find((message) => message.role === 'tool');
      const output = toolMessage?.content.find((part) => part.type === 'text')?.text ?? '';
      expect(output).toContain('not executed');
      expect(output).toContain('truncated');
      expect(output).toContain('query');
      expect(output).toContain('byte 12');
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('preserves tool call extras (Gemini thought_signature) through to context', async () => {
    const sigCall: ToolCall = {
      type: 'function',
      id: 'call_sig',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
      extras: { thought_signature_b64: 'c2lnbmF0dXJl' },
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, sigCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    const assistant = ctx.contextData().history.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: 'c2lnbmF0dXJl' });
  });

  it('lets non-external stop hooks continue a turn more than once', async () => {
    profile.update({ activeToolNames: [] });
    let continuations = 0;
    loop.hooks.onDidFinishStep.register('test-repeat-stop-continuation', async (hookCtx, next) => {
      if (continuations < 2) {
        continuations += 1;
        loop.enqueue(
          new MessageStepRequest(
            {
              role: 'user',
              content: [{ type: 'text', text: `continue ${continuations}` }],
              toolCalls: [],
              origin: { kind: 'system_trigger', name: 'stop_hook' },
            },
            { kind: 'stop_hook', mergeable: true },
          ),
        );
        return;
      }
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Third answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(continuations).toBe(2);
    expect(ctx.llmCalls).toHaveLength(3);
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 1' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 2' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
  });

  it('raises the abort-listener ceiling on the step signal for parallel tool bursts', async () => {
    profile.update({ activeToolNames: [] });
    let observed = 0;
    loop.hooks.onDidFinishStep.register('test-step-signal-listener-ceiling', async (hookCtx, next) => {
      observed = getMaxListeners(hookCtx.signal);
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(observed).toBe(64);
  });

  it('ends the turn when an afterStep hook sets stopTurn even though the model requested tool calls', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    loop.hooks.onDidFinishStep.register('test-stop-turn', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    ctx.mockNextResponse({ type: 'text', text: 'This step should not run.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('lets stopTurn take precedence over a queued continuation request', async () => {
    profile.update({ activeToolNames: [] });

    loop.hooks.onDidFinishStep.register('test-continue-like-stop-hook', async (hookCtx, next) => {
      loop.enqueue(new ContinuationStepRequest());
      await next();
    });
    loop.hooks.onDidFinishStep.register('test-hard-stop', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'This continuation should not run.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('queues consecutive nextTurn requests in FIFO order without overlapping turns', async () => {
    const events: string[] = [];
    const subscription = ctx.get(IEventBus).subscribe((event) => {
      if (event instanceof TurnStarted || event instanceof TurnEnded) {
        events.push(`${event.type}:${event.turnId}`);
      }
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = (await loop.enqueue(nextTurnMessage('first')).assigned).turn;
    const second = (await loop.enqueue(nextTurnMessage('second')).assigned).turn;
    const third = (await loop.enqueue(nextTurnMessage('third')).assigned).turn;

    expect([first.state, second.state, third.state]).toEqual(['running', 'queued', 'queued']);
    await Promise.all([first.result, second.result, third.result]);
    subscription.dispose();

    expect(events).toEqual([
      'turn.started:0',
      'turn.ended:0',
      'turn.started:1',
      'turn.ended:1',
      'turn.started:2',
      'turn.ended:2',
    ]);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('refuses a quiescence lease while a turn is active without cancelling it', async () => {
    let started!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-quiescence', async (_hookCtx, next) => {
      started();
      await canFinish;
      await next();
    });

    const active = (await loop.enqueue(nextTurnMessage('active')).assigned).turn;
    await activeStarted;

    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    expect(active.signal.aborted).toBe(false);

    hook.dispose();
    ctx.mockNextResponse({ type: 'text', text: 'completed normally' });
    release();
    await expect(active.result).resolves.toMatchObject({ type: 'completed' });
  });

  it('holds new admissions until an idle quiescence lease is released', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    const held = loop.enqueue(nextTurnMessage('held'));
    let assigned = false;
    void held.assigned.then(() => {
      assigned = true;
    });

    await Promise.resolve();
    expect(assigned).toBe(false);
    expect(loop.status()).toMatchObject({ state: 'idle', hasPendingRequests: true });

    ctx.mockNextResponse({ type: 'text', text: 'after undo' });
    lease?.dispose();
    const resumed = (await held.assigned).turn;
    await expect(resumed.result).resolves.toMatchObject({ type: 'completed' });
  });

  it('can abort an admission while quiescence holds it', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    const held = loop.enqueue(nextTurnMessage('held'));

    expect(held.abort()).toBe(true);
    await expect(held.assigned).rejects.toBeDefined();
    expect(loop.hasPendingRequests()).toBe(false);

    lease?.dispose();
    expect(loop.status().state).toBe('idle');
  });

  it('cancels a running step without cancelling its turn and continues the next step', async () => {
    let releaseRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-running-step-cancel', async (hookCtx, next) => {
      if (hookCtx.step === 2) {
        stepStarted();
        await Promise.race([
          running,
          new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
          }),
        ]);
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'initial' });
    ctx.mockNextResponse({ type: 'text', text: 'after cancellation' });

    const turn = (await loop.enqueue(nextTurnMessage('start')).assigned).turn;
    const cancelledStep = (await loop.enqueue(new ContinuationStepRequest()).assigned).step;
    loop.enqueue(new ContinuationStepRequest());
    await started;

    expect(cancelledStep.state).toBe('running');
    expect(cancelledStep.cancel(new Error('skip this step'))).toBe(true);
    await expect(cancelledStep.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 3 });
    releaseRunning();

    expect(turn.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('disposes active and queued turns with all steps settled and never pumps again', async () => {
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-dispose-loop', async (hookCtx, next) => {
      stepStarted();
      await new Promise<void>((_, reject) => {
        hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
      });
      await next();
    });

    const active = (await loop.enqueue(nextTurnMessage('active')).assigned).turn;
    const activeQueuedStep = (await loop.enqueue(new ContinuationStepRequest()).assigned).step;
    const queued = (await loop.enqueue(nextTurnMessage('queued')).assigned).turn;
    const queuedExtraStep = (await loop.enqueue(nextTurnMessage('queued-extra')).assigned).step;
    await started;

    (loop as IAgentLoopService & { dispose(): void }).dispose();

    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await expect(activeQueuedStep.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(queuedExtraStep.result).resolves.toMatchObject({ type: 'cancelled' });
    expect(active.state).toBe('cancelled');
    expect(queued.state).toBe('cancelled');
    expect(ctx.llmCalls).toHaveLength(0);
    expect(() => loop.enqueue(nextTurnMessage('rejected'))).toThrow();
  });

  it('cancels a queued turn without starting or materializing its initial request', async () => {
    const started: number[] = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      started.push(event.turnId);
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = (await loop.enqueue(nextTurnMessage('first')).assigned).turn;
    const cancelledReceipt = loop.enqueue(nextTurnMessage('cancelled'));
    const cancelledTurn = (await cancelledReceipt.assigned).turn;
    const third = (await loop.enqueue(nextTurnMessage('third')).assigned).turn;

    expect(cancelledReceipt.abort()).toBe(true);
    await expect(cancelledTurn.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await Promise.all([first.result, third.result]);
    subscription.dispose();

    expect(started).toEqual([0, 2]);
    expect(ctx.contextData().history).not.toContainEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'cancelled' }] }),
    );
  });

  it('exposes subagent messages on turn.started while hiding other system triggers', async () => {
    const prompts: Array<string | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      prompts.push(event.prompt);
    });
    ctx.mockNextResponse({ type: 'text', text: 'continued' });
    ctx.mockNextResponse({ type: 'text', text: 'scanning' });
    ctx.mockNextResponse({ type: 'text', text: 'hi there' });

    const system = (
      await loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'continue the goal' }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'goal_continuation' },
          },
          { admission: 'newTurn' },
        ),
      ).assigned
    ).turn;
    await system.result;
    const subagent = (
      await loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'scan the repo' }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'subagent' },
          },
          { admission: 'newTurn' },
        ),
      ).assigned
    ).turn;
    await subagent.result;
    const user = (await loop.enqueue(nextTurnMessage('hi')).assigned).turn;
    await user.result;
    subscription.dispose();

    expect(prompts).toEqual([undefined, 'scan the repo', 'hi']);
  });

  it('carries session-media prompt attachments on turn.started', async () => {
    const payloads: Array<readonly { kind: string; fileId: string }[] | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = (
      await loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [
              { type: 'image_url', imageUrl: { url: 'kimi-file://file_1', id: 'file_1', name: 'photo.png' } },
              { type: 'video_url', videoUrl: { url: 'kimi-file://file_2', id: 'file_2', name: 'clip.mp4' } },
              { type: 'image_url', imageUrl: { url: 'https://example.com/no-id.png' } },
              { type: 'image_url', imageUrl: { url: 'ms://provider-blob', id: 'prov_1' } },
              { type: 'text', text: 'look' },
            ],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          { admission: 'newTurn' },
        ),
      ).assigned
    ).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        { kind: 'image', fileId: 'file_1', name: 'photo.png' },
        { kind: 'video', fileId: 'file_2', name: 'clip.mp4' },
      ],
    ]);
  });

  it('carries kimi-file prompt attachments on turn.started, falling back to the URL file id', async () => {
    const payloads: Array<readonly { kind: string; fileId: string }[] | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = (
      await loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [
              { type: 'image_url', imageUrl: { url: 'kimi-file://file_1', id: 'file_1' } },
              { type: 'video_url', videoUrl: { url: 'kimi-file://file_2', id: 'file_2' } },
              { type: 'image_url', imageUrl: { url: 'kimi-file://file_3' } },
              { type: 'image_url', imageUrl: { url: 'kimi-file://file_4', id: 'other' } },
              { type: 'image_url', imageUrl: { url: 'https://example.com/no-id.png' } },
              { type: 'image_url', imageUrl: { url: 'ms://provider-blob', id: 'prov_1' } },
              { type: 'text', text: 'look' },
            ],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          { admission: 'newTurn' },
        ),
      ).assigned
    ).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        { kind: 'image', fileId: 'file_1' },
        { kind: 'video', fileId: 'file_2' },
        { kind: 'image', fileId: 'file_3' },
      ],
    ]);
  });
});

describe('turn telemetry', () => {
  it('emits turn_started and turn_ended with mode and protocol on completion', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'text', text: 'hi' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: {
          turn_id: 0,
          agent_id: 'main',
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
        },
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          duration_ms: expect.any(Number),
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
        }),
      });
      expect(records.some((record) => record.event === 'turn_interrupted')).toBe(false);
    } finally {
      await local.dispose();
    }
  });

  it('keeps turn telemetry aligned with the request config across pre-step changes', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      const localProfile = local.get(IAgentProfileService);
      local.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 1_000_000,
        },
      });
      localProfile.update({ activeToolNames: [] });
      localProfile.setThinking('on');
      localLoop.hooks.onWillBeginStep.register('test-change-thinking', async (_ctx, next) => {
        localProfile.setThinking('off');
        await next();
      });
      local.mockNextResponse({ type: 'text', text: 'hi' });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      const request = local.allEvents.find(
        (event) => event.type === '[wire]' && event.event === 'llm.request',
      );
      expect(request?.args).toMatchObject({ thinkingEffort: 'on' });
      expect(records).toContainEqual({
        event: 'turn_started',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('attaches the latest request trace id to turn_ended', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        traceId: 'trace-turn-1',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          trace_id: 'trace-turn-1',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('does not reuse the previous step trace when a step hook fails before a request', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      localLoop.hooks.onDidFinishStep.register('test-continue-after-first-step', async (hookCtx, next) => {
        if (hookCtx.step === 1) {
          localLoop.enqueue(new ContinuationStepRequest());
          return;
        }
        await next();
      });
      localLoop.hooks.onWillBeginStep.register('test-fail-before-second-request', async (hookCtx, next) => {
        if (hookCtx.step === 2) throw new Error('before step failed');
        await next();
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first' }],
        traceId: 'trace-step-1',
      });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(1);
      expect(records.find((record) => record.event === 'turn_interrupted')?.properties?.['trace_id']).toBeUndefined();
      expect(records.find((record) => record.event === 'turn_ended')?.properties?.['trace_id']).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('emits turn_interrupted with interrupt_reason filtered and turn_ended failed', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'blocked' }],
        finishReason: 'filtered',
        traceId: 'trace-turn-2',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_interrupted',
        properties: expect.objectContaining({
          turn_id: 0,
          at_step: 1,
          mode: 'agent',
          interrupt_reason: 'filtered',
          provider_type: 'kimi',
          protocol: 'openai',
          trace_id: 'trace-turn-2',
        }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'failed',
          mode: 'agent',
          trace_id: 'trace-turn-2',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it.each([
    ['user_cancelled', () => userCancellationReason()],
    ['aborted', () => new Error('stop')],
  ] as const)(
    'emits turn_interrupted with interrupt_reason %s on cancellation',
    async (expected, makeReason) => {
      const records: TelemetryRecord[] = [];
      const local = createTestAgent({ telemetry: recordingTelemetry(records) });
      try {
        const localLoop = local.get(IAgentLoopService);
        let stepStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          stepStarted = resolve;
        });
        localLoop.hooks.onWillBeginStep.register('test-hang', async (hookCtx, next) => {
          stepStarted();
          await new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), {
              once: true,
            });
          });
          await next();
        });

        const turn = (await localLoop.enqueue(nextTurnMessage('hang')).assigned).turn;
        await started;
        localLoop.cancel(turn.id, makeReason());
        await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

        expect(records).toContainEqual({
          event: 'turn_interrupted',
          properties: expect.objectContaining({ turn_id: 0, interrupt_reason: expected, mode: 'agent' }),
        });
        expect(records).toContainEqual({
          event: 'turn_ended',
          properties: expect.objectContaining({ reason: 'cancelled' }),
        });
      } finally {
        await local.dispose();
      }
    },
  );
});

describe('interruption reminder', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;

  beforeEach(() => {
    ctx = createTestAgent(permissionModeServices('manual'));
    loop = ctx.get(IAgentLoopService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function cancelOnFirstDelta(): IDisposable {
    return ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel();
    });
  }

  function remindersIn(target: TestAgentContext): ContextMessage[] {
    return target.contextData().history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'interruption',
    );
  }

  function interruptionReminders(): ContextMessage[] {
    return remindersIn(ctx);
  }

  function contentPartRecordsIn(target: TestAgentContext): number {
    return target.allEvents.filter(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === 'content.part',
    ).length;
  }

  it('preserves the partial stream and appends one reminder at the cancellation event point', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history.slice(0, 2)).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
        toolCalls: [],
        partial: true,
      },
    ]);
    expect(interruptionReminders()).toHaveLength(1);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({
      turnId: 0,
      target: 'active',
      reason: 'user_cancelled',
    });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({
      reason: 'cancelled',
      interruptReason: 'user_cancelled',
    });
    expect(contentPartRecordsIn(ctx)).toBe(1);

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(interruptionReminders()).toHaveLength(1);
    expect(interruptionReminders()[0]!.content).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user\'s next message continues the conversation.\n</system-reminder>',
      },
    ]);
    expect(ctx.contextData().history.indexOf(interruptionReminders()[0]!)).toBe(2);
  });

  it('writes one active cancellation when cancel repeats before the turn settles', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const results: boolean[] = [];
    let cancelled = false;
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      if (cancelled) return;
      cancelled = true;
      results.push(loop.cancel(), loop.cancel());
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(results).toEqual([true, true]);
    expect(
      ctx.allEvents.filter(
        (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
      ),
    ).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('preserves the partial stream but appends no reminder on programmatic abort', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel(undefined, new Error('stop'));
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      toolCalls: [],
      partial: true,
    });
    expect(interruptionReminders()).toHaveLength(0);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({ target: 'active', reason: 'aborted' });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'cancelled', interruptReason: 'aborted' });
  });

  it('does not stack a second reminder without an intervening message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.get(IEventBus).publish(
      new TurnEnded({
        turnId: 99,
        reason: 'cancelled',
        interruptReason: 'user_cancelled',
      }),
    );

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('appends no reminder when a queued turn is user-cancelled before starting', async () => {
    let release!: () => void;
    let armed = true;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-hang-queued-cancel', async (hookCtx, next) => {
      if (armed) {
        armed = false;
        signalEntered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'unreached' });

    const active = (await loop.enqueue(nextTurnMessage('active')).assigned).turn;
    const queued = (await loop.enqueue(nextTurnMessage('queued')).assigned).turn;
    expect(loop.cancel(queued.id)).toBe(true);
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await entered;
    release();
    loop.cancel(active.id);
    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(interruptionReminders()).toHaveLength(1);
    const queuedCancel = ctx.allEvents.find(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'turn.cancel' &&
        (entry.args as { target?: string }).target === 'queued',
    );
    expect(queuedCancel?.args).toMatchObject({ target: 'queued', reason: 'user_cancelled' });

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('sends the partial output and reminder in the next atomic step', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    ctx.llmInputs();

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "partial answer"
        user: text "<system-reminder>\\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.\\n</system-reminder>"
        user: text "Next"
    `);
  });

  it('undo removes the event-point interruption with its cancelled turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([]);

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(0);
  });

  it('preserves partial thinking on user cancel', async () => {
    ctx.mockNextResponse({ type: 'think', think: 'pondering' }, { type: 'text', text: 'answer' });
    const subscription = ctx.get(IEventBus).subscribe(ThinkingDelta, () => {
      loop.cancel();
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [{ type: 'think', think: 'pondering' }],
      toolCalls: [],
      partial: true,
    });
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('records no partial content when the stream only produced whitespace', async () => {
    ctx.mockNextResponse({ type: 'text', text: '  ' }, { type: 'text', text: 'answer' });
    const subscription = cancelOnFirstDelta();
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(contentPartRecordsIn(ctx)).toBe(0);
    expect(ctx.contextData().history.slice(0, 2)).toEqual([
      expect.objectContaining({ role: 'user' }),
      { role: 'assistant', content: [], toolCalls: [], partial: true },
    ]);
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('does not stack a second reminder around a vacuous retry turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const first = cancelOnFirstDelta();
    const firstTurn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(firstTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    first.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'retried answer' });
    const onStepStarted = ctx.get(IEventBus).subscribe(TurnStepStarted, () => {
      loop.cancel();
    });
    const retryTurn = (await loop.enqueue(new RetryStepRequest()).assigned).turn;
    await expect(retryTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    onStepStarted.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'third answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('renders a new interruption reminder after an intervening completed turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'first partial answer' });
    const first = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();
    first.dispose();

    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'completed prompt' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'second partial answer' });
    const second = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();
    second.dispose();

    ctx.mockNextResponse({ type: 'text', text: 'final answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'final prompt' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(2);
  });

  it('does not duplicate recorded content when cancelled during tool execution', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    try {
      const slowToolStarted = registerAbortableWorkTool(local);
      const localLoop = local.get(IAgentLoopService);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
      );
      local.mockNextResponse(
        { type: 'text', text: 'still working' },
        { type: 'function', id: 'call-work-2', name: 'Work', arguments: '{}' },
      );
      const turn = (await localLoop.enqueue(nextTurnMessage('do work')).assigned).turn;
      await slowToolStarted.promise;
      localLoop.cancel(turn.id);
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      expect(contentPartRecordsIn(local)).toBe(2);
      expect(remindersIn(local)).toHaveLength(1);

      local.mockNextResponse({ type: 'text', text: 'follow-up answer' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'again' }] });
      await local.untilTurnEnd();

      const history = local.contextData().history;
      expect(remindersIn(local)).toHaveLength(1);
      const reminderIndex = history.indexOf(remindersIn(local)[0]!);
      expect(history.slice(0, reminderIndex).some((message) => message.role === 'tool')).toBe(true);
      expect(history[reminderIndex + 1]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'again' }],
      });

      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('llm requester attempt retry', () => {
  it('discards the interrupted attempt fragments instead of merging them into the retried attempt', async () => {
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, createRetryingRequester()));
    try {
      const assistantDeltas: AssistantDelta[] = [];
      const subscription = ctx
        .get(IEventBus)
        .subscribe(AssistantDelta, (event) => assistantDeltas.push(event));
      try {
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
        await ctx.untilTurnEnd();
      } finally {
        subscription.dispose();
      }

      expect(assistantDeltas.map((event) => event.delta)).toEqual(['Hello', 'World']);
      expect(new Set(assistantDeltas.map((event) => event.partId)).size).toBe(2);
      const contentParts = wireLoopEvents(ctx, 'content.part');
      expect(contentParts).toHaveLength(1);
      expect(contentParts[0]?.['uuid']).toBe(assistantDeltas[1]?.partId);
    } finally {
      await ctx.dispose();
    }
  });
});

describe('step timing split propagation', () => {
  it('carries the split from the llmRequester timing event to the turn.step.completed protocol event', async () => {
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, createTimingRequester()));
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await ctx.untilTurnEnd();

      const stepCompleted = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
      );
      expect(stepCompleted?.args).toMatchObject({
        llmFirstTokenLatencyMs: 100,
        llmStreamDurationMs: 200,
        llmRequestBuildMs: 30,
        llmServerFirstTokenMs: 70,
        llmServerDecodeMs: 150,
        llmClientConsumeMs: 50,
      });
    } finally {
      await ctx.dispose();
    }
  });
});

describe('aborted step tool execution', () => {
  it('accounts model usage when the step is aborted during tool execution', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish the task' });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 60 } });
      ctx.get(IEventBus).publish(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));

      const loopService = ctx.get(IAgentLoopService);
      loopService.enqueue(new ContinuationStepRequest());
      const controller = new AbortController();
      const resultPromise = loopService.run({
        turnId: 1,
        signal: controller.signal,
      });
      await slowToolStarted.promise;
      controller.abort(new Error('cancelled by test'));

      await expect(resultPromise).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(ctx.get(IAgentUsageService).status()).toMatchObject({
        total: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        currentTurn: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        tokensUsed: 61,
        budget: { tokenBudgetReached: true },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('includes the programmatic abort reason when a tool execution is interrupted', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    let interrupted:
      | { readonly stepId?: string; readonly reason: string; readonly message?: string }
      | undefined;
    const subscription = ctx
      .get(IEventBus)
      .subscribe(TurnStepInterrupted, (event) => {
        interrupted = event;
      });

    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const loopService = ctx.get(IAgentLoopService);
      loopService.enqueue(new ContinuationStepRequest());
      const controller = new AbortController();
      const result = loopService.run({
        turnId: 1,
        signal: controller.signal,
      });
      await slowToolStarted.promise;
      controller.abort(new Error('Tool execution timed out'));

      await expect(result).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(interrupted).toMatchObject({
        stepId: expect.any(String),
        reason: 'aborted',
        message: 'Tool execution timed out',
      });
    } finally {
      subscription.dispose();
      await ctx.dispose();
    }
  });
});

function nextTurnMessage(text: string): MessageStepRequest {
  return new MessageStepRequest(
    {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
    { admission: 'newTurn' },
  );
}

function wireLoopEvents(
  target: TestAgentContext,
  eventType: string,
): Array<Record<string, unknown>> {
  return target.allEvents
    .filter(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === eventType,
    )
    .map((entry) => (entry.args as { event: Record<string, unknown> }).event);
}

function createTimingRequester(): IAgentLLMRequesterService {
  const timing: ModelRequestTiming = {
    firstTokenLatencyMs: 100,
    streamDurationMs: 200,
    requestBuildMs: 30,
    serverFirstTokenMs: 70,
    serverDecodeMs: 150,
    clientConsumeMs: 50,
  };

  const requester: IAgentLLMRequesterService = {
    _serviceBrand: undefined,
    prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
    invalidatePromptSnapshots: () => 0,
    async request(_overrides, onPart = () => {}) {
      await onPart({ type: 'text', text: 'answer' });
      return {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        model: 'mock-model',
        timing,
      };
    },
    start(overrides, onPart, signal) {
      return { trace: { traceId: undefined }, result: this.request(overrides, onPart, signal) };
    },
  };
  return requester;
}

function createRetryingRequester(): IAgentLLMRequesterService {
  const requester: IAgentLLMRequesterService = {
    _serviceBrand: undefined,
    prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
    invalidatePromptSnapshots: () => 0,
    async request(overrides = {}, onPart = () => {}) {
      await onPart({ type: 'text', text: 'Hello' });
      overrides.onAttemptRetry?.();
      await onPart({ type: 'text', text: 'World' });
      return {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'World' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        model: 'mock-model',
      };
    },
    start(overrides, onPart, signal) {
      return { trace: { traceId: undefined }, result: this.request(overrides, onPart, signal) };
    },
  };
  return requester;
}

function createAbortedStepGenerate(): GenerateFn {
  const usages = [
    { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
    { inputOther: 7, output: 11, inputCacheRead: 0, inputCacheCreation: 0 },
  ];
  let requestIndex = 0;

  return async () => {
    const usage = usages[requestIndex];
    if (usage === undefined) throw new Error('Unexpected model request');
    requestIndex += 1;
    return {
      id: `response-${String(requestIndex)}`,
      message: {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: `call-work-${String(requestIndex)}`,
            name: 'Work',
            arguments: '{}',
          },
        ],
      },
      usage,
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  };
}

function registerAbortableWorkTool(ctx: TestAgentContext): ReturnType<typeof deferred> {
  const slowToolStarted = deferred();
  let executions = 0;
  const tool: ExecutableTool = {
    name: 'Work',
    description: 'Run one fast operation and one cancellable operation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: () => ({
      approvalRule: 'Work',
      accesses: [],
      execute: async ({ signal }) => {
        executions += 1;
        if (executions === 1) return { output: 'first step complete' };
        slowToolStarted.resolve();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
        return { output: 'second step cancelled' };
      },
    }),
  };
  ctx.get(IAgentProfileService).update({ activeToolNames: ['Work'] });
  ctx.get(IAgentToolRegistryService).register(tool);
  return slowToolStarted;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
