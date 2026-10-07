import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextRebuildService } from '#/agent/contextRebuild/contextRebuild';
import { AgentContextRebuildService } from '#/agent/contextRebuild/contextRebuildService';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';

import type { McpSessionCapability } from '#/agent/mcp/mcp';

describe('AgentContextRebuildService', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  it('refreshes MCP capabilities after source reload and reports a newly admitted server', async () => {
    const order: string[] = [];
    const base = capability('base', 'off');
    const late = capability('late');
    let current: readonly McpSessionCapability[] = [base];
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentScopeContext, {
          agentId: 'main',
          scope: () => 'agent',
        });
        reg.definePartialInstance(IAgentLoopService, {
          tryAcquireQuiescence: () => toDisposable(() => {}),
        });
        reg.definePartialInstance(IAgentContextInjectorService, {
          reconcileAllAtSafeBoundary: async () => undefined,
        });
        reg.definePartialInstance(IAgentContextMemoryService, { get: () => [] });
        reg.definePartialInstance(IAgentProfileService, {
          data: () => ({ boundProfile: undefined, systemPrompt: '' } as ReturnType<IAgentProfileService['data']>),
          getPromptFieldSnapshot: () => ({} as ReturnType<IAgentProfileService['getPromptFieldSnapshot']>),
          rebuildPromptContext: async () => undefined,
        });
        reg.definePartialInstance(IAgentLLMRequesterService, {
          invalidatePromptSnapshots: () => 0,
        });
        reg.definePartialInstance(IAgentPluginService, {
          refreshSessionStartAtSafeBoundary: async () => { order.push('plugins'); },
        });
        reg.definePartialInstance(ISessionPluginUsageService, {
          read: async () => ({ workspaceId: 'workspace', sessionId: 'session', revision: 1, overrides: { disabled: false }, applyState: 'applied', errors: [] }),
        });
        reg.definePartialInstance(ISessionAgentProfileCatalog, {
          reload: async () => undefined,
        });
        reg.definePartialInstance(ISessionSkillCatalog, {
          ready: Promise.resolve(),
          catalog: { listSkills: () => [] } as unknown as ISessionSkillCatalog['catalog'],
          reload: async () => undefined,
        });
        reg.definePartialInstance(ISessionContextSourceReloader, {
          reload: async () => {
            order.push('sources');
            return { instructionsChanged: false, pluginsChanged: false };
          },
        });
        reg.definePartialInstance(IAgentMcpService, {
          list: () => [],
          resolved: () => undefined,
          listMcpSessionCapabilities: async () => current,
          refreshCapabilities: async () => {
            order.push('mcp');
            current = [base, late];
          },
        });
        reg.define(IAgentContextRebuildService, AgentContextRebuildService);
      },
    });

    const result = await ix.get(IAgentContextRebuildService).rebuild();

    expect(order).toEqual(['sources', 'plugins', 'mcp']);
    expect(result.readiness.plugins).toEqual({ state: 'ready', errors: [] });
    expect(result.readiness.mcp).toEqual([
      { runtimeName: 'base', connection: 'disabled' },
      { runtimeName: 'late', connection: 'connected' },
    ]);
    expect(result.rebuilt).toContain('mcp');
    expect(result.changed).toBe(true);
    expect(result.changes.mcp).toBe(true);
    expect(current[0]?.override).toBe('off');
  });
});

function capability(
  runtimeName: string,
  override: McpSessionCapability['override'] = 'inherit',
): McpSessionCapability {
  return {
    locator: { source: 'global', name: runtimeName },
    runtimeName,
    origin: 'global',
    config: { transport: 'stdio', command: `${runtimeName}-mcp` },
    authStatus: 'not-applicable',
    connection: override === 'off' ? 'disabled' : 'connected',
    override,
  };
}
