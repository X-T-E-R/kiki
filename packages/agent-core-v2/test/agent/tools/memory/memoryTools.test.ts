import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IMemoryReadTool, IMemorySearchTool, IMemoryWriteTool, MemoryWriteTool } from '#/agent/tools/memory/memoryTools';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IConfigService } from '#/app/config/config';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

describe('temporary session memory tools', () => {
  it('registers reads but not writes and guards writes even when called directly', async () => {
    const ix = new TestInstantiationService();
    const put = vi.fn();
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { workspaceId: 'example', sessionId: 'temporary', ephemeral: true });
    ix.stub(IAgentMemorySnapshot, { getPersona: () => undefined });
    ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'auto', workspaces: {} }) as T });
    ix.stub(IMemoryStore, { put });
    ix.set(IMemoryWriteTool, new SyncDescriptor(MemoryWriteTool));
    const tools = getAgentToolContributions();
    expect(tools.find((tool) => tool.id === IMemoryWriteTool)?.options.when?.(ix)).toBe(false);
    expect(tools.find((tool) => tool.id === IMemorySearchTool)?.options.when?.(ix)).toBe(true);
    expect(tools.find((tool) => tool.id === IMemoryReadTool)?.options.when?.(ix)).toBe(true);
    const execution = ix.get(IMemoryWriteTool).resolveExecution({
      action: 'create', scope: 'global', type: 'user', title: 'Temporary', body: 'Do not persist', reason: 'Test',
    });
    if (!('execute' in execution)) throw new Error('expected an executable tool');
    const result = await execution.execute({ turnId: 1, toolCallId: 'call', signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
    ix.dispose();
  });
});
