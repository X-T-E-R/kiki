import { describe, expect, it } from 'vitest';
import { externalToolDisplay } from '#/agent/execution/externalTurnRecorder';

describe('external tool display', () => {
  it('maps ACP read/edit/diff/execute and Codex command/web/subagent events', () => {
    const event = { type: 'tool.call' as const, toolCallId: 'tool-1', title: 'Tool' };
    expect(externalToolDisplay({ ...event, kind: 'read', locations: [{ path: 'a.ts' }] }))
      .toEqual({ kind: 'file_io', operation: 'read', path: 'a.ts' });
    expect(externalToolDisplay({ ...event, kind: 'edit', locations: [{ path: 'a.ts' }],
      content: [{ type: 'diff', oldText: 'old', newText: 'new' }] }))
      .toEqual({ kind: 'diff', path: 'a.ts', before: 'old', after: 'new' });
    expect(externalToolDisplay({ ...event, kind: 'command', rawInput: { command: 'pwd' } }))
      .toEqual({ kind: 'command', command: 'pwd' });
    expect(externalToolDisplay({ ...event, kind: 'webSearch', rawInput: { query: 'docs' } }))
      .toEqual({ kind: 'search', query: 'docs' });
    expect(externalToolDisplay({ ...event, kind: 'collabAgentToolCall', rawInput: { agent: 'reviewer', prompt: 'inspect' } }))
      .toEqual({ kind: 'agent_call', agent_name: 'reviewer', prompt: 'inspect' });
  });
});
