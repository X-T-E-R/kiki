import { describe, expect, it } from 'vitest';

import { delegationProcedure } from '../src/procedures/externalDelegation.js';

describe('delegation dispatch title', () => {
  const dispatch = delegationProcedure('dispatch');

  it('accepts a title for a named child and passes it through the MCP codec', () => {
    const input = { target: 'named' as const, taskName: 'chat_1', profileName: 'support', title: 'Customer group', message: 'hi' };
    expect(dispatch.inputSchema.parse(input).title).toBe('Customer group');
    const wire = dispatch.mcp.input.encode({ ...input, dispatchKey: 'k' });
    expect((wire as Record<string, unknown>)['title']).toBe('Customer group');
    expect(dispatch.mcp.input.decode(wire as Parameters<typeof dispatch.mcp.input.decode>[0]).title).toBe('Customer group');
  });

  it('refuses a title for the main agent and an over-long title', () => {
    expect(() => dispatch.inputSchema.parse({ target: 'main', title: 'x', message: 'hi' })).toThrow(/Named-child fields require target named/);
    expect(() => dispatch.inputSchema.parse({ target: 'named', taskName: 'a', title: 'x'.repeat(121), message: 'hi' })).toThrow();
  });
});
