import { describe, expect, it } from 'vitest';

import {
  admitOptionalCapability,
  admitSendMessageCapability,
  capabilityToolsSource,
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
    expect(admitOptionalCapability('computer', input({ sessionChoice: 'off', agentKind: 'child', taskTools: ['mcp__*'] })).admitted).toBe(false);
    expect(admitOptionalCapability('computer', input({ sessionChoice: 'off', agentKind: 'child', taskTools: ['mcp__*'], computerServers: ['kiki-computer'] })).admitted).toBe(true);
  });

  it('opens inherit plus default-off only for a declared profile or this run, not a lone star or a builtin list', () => {
    expect(admitOptionalCapability('thread', input({ defaultOn: false, declaredTools: ['ThreadSend'], toolsSource: 'builtin-default' }))).toEqual({ admitted: false, reason: 'default_off' });
    expect(admitOptionalCapability('thread', input({ defaultOn: false, declaredTools: ['*'], toolsSource: 'declared' }))).toEqual({ admitted: false, reason: 'default_off' });
    expect(admitOptionalCapability('thread', input({ defaultOn: false, declaredTools: ['ThreadSend'], toolsSource: 'declared' })).admitted).toBe(true);
    expect(admitOptionalCapability('thread', input({ defaultOn: false, taskTools: ['ThreadCreate'] })).admitted).toBe(false);
    expect(admitOptionalCapability('web', input({ defaultOn: true, sessionChoice: 'inherit' })).admitted).toBe(true);
    expect(admitOptionalCapability('browser', input({ sessionChoice: 'on', allowed: true })).admitted).toBe(true);
  });

  it('keeps SendMessage default-off non-hard-denied and lets message delivery imply it unless explicitly off', () => {
    const policy = {
      admit: (_id: 'send_message', request: { sessionId: string }) => request.sessionId === 'blocked'
        ? { admitted: false, reason: 'allowed_off' as const }
        : { admitted: false, reason: 'default_off' as const },
      choice: () => 'inherit' as const,
      globalState: () => ({ allowed: true, hostLocked: false, unresolved: false }),
    };
    expect(admitOptionalCapability('send_message', input({ defaultOn: false }))).toEqual({ admitted: false, reason: 'default_off' });
    expect(admitSendMessageCapability(policy, { sessionId: 's1', workspaceId: 'w' }, 'reply')).toEqual({ admitted: false, reason: 'default_off' });
    expect(admitSendMessageCapability(policy, { sessionId: 's1', workspaceId: 'w' }, 'message')).toEqual({ admitted: true, reason: 'admitted' });
    const off = { ...policy, choice: () => 'off' as const };
    expect(admitSendMessageCapability(off, { sessionId: 's1', workspaceId: 'w' }, 'message')).toEqual({ admitted: false, reason: 'session_off' });
    expect(admitSendMessageCapability(policy, { sessionId: 'blocked', workspaceId: 'w' }, 'message')).toEqual({ admitted: false, reason: 'allowed_off' });
  });

  it('maps concrete tool names and ignores a star', () => {
    expect(optionalCapabilityForTool('SendMessage')).toBe('send_message');
    expect(optionalCapabilityForTool('SendUserMessage')).toBe('send_message');
    expect(namesOptionalCapability('send_message', ['SendMessage'])).toBe(true);
    expect(optionalCapabilityForTool('browser__click')).toBe('browser');
    expect(optionalCapabilityForTool('mcp__kiki-computer__screenshot')).toBeUndefined();
    expect(optionalCapabilityForTool('mcp__kiki-computer__screenshot', ['kiki-computer'])).toBe('computer');
    expect(optionalCapabilityForTool('mcp__desktop__screenshot', ['desktop'])).toBe('computer');
    expect(optionalCapabilityForTool('mcp__other__tool', ['desktop'])).toBeUndefined();
    expect(optionalCapabilityForTool('MemoryWrite')).toBe('memory');
    expect(optionalCapabilityForTool('FetchURL')).toBe('web');
    for (const name of ['RoomRead', 'RoomAdd']) {
      expect(optionalCapabilityForTool(name)).toBe('thread');
      expect(namesOptionalCapability('thread', [name])).toBe(true);
      expect(admitOptionalCapability('thread', input({ sessionChoice: 'off', declaredTools: [name], toolsSource: 'declared' })).admitted).toBe(false);
    }
    expect(namesOptionalCapability('web', ['*'])).toBe(false);
    expect(namesOptionalCapability('computer', ['*'], ['desktop'])).toBe(false);
    expect(namesOptionalCapability('computer', ['mcp__kiki-computer__*'])).toBe(false);
    expect(namesOptionalCapability('computer', ['mcp__desktop__*'], ['desktop'])).toBe(true);
    expect(namesOptionalCapability('computer', ['mcp__kiki-windows-mcp__Screenshot'], ['kiki-windows-mcp'])).toBe(true);
    expect(namesOptionalCapability('computer', ['mcp__kiki-windows-mcp__*'], ['kiki-windows-mcp'])).toBe(true);
    expect(namesOptionalCapability('computer', ['mcp__kiki-computer__click'], ['kiki-windows-mcp'])).toBe(false);
    expect(optionalCapabilityForTool('mcp__kiki-windows-mcp__Click', ['kiki-windows-mcp'])).toBe('computer');
  });

  it('treats only a clean shipped default profile as the builtin list', () => {
    const clean = 'C:/kiki/agents/builtin/agent.md';
    const profile = { name: 'agent', sourcePath: clean, definitionId: clean };
    const edited = { name: 'agent', sourcePath: 'C:/kiki/agents/builtin/agent.md', definitionId: 'C:/kiki/agents/builtin/agent.md' };
    const isClean = (path: string) => path === clean;
    const shipped = { ...profile, tools: ['MemoryRead', 'WebSearch'], fileDefinition: { tools: ['MemoryRead', 'WebSearch'] } };
    expect(capabilityToolsSource('declared', profile, isClean)).toBe('builtin-default');
    expect(capabilityToolsSource('declared', shipped, isClean)).toBe('builtin-default');
    expect(capabilityToolsSource('declared', { ...shipped, tools: ['MemoryRead'] }, isClean)).toBe('declared');
    expect(capabilityToolsSource('declared', { ...edited, sourcePath: 'C:/project/agents/agent.md' }, isClean)).toBe('declared');
    expect(capabilityToolsSource('declared', { name: 'memory-named', sourcePath: clean }, isClean)).toBe('declared');
    expect(capabilityToolsSource('inherited-default', profile, isClean)).toBe('inherited-default');
    expect(capabilityToolsSource('builtin-default', undefined, isClean)).toBe('builtin-default');
  });

  it('encodes host and session identities as distinct portable document names', () => {
    const identities = [
      ['local', 'session_example'],
      ['LOCAL', 'session_example'],
      ['a\u0000b', 'c'],
      ['a', 'b\u0000c'],
      ['../host:*?', '../session\\name'],
      ['本机', '会话'],
    ] as const;
    const keys = identities.map(([host, session]) => optionalCapabilityDocumentKey(host, session));
    expect(new Set(keys).size).toBe(identities.length);
    for (const [index, key] of keys.entries()) {
      expect(key).toMatch(/^v1-[0-9a-f]+\.json$/);
      expect(JSON.parse(Buffer.from(key.slice(3, -5), 'hex').toString('utf8'))).toEqual(identities[index]);
    }
  });
});
