import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { IAgentToolExecutorService, type ToolCallGuard } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { SUBAGENT_MAIN_ONLY_TOOL_NAMES } from '@kiki/agent-profiles/subagentToolPolicy';
import { buildProfileDescriptions } from '@kiki/agent-profiles/profileCatalogProjection';
import { normalizeAgentProfile } from '@kiki/agent-profiles';
import { BoardReadTool, BoardWriteTool, IBoardReadTool, IBoardWriteTool, BOARD_TOOL_CONTRIBUTIONS } from '#/agent/tools/board/boardTools';
import { IFlagService } from '#/app/flag/flag';
import { ITaskBoardService } from '#/app/taskBoard/taskBoard';
import { IAgentPlanService } from '#/features/plan/plan';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolExecution } from '#/tool/toolContract';

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

interface FixtureOptions {
  agentId?: string;
  parentAgentId?: string;
  plan?: boolean;
  active?: boolean;
  enabled?: boolean;
  tools?: readonly string[];
  activeTools?: readonly string[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  disabledToolGroups?: ProfileData['disabledToolGroups'];
  globalDisabled?: readonly string[];
  globalEnabled?: readonly string[];
  workspaceDisabled?: readonly string[];
  sessionDisabled?: readonly string[];
  toolAllowPolicies?: readonly (readonly string[])[];
  executionRestriction?: 'research-readonly';
}

function fixture(options: FixtureOptions = {}) {
  const ix = disposables.add(new TestInstantiationService());
  const read = vi.fn<ITaskBoardService['read']>().mockResolvedValue({ ok: true, value: { workspaceId: 'a', cards: [], issues: [] } });
  const write = vi.fn<ITaskBoardService['write']>().mockResolvedValue({ ok: false, error: { code: 'TASK_REVISION_CONFLICT', message: 'Refresh the task.' } });
  const targetProfile = normalizeAgentProfile({ name: 'example', tools: options.tools, disallowedTools: options.disallowedTools, systemPrompt: () => '' });
  ix.stub(IAgentScopeContext, { agentId: options.agentId ?? 'main', parentAgentId: options.parentAgentId });
  ix.stub(ISessionContext, { workspaceId: 'session-workspace' });
  ix.stub(IAgentProfileService, { data: (): ProfileData => ({
    modelCapabilities: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 128_000 },
    thinkingLevel: 'off',
    systemPrompt: '',
    activeToolNames: options.activeTools ?? options.tools,
    disallowedTools: options.disallowedTools,
    disabledToolGroups: options.disabledToolGroups,
    toolAllowPolicies: options.toolAllowPolicies,
    executionRestriction: options.executionRestriction,
    boundProfile: targetProfile,
  }) });
  ix.stub(IConfigService, { get: <T>(section: string) => (section === 'subagent'
    ? { allowedTools: options.allowedTools }
    : { enabled: options.globalEnabled, disabled: options.active === false ? ['BoardRead', 'BoardWrite'] : options.globalDisabled }) as T });
  ix.stub(ISessionToolPolicy, { disabledTools: () => options.sessionDisabled ?? [] });
  ix.stub(ISessionToolPolicyGate, { disabledTools: options.workspaceDisabled ?? [] });
  let guard: ToolCallGuard | undefined;
  ix.stub(IAgentToolExecutorService, { registerToolCallGuard: (value) => {
    guard = value;
    return { dispose() {} };
  } });
  ix.set(IAgentToolPolicyService, new SyncDescriptor(AgentToolPolicyService));
  const policy = ix.get(IAgentToolPolicyService);
  ix.stub(IFlagService, { enabled: () => options.enabled ?? true });
  ix.stub(IAgentPlanService, { status: async () => options.plan ? { id: 'p', content: '', path: 'plan.md' } : null });
  ix.stub(ITaskBoardService, { read, write });
  ix.set(IBoardReadTool, new SyncDescriptor(BoardReadTool));
  ix.set(IBoardWriteTool, new SyncDescriptor(BoardWriteTool));
  return { ix, read, write, policy, guard: (name: string) => guard?.({ name, source: 'builtin' }), targetProfile,
    reader: ix.get(IBoardReadTool), writer: ix.get(IBoardWriteTool) };
}

async function execute(input: ToolExecution | Promise<ToolExecution>) {
  const execution = await input;
  if ('execute' in execution) {
    return execution.execute({ turnId: 1, toolCallId: 'call', signal: new AbortController().signal });
  }
  return execution;
}

describe('Board tools and subagent policy (real DI services)', () => {
  it.each([
    { tools: ['BoardRead', 'BoardWrite'] },
    { allowedTools: ['BoardRead', 'BoardWrite'] },
  ])('allows opted-in children through registration, disclosure, executor guard and execution: %o', async (optIn) => {
    const { ix, reader, writer, read, write, policy, guard } = fixture({ agentId: 'child', parentAgentId: 'main', ...optIn });
    for (const entry of BOARD_TOOL_CONTRIBUTIONS) {
      expect(entry.options.when(ix)).toBe(true);
      expect(policy.isToolActive(entry.options.name)).toBe(true);
      expect(policy.isToolActiveForDisclosure(entry.options.name)).toBe(true);
      expect(guard(entry.options.name)).toBeUndefined();
    }
    await execute(reader.resolveExecution({ action: 'list' }));
    await execute(writer.resolveExecution({ action: 'create', title: 'Example', requestKey: 'intent-a' }));
    expect(read).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    { tools: [] },
    { tools: ['Read'] },
    { disallowedTools: ['BoardRead'] },
    { disabledToolGroups: ['board'] as const },
    { globalDisabled: ['BoardRead'] },
    { globalEnabled: ['Read'] },
    { workspaceDisabled: ['BoardRead'] },
    { sessionDisabled: ['BoardRead'] },
    { toolAllowPolicies: [['Read']] },
    { executionRestriction: 'research-readonly' as const },
  ])('does not let a server opt-in bypass stricter policy: %o', async (restriction) => {
    const { reader, read, policy, guard } = fixture({ parentAgentId: 'main', allowedTools: ['BoardRead'], ...restriction });
    expect(policy.isToolActive('BoardRead')).toBe(false);
    expect(policy.isToolActiveForDisclosure('BoardRead')).toBe(false);
    expect(guard('BoardRead')).toContain('disabled');
    await execute(reader.resolveExecution({ action: 'list' }));
    expect(read).not.toHaveBeenCalled();
  });

  it('does not treat inherited active tool names or a wildcard as a profile opt-in', () => {
    for (const tools of [undefined, ['*']]) {
      const { policy, guard } = fixture({ parentAgentId: 'main', tools, activeTools: ['BoardRead'] });
      expect(policy.isToolActive('BoardRead')).toBe(false);
      expect(guard('BoardRead')).toContain('disabled');
    }
  });

  it('keeps main-only tools unavailable even when profiles and server opt in', () => {
    const tools = [...SUBAGENT_MAIN_ONLY_TOOL_NAMES];
    const { policy, guard } = fixture({ parentAgentId: 'main', tools, allowedTools: tools });
    for (const name of tools) {
      expect(policy.isToolActive(name), name).toBe(false);
      expect(policy.isToolActiveForProfile({ tools }, name), name).toBe(false);
      expect(guard(name), name).toContain('disabled');
    }
  });

  it('does not apply the child default to root or change MCP, user, and extension defaults', () => {
    const root = fixture();
    expect(root.policy.isToolActive('BoardRead')).toBe(true);
    expect(root.policy.isToolActiveForProfile({}, 'BoardRead')).toBe(false);
    const child = fixture({ parentAgentId: 'main' });
    expect(child.policy.isToolActive('mcp__example__write', 'mcp')).toBe(true);
    expect(child.policy.isToolActive('CustomWrite', 'user')).toBe(true);
    expect(child.policy.isToolActive('ExtensionWrite')).toBe(true);
  });

  it.each([{}, { tools: ['BoardRead', 'Read'] }, { allowedTools: ['BoardRead'] }])('projects prospective child access rather than caller identity: %o', (optIn) => {
    const { policy, targetProfile } = fixture(optIn);
    const names = ['Read', 'BoardRead', 'BoardWrite', ...SUBAGENT_MAIN_ONLY_TOOL_NAMES];
    const description = buildProfileDescriptions([targetProfile], names.map((name) => ({ name, source: 'builtin' })),
      (profile, name, source) => policy.isToolActiveForProfile(profile, name, source), undefined, () => true);
    expect(description).not.toContain('Tools: all');
    expect(description).toContain('conditional on the child runtime');
    expect(description.includes('BoardRead')).toBe('tools' in optIn || 'allowedTools' in optIn);
    expect(description).not.toContain('BoardWrite');
    for (const name of SUBAGENT_MAIN_ONLY_TOOL_NAMES) expect(description).not.toContain(name);
  });

  it('retains the plan-write guard for opted-in children', async () => {
    const { reader, writer, read, write } = fixture({ parentAgentId: 'main', allowedTools: ['BoardRead', 'BoardWrite'], plan: true });
    await execute(reader.resolveExecution({ action: 'list' }));
    await execute(writer.resolveExecution({ action: 'create', title: 'Example', requestKey: 'intent-a' }));
    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it('discloses neither tool to subagents and denies direct invocation independently of arguments', async () => {
    const { ix, reader, writer, read, write } = fixture({ agentId: 'child', parentAgentId: 'main' });
    for (const entry of BOARD_TOOL_CONTRIBUTIONS) expect(entry.options.when(ix)).toBe(false);
    expect(await execute(await reader.resolveExecution({ action: 'list' }))).toMatchObject({ isError: true });
    expect(await execute(await writer.resolveExecution({ action: 'create', title: 'Example', requestKey: 'intent-a' }))).toMatchObject({ isError: true });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not accept a child context merely named main', async () => {
    const { writer, write } = fixture({ agentId: 'main', parentAgentId: 'parent' });
    expect(await execute(await writer.resolveExecution({ action: 'create', title: 'Example', requestKey: 'intent-a' }))).toMatchObject({ isError: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('allows non-mutating native reads but refuses writes in plan mode', async () => {
    const { reader, writer, read, write } = fixture({ plan: true });
    expect(await execute(await reader.resolveExecution({ action: 'list' }))).not.toHaveProperty('isError', true);
    expect(await execute(await writer.resolveExecution({ action: 'create', title: 'Example', requestKey: 'intent-a' }))).toMatchObject({ isError: true });
    expect(read).toHaveBeenCalledExactlyOnceWith({ action: 'list', workspaceId: 'session-workspace' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([{ active: false }, { enabled: false }])('enforces profile/tool policy and feature flag on direct calls: %o', async (options) => {
    const { reader, writer, read, write } = fixture(options);
    expect(await execute(await reader.resolveExecution({ action: 'list' }))).toMatchObject({ isError: true });
    expect(await execute(await writer.resolveExecution({ action: 'create', title: 'Example', requestKey: 'intent-a' }))).toMatchObject({ isError: true });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('publishes in_progress in both tool schemas without adding status to create', () => {
    const { reader, writer } = fixture();
    expect(reader.description).toContain('in_progress');
    expect(writer.description).toContain('in_progress');
    expect(JSON.stringify(reader.parameters)).toContain('"in_progress"');
    expect(JSON.stringify(writer.parameters)).toContain('"in_progress"');
    const variants = writer.parameters['oneOf'];
    expect(Array.isArray(variants)).toBe(true);
    const create = Array.isArray(variants)
      ? variants.find((entry) => typeof entry === 'object' && entry !== null && 'properties' in entry
        && typeof entry.properties === 'object' && entry.properties !== null && 'action' in entry.properties
        && typeof entry.properties.action === 'object' && entry.properties.action !== null
        && 'const' in entry.properties.action && entry.properties.action.const === 'create')
      : undefined;
    expect(create && typeof create === 'object' && 'properties' in create && typeof create.properties === 'object' && create.properties !== null && 'status' in create.properties).toBe(false);
  });

  it('calls the shared service as main and reports persistence conflicts as tool errors', async () => {
    const { ix, writer, write } = fixture();
    for (const entry of BOARD_TOOL_CONTRIBUTIONS) expect(entry.options.when(ix)).toBe(true);
    const input = { action: 'update', workspaceId: 'session-workspace', storage: { root: '/example-store', storageId: 'store-a', kind: 'embedded' }, id: 'task-example', patch: { status: 'done' }, expectedRevision: 2 } as const;
    const result = await execute(await writer.resolveExecution(input));
    expect(write).toHaveBeenCalledExactlyOnceWith({ ...input, workspaceId: 'session-workspace' });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse(result.output as string)).toMatchObject({ error: { code: 'TASK_REVISION_CONFLICT' } });
  });
});
