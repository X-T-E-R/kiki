import { describe, expect, it } from 'vitest';

import {
  admitOptionalCapability,
  namesOptionalCapability,
  optionalCapabilityDocumentKey,
  optionalCapabilityForTool,
  type CapabilityAdmissionInput,
} from '#/app/optionalCapability/admit';

function input(overrides: Partial<CapabilityAdmissionInput> = {}): CapabilityAdmissionInput {
  return {
    allowed: true,
    hostLocked: false,
    defaultOn: true,
    sessionChoice: 'inherit',
    workspaceHardOff: false,
    agentKind: 'main',
    toolsSource: undefined,
    declaredTools: undefined,
    taskTools: undefined,
    unresolved: false,
    ...overrides,
  };
}

describe('admitOptionalCapability', () => {
  it('denies unresolved, host lock, allow-off, and workspace hard-off before the session choice', () => {
    expect(admitOptionalCapability('web', input({ unresolved: true }))).toEqual({ admitted: false, reason: 'origin_unreadable' });
    expect(admitOptionalCapability('browser', input({ allowed: false, hostLocked: true }))).toEqual({ admitted: false, reason: 'host_locked' });
    expect(admitOptionalCapability('memory', input({ allowed: false }))).toEqual({ admitted: false, reason: 'allowed_off' });
    expect(admitOptionalCapability('memory', input({ workspaceHardOff: true, sessionChoice: 'on' }))).toEqual({ admitted: false, reason: 'workspace_off' });
  });

  it('keeps a session off closed for main and opens only a child named by this run', () => {
    expect(admitOptionalCapability('web', input({ sessionChoice: 'off', taskTools: ['WebSearch'] }))).toEqual({ admitted: false, reason: 'session_off' });
    expect(admitOptionalCapability('web', input({ sessionChoice: 'off', agentKind: 'child', taskTools: ['*'] }))).toEqual({ admitted: false, reason: 'session_off' });
    expect(admitOptionalCapability('web', input({ sessionChoice: 'off', agentKind: 'child', taskTools: ['WebSearch'] })).admitted).toBe(true);
    expect(admitOptionalCapability('computer', input({ sessionChoice: 'off', agentKind: 'child', taskTools: ['mcp__*'] })).admitted).toBe(true);
  });

  it('opens inherit plus default-off only for a declared profile or this run, not a lone star or a builtin list', () => {
    expect(admitOptionalCapability('thread', input({ defaultOn: false, declaredTools: ['ThreadSend'], toolsSource: 'builtin-default' }))).toEqual({ admitted: false, reason: 'default_off' });
    expect(admitOptionalCapability('thread', input({ defaultOn: false, declaredTools: ['*'], toolsSource: 'declared' }))).toEqual({ admitted: false, reason: 'default_off' });
    expect(admitOptionalCapability('thread', input({ defaultOn: false, declaredTools: ['ThreadSend'], toolsSource: 'declared' })).admitted).toBe(true);
    expect(admitOptionalCapability('thread', input({ defaultOn: false, taskTools: ['ThreadCreate'] })).admitted).toBe(true);
    expect(admitOptionalCapability('web', input({ defaultOn: true, sessionChoice: 'inherit' })).admitted).toBe(true);
    expect(admitOptionalCapability('browser', input({ sessionChoice: 'on', allowed: true })).admitted).toBe(true);
  });

  it('maps concrete tool names and ignores a star', () => {
    expect(optionalCapabilityForTool('browser__click')).toBe('browser');
    expect(optionalCapabilityForTool('mcp__kiki-computer__screenshot')).toBe('computer');
    expect(optionalCapabilityForTool('mcp__other__tool')).toBeUndefined();
    expect(optionalCapabilityForTool('MemoryWrite')).toBe('memory');
    expect(optionalCapabilityForTool('FetchURL')).toBe('web');
    expect(namesOptionalCapability('web', ['*'])).toBe(false);
    expect(namesOptionalCapability('computer', ['mcp__kiki-computer__*'])).toBe(true);
    expect(optionalCapabilityDocumentKey('local', 's1')).toBe('local\u0000s1');
  });
});
