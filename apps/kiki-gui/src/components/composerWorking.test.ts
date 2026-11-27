// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Block } from '@kiki/session-core/session';

import {
  agentOutputSignature,
  blockActivityTimestamp,
  currentTurnScope,
  latestAgentTimestamp,
  useComposerWorking,
  type ComposerWorkingInput,
  type ComposerWorkingTiming,
} from './composerWorking';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) roots.pop()?.unmount();
  while (containers.length > 0) containers.pop()?.remove();
});

function renderWorkingHook(initial: ComposerWorkingInput) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  let latest: ComposerWorkingTiming = { startedAt: undefined, lastResponseAt: undefined };

  function Probe({ input }: { readonly input: ComposerWorkingInput }) {
    latest = useComposerWorking(input);
    return null;
  }

  act(() => {
    root.render(createElement(Probe, { input: initial }));
  });

  return {
    read: () => latest,
    rerender: (next: ComposerWorkingInput) => {
      act(() => {
        root.render(createElement(Probe, { input: next }));
      });
    },
  };
}

describe('composerWorking Persona message & subagent tracking (t1095)', () => {
  it('tracks Persona message blocks in agentOutputSignature, blockActivityTimestamp, and latestAgentTimestamp', () => {
    const turnStart = Date.parse('2026-11-27T08:00:00.000Z');
    const msgAt = Date.parse('2026-11-27T08:00:04.000Z');
    const blocksSending: Block[] = [
      {
        kind: 'user',
        id: 'u-1',
        turnId: 't-1',
        text: '早安妮娅',
        createdAt: '2026-11-27T08:00:00.000Z',
        promptStatus: 'running',
      },
      {
        kind: 'message',
        id: 'm-1',
        origin: 'send_message',
        turnId: 't-1',
        text: '早安！正在帮你查日程',
        attachments: [],
        deliveredTo: [],
        startedAt: msgAt,
        status: 'sending',
      },
    ];

    expect(blockActivityTimestamp(blocksSending[1]!)).toBe(msgAt);
    expect(latestAgentTimestamp(blocksSending, turnStart)).toBe(msgAt);

    const sigSending = agentOutputSignature(currentTurnScope(blocksSending, turnStart).agentBlocks);
    expect(sigSending).toBe(`m-1:10:sending:${msgAt}`);

    const blocksSent: Block[] = [
      blocksSending[0]!,
      {
        ...(blocksSending[1] as Extract<Block, { kind: 'message' }>),
        status: 'sent',
      },
    ];
    const sigSent = agentOutputSignature(currentTurnScope(blocksSent, turnStart).agentBlocks);
    expect(sigSent).toBe(`m-1:10:sent:${msgAt}`);
    expect(sigSent).not.toBe(sigSending);
  });

  it('does not treat a turn with an in-flight Persona message block as settled', () => {
    const blocks: Block[] = [
      {
        kind: 'user',
        id: 'u-1',
        turnId: 't-1',
        text: 'Check status',
        createdAt: '2026-11-27T08:00:00.000Z',
      },
      {
        kind: 'message',
        id: 'm-1',
        origin: 'send_message',
        turnId: 't-1',
        text: 'Checking...',
        attachments: [],
        deliveredTo: [],
        startedAt: Date.parse('2026-11-27T08:00:03.000Z'),
        status: 'sending',
      },
    ];
    const scope = currentTurnScope(blocks, undefined);
    expect(scope.userBlock?.id).toBe('u-1');
    expect(scope.agentBlocks).toHaveLength(1);
    expect(scope.agentBlocks[0]?.id).toBe('m-1');
  });

  it('advances lastResponseAt across Persona message and subagent activity in useComposerWorking', () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-11-27T08:10:00.000Z');
    vi.setSystemTime(t0 + 2_000);

    const userBlock: Block = {
      kind: 'user',
      id: 'u-cron',
      turnId: 't-cron',
      text: 'Cron wake',
      createdAt: new Date(t0).toISOString(),
      promptStatus: 'running',
    };
    const subagentStarted: Block = {
      kind: 'subagent',
      id: 'sub-1',
      subagentId: 'agent-child-1',
      parentAgentId: 'main',
      parentToolCallId: 'call-1',
      name: 'researcher',
      description: 'Investigate schedules',
      model: undefined,
      thinkingEffort: undefined,
      status: 'running',
      summary: undefined,
      error: undefined,
      startedAt: new Date(t0 + 1_500).toISOString(),
      endedAt: undefined,
      toolCallCount: 0,
      transcript: [],
    };

    const probe = renderWorkingHook({
      busy: true,
      scopeKey: 'session_persona',
      loaded: true,
      blocks: [userBlock, subagentStarted],
      turnStartedAt: t0,
    });

    expect(probe.read().startedAt).toBe(t0);
    expect(probe.read().lastResponseAt).toBe(t0 + 1_500);

    vi.setSystemTime(t0 + 15_000);
    const messageReply: Block = {
      kind: 'message',
      id: 'msg-1',
      origin: 'send_message',
      turnId: 't-cron',
      text: '子任务还在跑，我先汇报进度～',
      attachments: [],
      deliveredTo: [],
      startedAt: t0 + 15_000,
      status: 'sent',
    };
    probe.rerender({
      busy: true,
      scopeKey: 'session_persona',
      loaded: true,
      blocks: [userBlock, subagentStarted, messageReply],
      turnStartedAt: t0,
    });

    expect(probe.read().lastResponseAt).toBe(t0 + 15_000);
  });
});
