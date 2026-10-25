import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentContextRebuildService } from '#/agent/contextRebuild/contextRebuild';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { sessionServices, testAgent, type TestAgentContext } from '../../harness';

const agents: TestAgentContext[] = [];
let promptBody = 'BINDING_V1_ONLY';
let prepareFailure: Error | undefined;

afterEach(async () => {
  promptBody = 'BINDING_V1_ONLY';
  prepareFailure = undefined;
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
});

describe('context rebuild across a real profile bind', () => {
  it('keeps the previous binding when profile preparation fails before commit', async () => {
    const { ctx, profile, kept } = await boundAgent();
    prepareFailure = new Error('profile prepare failed');
    await expect(ctx.get(IAgentContextRebuildService).rebuild()).rejects.toThrow('profile prepare failed');
    const report = ctx.get(IAgentContextRebuildService).control();
    expect(report.outcome).not.toBe('applied');
    expect(report.rebuilt).not.toContain('profile');
    expect(report.rebuilt).not.toContain('prompt_fields');
    expect(report.changes?.profile).not.toBe(true);
    expect(profile.data().systemPrompt).toBe(kept.prompt);
    expect(profile.data().systemPrompt).toContain('BINDING_V1_ONLY');
    expect(profile.getModel()).toBe(kept.model);
    expect(profile.data().thinkingLevel).toBe('off');
    expect([...(profile.data().disallowedTools ?? [])]).toEqual(kept.denies);
    expect(ctx.get(IAgentPermissionModeService).mode).toBe(kept.permission);
    expect(profile.data().permissionMode).toBe(kept.profilePermission);
    ctx.mockNextResponse({ type: 'text', text: 'still the old binding' });
    await ctx.get(IAgentLLMRequesterService).request({ tools: [] });
    const sent = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(sent).toContain('BINDING_V1_ONLY');
    expect(sent).not.toContain('BINDING_V2_ONLY');
    expect(sent).toContain(profile.data().systemPrompt);
  }, 30_000);

  it('reports a partial rebuild when the profile commits and MCP refresh then fails', async () => {
    const { ctx, profile, kept } = await boundAgent();
    promptBody = 'BINDING_V2_ONLY';
    vi.spyOn(ctx.get(IAgentMcpService), 'refreshCapabilities').mockRejectedValue(new Error('mcp catalog failed'));
    await expect(ctx.get(IAgentContextRebuildService).rebuild()).rejects.toThrow('mcp catalog failed');
    const report = ctx.get(IAgentContextRebuildService).control();
    expect(report.outcome).toBe('partial');
    expect(report.error).toBe('mcp catalog failed');
    expect(report.rebuilt).toContain('profile');
    expect(report.rebuilt).toContain('prompt_fields');
    expect(report.rebuilt).not.toContain('mcp');
    expect(report.rebuilt).not.toContain('injections');
    expect(report.changes?.profile).toBe(true);
    expect(report.changes?.mcp).toBe(false);
    expect(profile.data().systemPrompt).toContain('BINDING_V2_ONLY');
    expect(profile.data().systemPrompt).not.toContain('BINDING_V1_ONLY');
    expect(profile.getModel()).toBe(kept.model);
    expect(profile.data().thinkingLevel).toBe('off');
    expect([...(profile.data().disallowedTools ?? [])]).toEqual(kept.denies);
    expect(ctx.get(IAgentPermissionModeService).mode).toBe(kept.permission);
    expect(profile.data().permissionMode).toBe(kept.profilePermission);
    ctx.mockNextResponse({ type: 'text', text: 'uses the committed profile' });
    await ctx.get(IAgentLLMRequesterService).request({ tools: [] });
    const sent = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(sent).toContain('BINDING_V2_ONLY');
    expect(sent).not.toContain('BINDING_V1_ONLY');
    expect(sent).toContain(profile.data().systemPrompt);
    expect(profile.data().systemPrompt).toBe(profile.getSystemPrompt());
  }, 30_000);
});

async function boundAgent() {
  const ctx = testAgent(sessionServices((reg) => {
    reg.defineInstance(ISessionContextSourceReloader, {
      _serviceBrand: undefined,
      reload: async () => ({ instructionsChanged: false, pluginsChanged: false }),
    });
  }));
  agents.push(ctx);
  const catalog = ctx.get(ISessionAgentProfileCatalog);
  const realGet = catalog.get.bind(catalog);
  const realDefault = catalog.getDefault.bind(catalog);
  const projected = (live: AgentProfile): AgentProfile => {
    const { systemPrompt: _systemPrompt, renderSystemPrompt: _renderSystemPrompt, ...rest } = live;
    return normalizeAgentProfile({
      ...rest,
      thinkingEffort: 'off',
      systemPrompt: () => {
        if (prepareFailure !== undefined) throw prepareFailure;
        return promptBody;
      },
    });
  };
  vi.spyOn(catalog, 'get').mockImplementation((name) => {
    const live = realGet(name);
    if (live === undefined || name !== DEFAULT_AGENT_PROFILE_NAME) return live;
    return projected(live);
  });
  vi.spyOn(catalog, 'getDefault').mockImplementation(() => projected(realDefault()));
  const profile = ctx.get(IAgentProfileService);
  await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'mock-model', thinking: 'off' });
  const kept = {
    model: profile.getModel(),
    prompt: profile.data().systemPrompt,
    denies: [...(profile.data().disallowedTools ?? [])],
    permission: ctx.get(IAgentPermissionModeService).mode,
    profilePermission: profile.data().permissionMode,
  };
  expect(kept.prompt).toContain('BINDING_V1_ONLY');
  expect(profile.data().thinkingLevel).toBe('off');
  return { ctx, profile, kept };
}
