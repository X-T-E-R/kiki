import { describe, expect, it } from 'vitest';

import {
  externalBoundaryHookEvent,
  externalHintAlreadyRecorded,
  externalPromptHints,
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
  it('keeps Space from an oversized runtime snapshot inside the legacy hint budget', () => {
    const space = '## Space\nKiki home (server host): "C:/spaces/design"';
    const snapshot = { ...message(`<system-reminder>\nHost runtime snapshot rev 2.\n\n${space}\n\n## Available skills\n${'x'.repeat(9_000)}\n</system-reminder>`, { kind: 'injection', variant: 'runtime_snapshot' }), id: 'runtime-2' };
    const hints = externalPromptHints([snapshot], new Set(), true);
    expect(hints.map((hint) => hint.text).join('\n')).toContain(space);
    expect(Buffer.byteLength(hints.map((hint) => hint.text).join(''), 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(externalPromptHints([snapshot], new Set(['runtime-2']), true)).toEqual([]);
  });

  it('omits Space when workspace_info is excluded but retains other snapshot sections', () => {
    const snapshot = message('Host runtime snapshot rev 2.\n\n## Space\nKiki home (server host): "private-home"\n\n## Runtime/workspace\nWorking directory: /work', { kind: 'injection', variant: 'runtime_snapshot' });
    const text = externalPromptHints([snapshot], new Set(), false).map((hint) => hint.text).join('\n');
    expect(text).not.toContain('private-home');
    expect(text).toContain('Working directory: /work');
    expect(externalPromptHints([message('## Space\nprivate-home', { kind: 'injection', variant: 'runtime_snapshot' })], new Set(), false)).toEqual([]);
  });
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
