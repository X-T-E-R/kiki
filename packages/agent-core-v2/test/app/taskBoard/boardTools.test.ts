import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { BoardReadTool, BoardWriteTool, IBoardReadTool, IBoardWriteTool, BOARD_TOOL_CONTRIBUTIONS } from '#/agent/tools/board/boardTools';
import { IFlagService } from '#/app/flag/flag';
import { ITaskBoardService } from '#/app/taskBoard/taskBoard';
import { IAgentPlanService } from '#/features/plan/plan';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolExecution } from '#/tool/toolContract';

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function fixture(options: { agentId?: string; parentAgentId?: string; plan?: boolean; active?: boolean; enabled?: boolean } = {}) {
  const ix = disposables.add(new TestInstantiationService());
  const read = vi.fn<ITaskBoardService['read']>().mockResolvedValue({ ok: true, value: { workspaceId: 'a', cards: [], issues: [] } });
  const write = vi.fn<ITaskBoardService['write']>().mockResolvedValue({ ok: false, error: { code: 'TASK_REVISION_CONFLICT', message: 'Refresh the task.' } });
  ix.stub(IAgentScopeContext, { agentId: options.agentId ?? 'main', parentAgentId: options.parentAgentId });
  ix.stub(ISessionContext, { workspaceId: 'session-workspace' });
  ix.stub(IAgentToolPolicyService, { isToolActive: () => options.active ?? true });
  ix.stub(IFlagService, { enabled: () => options.enabled ?? true });
  ix.stub(IAgentPlanService, { status: async () => options.plan ? { id: 'p', content: '', path: 'plan.md' } : null });
  ix.stub(ITaskBoardService, { read, write });
  ix.set(IBoardReadTool, new SyncDescriptor(BoardReadTool));
  ix.set(IBoardWriteTool, new SyncDescriptor(BoardWriteTool));
  return { ix, read, write, reader: ix.get(IBoardReadTool), writer: ix.get(IBoardWriteTool) };
}

async function execute(execution: ToolExecution) {
  if ('execute' in execution) {
    return execution.execute({ turnId: 1, toolCallId: 'call', signal: new AbortController().signal });
  }
  return execution;
}

describe('Board tools (real DI tool classes, mocked host service/policy)', () => {
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
