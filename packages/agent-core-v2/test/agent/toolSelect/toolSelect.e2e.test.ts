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
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import '#/agent/tools/select-tools/selectToolsTool';

import { createTestAgent, type TestAgentContext } from '../../harness';

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
