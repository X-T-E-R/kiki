import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { IAgentToolSelectSchemasService } from '#/agent/toolSelect/toolSelectSchemas';
import { IAgentProfileCapabilityChangesService } from '#/agent/toolSelect/profileCapabilityChanges';
import { IAgentCapabilityRebuildService } from '#/agent/capabilityRebuild/capabilityRebuild';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { THREAD_COMMUNICATION_SECTION } from '#/app/threadCommunication/configSection';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { SessionAgentProfileCatalogService } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { SessionSkillCatalogService } from '#/session/sessionSkillCatalog/skillCatalogService';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import '#/agent/tools/select-tools/selectToolsTool';

import { appService, createTestAgent, type TestAgentContext } from '../../harness';

const MCP_ALPHA = 'mcp__srv__alpha';
const DASHBOARD_TOOL = 'dashboard_create';
const OPENAI_PROVIDER = {
  type: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.test/v1',
  model: 'mock-openai-model',
} as const;

const DISCLOSURE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
  dynamically_loaded_tools: true,
} as const;

const PREFIX_PROTOCOL_CASES = [
  {
    name: 'deepseek-chat',
    provider: {
      type: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-chat',
    },
  },
  {
    name: 'k3',
    provider: {
      type: 'kimi',
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'kimi-k3',
    },
  },
  {
    name: 'gpt',
    provider: {
      type: 'openai_responses',
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'gpt-5',
    },
  },
] as const;

type WireEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[wire]' }
>;

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  readonly description: string;
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  };
  calls = 0;

  constructor(readonly name: string) {
    this.description = `${name} desc`;
  }

  resolveExecution(): ToolExecution {
    return {
      description: `stub ${this.name}`,
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: 'mcp ok' };
      },
    };
  }
}

function wireEvents(ctx: TestAgentContext, eventName: string): readonly WireEvent[] {
  return ctx.allEvents.filter(
    (event): event is WireEvent => event.type === '[wire]' && event.event === eventName,
  );
}

function selectToolsCall(id: string, names: readonly string[]) {
  return {
    type: 'function' as const,
    id,
    name: 'SelectTools',
    arguments: JSON.stringify({ names }),
  };
}

function toolNames(tools: readonly { readonly name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function historyText(history: readonly ContextMessage[]): string {
  return history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

describe('progressive tool disclosure end-to-end', () => {
  let ctx: TestAgentContext;
  let alpha: StubMcpTool;
  let registration: { dispose(): void } | undefined;

  beforeEach(async () => {
    vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
    ctx = createTestAgent();
    ctx.get(IAgentToolSelectService);
    ctx.get(IAgentToolSelectAnnouncementsService);
    ctx.get(IAgentToolSelectSchemasService);
    ctx.get(IAgentToolExecutorService);
    ctx.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    alpha = new StubMcpTool(MCP_ALPHA);
    registration = ctx.get(IAgentToolRegistryService).register(alpha, { source: 'mcp' });
  });

  afterEach(async () => {
    registration?.dispose();
    vi.unstubAllEnvs();
    await ctx.dispose();
  });

  it('exposes no discovery controls when no deferred tool is active', async () => {
    registration?.dispose();
    registration = undefined;
    ctx.configure({ provider: OPENAI_PROVIDER, modelCapabilities: DISCLOSURE_CAPABILITIES, tools: ['Read', 'Bash'] });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_bridge_1',
      name: 'CallTool',
      arguments: JSON.stringify({ name: MCP_ALPHA, arguments: {} }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try an MCP tool' }] });
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(historyText(firstWire.history)).not.toContain('<tools_added>');
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      `Unknown tool: ${MCP_ALPHA}. Pick from the latest announced tools list.`,
    );
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'This tool was not loaded or is no longer available.',
    );
    expect(alpha.calls).toBe(0);
    expect(toolNames(firstWire.tools)).not.toContain('SelectTools');
    expect(toolNames(firstWire.tools)).not.toContain('CallTool');
  });

  it('keeps plan tools resident without an MCP server or plugin', async () => {
    registration?.dispose();
    registration = undefined;
    ctx.mockNextResponse({ type: 'text', text: 'plan tools are resident' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'inspect the available plan tools' }] });
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).toContain('EnterPlanMode');
    expect(toolNames(firstWire.tools)).toContain('ExitPlanMode');
    expect(toolNames(firstWire.tools)).not.toContain('SelectTools');
    expect(historyText(firstWire.history)).not.toContain('<tools_added>');
  });

  it('announces the manifest, loads by name, keeps the top-level table byte-stable, and dispatches on the next step', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_alpha_1',
      name: MCP_ALPHA,
      arguments: JSON.stringify({ query: 'moon' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try the srv alpha tool' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).toContain('SelectTools');
    const announcementText = firstWire.history
      .map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      )
      .join('\n');
    expect(announcementText).toContain('<tools_added>');
    expect(announcementText).toContain(MCP_ALPHA);

    const requests = wireEvents(ctx, 'llm.request').filter(
      (event) => (event.args as { kind?: string }).kind === 'loop',
    );
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect((request.args as { toolSelect?: boolean }).toolSelect).toBe(true);
    }

    const secondWire = ctx.llmCalls[1]!;
    const schemaMessages = secondWire.history.filter(
      (message) => message.tools?.some((tool) => tool.name === MCP_ALPHA),
    );
    expect(schemaMessages).toHaveLength(1);

    const alphaFromSchema = schemaMessages[0]!.tools!.find((tool) => tool.name === MCP_ALPHA)!;
    expect(alphaFromSchema.parameters).toEqual(alpha.parameters);

    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(wireEvents(ctx, 'llm.tools_snapshot')).toHaveLength(1);

    expect(alpha.calls).toBe(1);
  });

  it('routes a loaded MCP tool through CallTool and rejects the bridge before selection', async () => {
    ctx.configure({ provider: OPENAI_PROVIDER, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_bridge_early',
      name: 'CallTool',
      arguments: JSON.stringify({ name: MCP_ALPHA, arguments: { query: 'moon' } }),
    });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_bridge_loaded',
      name: 'CallTool',
      arguments: JSON.stringify({ name: MCP_ALPHA, arguments: { query: 'moon' } }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'call srv alpha' }] });
    await ctx.untilTurnEnd();

    expect(toolNames(ctx.llmCalls[0]!.tools)).toContain('CallTool');
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'This tool was not loaded or is no longer available.',
    );
    expect(ctx.llmCalls[2]!.tools).toEqual(ctx.llmCalls[0]!.tools);
    expect(historyText(ctx.llmCalls[2]!.history)).toContain('<dynamic_tool_schemas>');
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain('mcp ok');
    expect(alpha.calls).toBe(1);
  });

  it('keeps a user tool resident when its metadata says deferred', async () => {
    ctx.get(IAgentUserToolService).register({
      name: DASHBOARD_TOOL,
      description: 'Create a dashboard.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      disclosure: 'deferred',
    });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_dashboard_1',
      name: DASHBOARD_TOOL,
      arguments: JSON.stringify({ title: 'Operations' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'create a dashboard' }] });
    await ctx.untilToolCall({ output: 'dashboard-created' });
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).toContain(DASHBOARD_TOOL);
    expect(historyText(firstWire.history)).not.toContain(`${DASHBOARD_TOOL} —`);
    expect(ctx.llmCalls[1]!.tools).toEqual(firstWire.tools);
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'dashboard-created',
    );
  });

  it.each(PREFIX_PROTOCOL_CASES)('keeps the system and tools prefix stable for $name', async ({ provider }) => {
    registration?.dispose();
    registration = undefined;
    ctx.configure({
      provider,
      modelCapabilities: DISCLOSURE_CAPABILITIES,
      tools: ['EnterPlanMode', 'ExitPlanMode'],
    });
    ctx.mockNextResponse({ type: 'text', text: 'first response' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prefix check' }] });
    await ctx.untilTurnEnd();
    ctx.mockNextResponse({ type: 'text', text: 'second response' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prefix check' }] });
    await ctx.untilTurnEnd();

    const calls = wireEvents(ctx, 'llm.request');
    const snapshots = wireEvents(ctx, 'llm.tools_snapshot');
    expect(calls).toHaveLength(2);
    expect(snapshots).toHaveLength(1);
    const firstRequest = calls[0]!.args as { systemPromptHash?: string; toolsHash?: string };
    const secondRequest = calls[1]!.args as { systemPromptHash?: string; toolsHash?: string };
    expect(firstRequest.systemPromptHash).toBe(secondRequest.systemPromptHash);
    expect(firstRequest.toolsHash).toBe(secondRequest.toolsHash);
    expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
  });

  it.each(PREFIX_PROTOCOL_CASES)('preserves $name prefix across identical MCP reconnect; announces a changed set', async ({ provider }) => {
    ctx.configure({ provider, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    registration?.dispose();
    registration = ctx.get(IAgentToolRegistryService).register(new StubMcpTool(MCP_ALPHA), { source: 'mcp' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();
    const [first, second] = wireEvents(ctx, 'llm.request').map((event) => event.args as { systemPromptHash?: string; toolsHash?: string });
    expect(second!.systemPromptHash).toBe(first!.systemPromptHash);
    expect(second!.toolsHash).toBe(first!.toolsHash);
    expect(historyText(ctx.llmCalls[1]!.history).match(/<tools_added>/g)).toHaveLength(1);
    expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);

    const extra = ctx.get(IAgentToolRegistryService).register(new StubMcpTool('mcp__srv__beta'), { source: 'mcp' });
    try {
      ctx.mockNextResponse({ type: 'text', text: 'third' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third' }] });
      await ctx.untilTurnEnd();
      expect(historyText(ctx.llmCalls[2]!.history)).toContain('mcp__srv__beta —');
      expect(historyText(ctx.llmCalls[2]!.history).match(/<tools_added>/g)).toHaveLength(2);
      expect(ctx.llmCalls[2]!.tools).toEqual(ctx.llmCalls[0]!.tools);
    } finally { extra.dispose(); }
  });

  it.each(PREFIX_PROTOCOL_CASES)('announces one new plugin tool on $name, not an identical re-registration', async ({ provider }) => {
    ctx.configure({ provider, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    const name = 'plugin__demo__create';
    let plugin = ctx.get(IAgentToolRegistryService).register(new StubMcpTool(name), { source: 'plugin' });
    try {
      ctx.mockNextResponse({ type: 'text', text: 'second' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
      await ctx.untilTurnEnd();
      const added = historyText(ctx.llmCalls[1]!.history);
      expect(added.match(/<tools_added>/g)).toHaveLength(2);
      expect(added.split('<tools_added>')[2]).toContain(`${name} —`);
      expect(added.split('<tools_added>')[2]).not.toContain(MCP_ALPHA);
      expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
      plugin.dispose();
      plugin = ctx.get(IAgentToolRegistryService).register(new StubMcpTool(name), { source: 'plugin' });
      ctx.mockNextResponse({ type: 'text', text: 'third' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third' }] });
      await ctx.untilTurnEnd();
      expect(historyText(ctx.llmCalls[2]!.history).match(/<tools_added>/g)).toHaveLength(2);
    } finally { plugin.dispose(); }
  });

  it.each(PREFIX_PROTOCOL_CASES)('coalesces effective profile skill changes on $name, ignoring unchanged content', async ({ provider }) => {
    ctx.get(IAgentProfileCapabilityChangesService);
    ctx.configure({ provider, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    const catalog = ctx.get(ISessionSkillCatalog) as SessionSkillCatalogService;
    const skill = { name: 'hot-update', description: 'Hot update.', path: '/tmp/hot-update/SKILL.md',
      dir: '/tmp/hot-update', content: 'Updated skill body', source: 'project' as const, metadata: {} };
    catalog.set('profile-watch', { skills: [skill] }, { priority: 50 });
    catalog.set('profile-watch', { skills: [skill] }, { priority: 50 });
    await vi.waitFor(() => {
      expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'profile_capabilities_changed')).toHaveLength(1);
    }, { timeout: 2_500 });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();
    const history = ctx.get(IAgentContextMemoryService).get();
    const notice = history.findIndex((message) => message.origin?.kind === 'injection' && message.origin.variant === 'profile_capabilities_changed');
    const user = history.findIndex((message) => message.origin?.kind === 'user' && historyText([message]).includes('second'));
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(user);
    expect(historyText(ctx.llmCalls[1]!.history)).toContain('Available profile capabilities changed');
    expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
    const requests = wireEvents(ctx, 'llm.request');
    expect((requests[1]!.args as { systemPromptHash?: string }).systemPromptHash)
      .toBe((requests[0]!.args as { systemPromptHash?: string }).systemPromptHash);
    catalog.set('profile-watch', { skills: [skill] }, { priority: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'profile_capabilities_changed')).toHaveLength(1);
  });

  it('coalesces repeated skill edits into one notice until the next user turn', async () => {
    ctx.get(IAgentProfileCapabilityChangesService);
    ctx.configure({ provider: OPENAI_PROVIDER, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    const catalog = ctx.get(ISessionSkillCatalog) as SessionSkillCatalogService;
    const skill = { name: 'rapid-edit', description: 'Rapid edit.', path: '/tmp/rapid/SKILL.md',
      dir: '/tmp/rapid', content: 'one', source: 'project' as const, metadata: {} };
    catalog.set('rapid', { skills: [skill] }, { priority: 50 });
    catalog.set('rapid', { skills: [{ ...skill, content: 'two' }] }, { priority: 50 });
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    const notices = () => ctx.get(IAgentContextMemoryService).get().filter((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'profile_capabilities_changed');
    expect(notices()).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();
    catalog.set('rapid', { skills: [{ ...skill, content: 'three' }] }, { priority: 50 });
    expect(notices()).toHaveLength(2);
  });

  it.each(PREFIX_PROTOCOL_CASES)('announces only usable subagent profile changes on $name', async ({ provider }) => {
    ctx.get(IAgentProfileCapabilityChangesService);
    ctx.configure({ provider, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    const catalog = ctx.get(ISessionAgentProfileCatalog) as SessionAgentProfileCatalogService;
    const worker = normalizeAgentProfile({ name: 'hot-worker', systemPrompt: () => 'Work on this task.' });
    catalog.setContribution('hot-profile', { profiles: [worker] }, 50);
    await vi.waitFor(() => {
      expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'profile_capabilities_changed')).toHaveLength(1);
    }, { timeout: 2_500 });
    const hidden = normalizeAgentProfile({ name: 'hidden-worker', private: true, systemPrompt: () => 'Internal.' });
    catalog.setContribution('hot-profile', { profiles: [worker, hidden] }, 50);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'profile_capabilities_changed')).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
  });

  it.each(PREFIX_PROTOCOL_CASES)('rebuilds memory and Thread once on the next $name user turn, not mid-turn', async ({ provider }) => {
    ctx.get(IAgentCapabilityRebuildService);
    ctx.configure({ provider, modelCapabilities: DISCLOSURE_CAPABILITIES });
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const registration = ctx.get(IAgentToolRegistryService).register({
      name: 'test_gate', description: 'Block this test turn.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({ approvalRule: 'test_gate', execute: async () => { start(); await gate; return { output: 'created' }; } }),
    });
    ctx.mockNextResponse({ type: 'function', id: 'call_gate', name: 'test_gate', arguments: '{}' });
    ctx.mockNextResponse({ type: 'text', text: 'first done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await started;
    const config = ctx.get(IConfigService);
    await config.replace(MEMORY_SECTION, { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} } satisfies MemoryConfig);
    await config.replace(THREAD_COMMUNICATION_SECTION, { enabled: true });
    const session = ctx.get(ISessionContext);
    const threadDuringTurn = ctx.get(ICapabilitySnapshotService).threadEnabled(session.workspaceId, session.sessionId);
    release();
    expect(threadDuringTurn).toBe(false);
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
    expect(toolNames(ctx.llmCalls[1]!.tools)).not.toContain('ThreadList');
    expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'capabilities_rebuilt')).toHaveLength(0);
    ctx.mockNextResponse({ type: 'text', text: 'next done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'next' }] });
    await ctx.untilTurnEnd();
    registration.dispose();
    expect(toolNames(ctx.llmCalls[2]!.tools)).toContain('ThreadList');
    expect(toolNames(ctx.llmCalls[2]!.tools)).toContain('MemorySearch');
    const notices = ctx.get(IAgentContextMemoryService).get().filter((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'capabilities_rebuilt');
    expect(notices).toHaveLength(1);
    expect(historyText(notices)).toContain('memory, thread communication');
    const requests = wireEvents(ctx, 'llm.request').map((event) => event.args as { toolsHash?: string });
    expect(requests[1]!.toolsHash).toBe(requests[0]!.toolsHash);
    expect(requests[2]!.toolsHash).not.toBe(requests[1]!.toolsHash);
  });

  it('keeps session A frozen while session B advances at its own user boundary', async () => {
    ctx.configure({ provider: OPENAI_PROVIDER, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.get(IAgentCapabilityRebuildService);
    const capabilities = ctx.get(ICapabilitySnapshotService);
    const config = ctx.get(IConfigService);
    const b = createTestAgent(
      { sessionId: 'test-session-b' },
      appService(IConfigService, config),
      appService(ICapabilitySnapshotService, capabilities),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const registration = ctx.get(IAgentToolRegistryService).register({
      name: 'test_gate', description: 'Block session A.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({ approvalRule: 'test_gate', execute: async () => { started(); await gate; return { output: 'done' }; } }),
    });
    try {
      b.get(IAgentCapabilityRebuildService);
      await b.rpc.setPermission({ mode: 'yolo' });
      ctx.mockNextResponse({ type: 'function', id: 'call_gate_a', name: 'test_gate', arguments: '{}' });
      ctx.mockNextResponse({ type: 'text', text: 'A done' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'A starts' }] });
      await running;
      const aSession = ctx.get(ISessionContext);
      const bSession = b.get(ISessionContext);
      expect(aSession.sessionId).not.toBe(bSession.sessionId);
      await config.replace(MEMORY_SECTION, { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} } satisfies MemoryConfig);
      await config.replace(THREAD_COMMUNICATION_SECTION, { enabled: true });
      b.mockNextResponse({ type: 'text', text: 'B done' });
      await b.rpc.prompt({ input: [{ type: 'text', text: 'B advances' }] });
      await b.untilTurnEnd();
      expect(toolNames(b.llmCalls[0]!.tools)).toContain('MemorySearch');
      expect(toolNames(b.llmCalls[0]!.tools)).toContain('ThreadList');
      expect(capabilities.threadEnabled(aSession.workspaceId, aSession.sessionId)).toBe(false);
      expect(capabilities.memoryAvailable(aSession.workspaceId, aSession.sessionId)).toBe(false);
      expect(capabilities.threadEnabled(bSession.workspaceId, bSession.sessionId)).toBe(true);
      expect(capabilities.memoryAvailable(bSession.workspaceId, bSession.sessionId)).toBe(true);
      release();
      await ctx.untilTurnEnd();
      expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
      ctx.mockNextResponse({ type: 'text', text: 'A next done' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'A advances' }] });
      await ctx.untilTurnEnd();
      expect(toolNames(ctx.llmCalls[2]!.tools)).toContain('MemorySearch');
      expect(toolNames(ctx.llmCalls[2]!.tools)).toContain('ThreadList');
      expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'capabilities_rebuilt')).toHaveLength(1);
    } finally {
      release();
      registration.dispose();
      await b.dispose();
    }
  });

  it.each(PREFIX_PROTOCOL_CASES)('keeps $name prefix when capability toggles revert before the next user message', async ({ provider }) => {
    ctx.get(IAgentCapabilityRebuildService);
    ctx.configure({ provider, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    const config = ctx.get(IConfigService);
    await config.replace(MEMORY_SECTION, { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} } satisfies MemoryConfig);
    await config.replace(THREAD_COMMUNICATION_SECTION, { enabled: true });
    await config.replace(MEMORY_SECTION, { enabled: false, approval: 'auto', budget: 2_000, workspaces: {} } satisfies MemoryConfig);
    await config.replace(THREAD_COMMUNICATION_SECTION, { enabled: false });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls[1]!.tools).toEqual(ctx.llmCalls[0]!.tools);
    const requests = wireEvents(ctx, 'llm.request').map((event) => event.args as { systemPromptHash?: string; toolsHash?: string });
    expect(requests[1]!.systemPromptHash).toBe(requests[0]!.systemPromptHash);
    expect(requests[1]!.toolsHash).toBe(requests[0]!.toolsHash);
    expect(ctx.get(IAgentContextMemoryService).get().filter((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'capabilities_rebuilt')).toHaveLength(0);
  });

  it('re-injects a selected schema after undo slices the tail of the loaded exchange', async () => {
    ctx.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'alpha is loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();

    await ctx.get(IAgentConversationUndoService).undo(1);
    const afterUndo = ctx.get(IAgentContextMemoryService).get();
    expect(afterUndo.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA))).toBe(
      false,
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'reloaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha again' }] });
    await ctx.untilTurnEnd();

    const afterReload = ctx.get(IAgentContextMemoryService).get();
    expect(
      afterReload.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);
    expect(historyText(afterReload)).toContain('Loaded: mcp__srv__alpha');
    expect(historyText(afterReload)).not.toContain('Already available: mcp__srv__alpha');
  });
});
