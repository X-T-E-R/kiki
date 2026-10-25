import { describe, expect, it } from 'vitest';

import {
  externalBoundaryHookEvent,
  externalHintAlreadyRecorded,
  externalTurnHasModelContent,
} from '#/agent/execution/externalPromptHints';
import type { ContextMessage } from '#/agent/contextMemory/types';

const message = (text: string, origin: ContextMessage['origin'], turnId?: number): ContextMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  toolCalls: [],
  origin,
  ...(turnId === undefined ? {} : { source: { turnId } }),
});

describe('external boundary hook ownership', () => {
  it('recognizes boundary events by name, not harness', () => {
    expect(externalBoundaryHookEvent('UserPromptSubmit')).toBe(true);
    expect(externalBoundaryHookEvent('kiki:codex:SessionStart')).toBe(true);
    expect(externalBoundaryHookEvent('kiki:antigravity:PreInvocation')).toBe(true);
    expect(externalBoundaryHookEvent('kiki:grok:Stop')).toBe(false);
    expect(externalBoundaryHookEvent('PreCompact')).toBe(false);
    expect(externalBoundaryHookEvent('PostCompact')).toBe(false);
  });

  it('treats a stored injection as already recorded without claiming a user quote', () => {
    const history = [
      message('earlier', { kind: 'user' }),
      message('assistant reply', undefined),
      message('remember this', { kind: 'injection', variant: 'memory' }),
      message('the user wrote remember this too', { kind: 'user' }, 4),
    ];
    history[1] = { ...history[1]!, role: 'assistant' };
    expect(externalHintAlreadyRecorded(history, 'remember this', 4)).toBe(true);
    expect(externalHintAlreadyRecorded(history, '[Kiki memory]\nremember this', 4)).toBe(false);
    expect(externalHintAlreadyRecorded(history, 'the user wrote remember this too', 4)).toBe(false);
    expect(externalHintAlreadyRecorded(history, 'Goal (active): land', 4)).toBe(false);
  });

  it('sees model content only after this turn has assistant text or a tool', () => {
    const opened: ContextMessage = { role: 'assistant', content: [], toolCalls: [], source: { turnId: 7 } };
    const reply: ContextMessage = { role: 'assistant', content: [{ type: 'text', text: 'doing it' }], toolCalls: [], source: { turnId: 7 } };
    const tool: ContextMessage = { role: 'tool', content: [{ type: 'text', text: 'file' }], toolCalls: [], toolCallId: 'read-1', source: { turnId: 7 } };
    const other: ContextMessage = { role: 'assistant', content: [{ type: 'text', text: 'older' }], toolCalls: [], source: { turnId: 3 } };
    expect(externalTurnHasModelContent([opened], 7)).toBe(false);
    expect(externalTurnHasModelContent([other, opened], 7)).toBe(false);
    expect(externalTurnHasModelContent([opened, reply], 7)).toBe(true);
    expect(externalTurnHasModelContent([opened, tool], 7)).toBe(true);
  });
});
