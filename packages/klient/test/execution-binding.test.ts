import { describe, expect, it } from 'vitest';

import { executionBindingWireSchema } from '../src/contract/execution.js';
import { promptExecutionBindingSchema } from '../src/contract/agent/schemas.js';

describe('execution binding wire', () => {
  it('preserves a null effort clear in the common prompt transport contract', () => {
    const input = { execution: { executor: 'native' }, thinking: null };
    expect(promptExecutionBindingSchema.parse(input)).toEqual(input);
    expect(promptExecutionBindingSchema.safeParse({ thinking: '' }).success).toBe(false);
  });

  it('keeps an explicit Kiki MCP injection beside the context selection', () => {
    const parsed = executionBindingWireSchema.parse({
      version: 1,
      selection: { executor: 'agy-cli', overrides: { inject_kiki_mcp: false, kiki_context: ['memory'] } },
      effective: { kiki_context: ['memory'], allow_kiki_subagents: true, inject_kiki_mcp: false },
      sources: { inject_kiki_mcp: 'session', kiki_context: 'session', allow_kiki_subagents: 'profile' },
      generation: 2,
    });
    expect(parsed.effective.inject_kiki_mcp).toBe(false);
    expect(parsed.effective.kiki_context).toEqual(['memory']);
    expect(parsed.selection.overrides?.inject_kiki_mcp).toBe(false);
    expect(parsed.sources['inject_kiki_mcp']).toBe('session');
  });

  it('accepts a binding that inherits Kiki MCP injection', () => {
    const parsed = executionBindingWireSchema.parse({
      version: 1,
      selection: { executor: 'agy-cli' },
      effective: { kiki_context: [], allow_kiki_subagents: false },
      sources: { inject_kiki_mcp: 'harness-default' },
      generation: 1,
    });
    expect(parsed.effective.inject_kiki_mcp).toBeUndefined();
    expect(parsed.sources['inject_kiki_mcp']).toBe('harness-default');
  });
});
