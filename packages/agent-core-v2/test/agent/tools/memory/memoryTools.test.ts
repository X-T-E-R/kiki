import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IMemoryReadTool, IMemorySearchTool, IMemoryWriteTool, MemoryReadTool, MemorySearchTool, MemoryWriteTool } from '#/agent/tools/memory/memoryTools';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
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
    ix.stub(ICapabilitySnapshotService, { memoryAvailable: () => true, toolAvailable: () => true });
    ix.set(IMemoryWriteTool, new SyncDescriptor(MemoryWriteTool));
    const tools = getAgentToolContributions();
    expect(tools.find((tool) => tool.id === IMemoryWriteTool)?.options.when?.(ix)).toBe(false);
    expect(tools.find((tool) => tool.id === IMemorySearchTool)?.options.when?.(ix) ?? true).toBe(true);
    expect(tools.find((tool) => tool.id === IMemoryReadTool)?.options.when?.(ix) ?? true).toBe(true);
    const execution = ix.get(IMemoryWriteTool).resolveExecution({
      action: 'create', scope: 'global', type: 'user', title: 'Temporary', body: 'Do not persist', reason: 'Test',
    });
    if (!('execute' in execution)) throw new Error('expected an executable tool');
    const result = await execution.execute({ turnId: 1, toolCallId: 'call', signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
    await ix.dispose();
  });
});

describe('memory maintenance guidance', () => {
  let ix: TestInstantiationService;
  beforeEach(() => {
    ix = new TestInstantiationService();
    ix.stub(ISessionContext, { workspaceId: 'example', sessionId: 'example' });
    ix.stub(IAgentMemorySnapshot, { getPersona: () => undefined });
    ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'auto', workspaces: {} }) as T });
    ix.stub(ICapabilitySnapshotService, { memoryAvailable: () => true, toolAvailable: () => true });
    ix.stub(IMemoryStore, {});
    ix.set(IMemoryWriteTool, new SyncDescriptor(MemoryWriteTool));
    ix.set(IMemorySearchTool, new SyncDescriptor(MemorySearchTool));
    ix.set(IMemoryReadTool, new SyncDescriptor(MemoryReadTool));
  });
  afterEach(() => ix.dispose());

  it('describes durable ownership, complete revisions, active-before-retirement and recoverable targeting', () => {
    const write = ix.get(IMemoryWriteTool);
    for (const guidance of [
      'First choose its home', 'Leave an already complete rule unchanged', 'Prefer update on the same ID',
      'first confirm the retained same-scope entry is active', 'Do not replace global guidance with a narrower workspace entry',
      'Keep correction history and retired values in reason', 'distinguishing human guidance, observed evidence, and agent-derived interpretation',
      'the ID must resolve uniquely', 'The store preserves the original content', 'Pending is not active',
      'never create a duplicate to bypass the failure',
    ]) expect(write.description).toContain(guidance);
    expect(ix.get(IMemorySearchTool).description).toContain('Ranked search is for recall, not proof');
    expect(ix.get(IMemorySearchTool).description).toContain('Continue with cursor alone');
    expect(ix.get(IMemoryReadTool).description).toContain('Archived and superseded entries are history, not current guidance');
    expect(ix.get(IMemoryReadTool).description).toContain('owning scope, latest revision, applicability');
    for (const tool of [write, ix.get(IMemorySearchTool), ix.get(IMemoryReadTool)]) expect(tool.description).not.toContain('MemoryRead currently omits');
  });

  it.each(['pending', 'active'] as const)('returns structured %s write evidence from the stored result with owning and proposed targets', async (status) => {
    const entry = { id: status === 'pending' ? 'm_proposal' : 'm_entry', type: 'feedback' as const, title: 'Guidance', body: 'Stored normalized content.', revision: 'rev-2', status, pinned: false, created: '2026-01-01', updated: '2026-01-02', source: { writer: 'agent' as const }, reason: 'Correction', supersedes: status === 'pending' ? 'm_entry' : undefined, supersedes_revision: status === 'pending' ? 'rev-1' : undefined };
    const outcome = status === 'pending' ? 'pending' as const : 'applied' as const;
    ix.stub(IMemoryStore, { get: async (scope) => scope.kind === 'global' ? { ...entry, id: 'm_entry', status: 'active', revision: 'rev-1' } : undefined, put: async () => ({ entry, outcome, operationId: 'op-2' }) });
    const execution = ix.get(IMemoryWriteTool).resolveExecution({ action: 'update', scope: 'global', type: 'feedback', title: 'Guidance', body: 'Complete current rule.', reason: 'Human correction', id: 'm_entry', expected_revision: 'rev-1' });
    if (!('execute' in execution)) throw new Error('expected write execution');
    const result = await execution.execute({ turnId: 1, toolCallId: 'write', signal: new AbortController().signal });
    const proposedTarget = status === 'pending' ? { scope: 'global', id: 'm_entry', expected_revision: 'rev-1' } : undefined;
    expect(result.memoryReceipt).toEqual({ action: 'update', outcome, id: entry.id, revision: 'rev-2', status, operationId: 'op-2', ownerScope: { kind: 'global' }, target: { scope: 'global', id: entry.id, expected_revision: 'rev-2' }, proposedTarget });
    expect(JSON.parse(result.output as string)).toMatchObject({ entry: JSON.parse(JSON.stringify(entry)), outcome, owner_scope: { kind: 'global' } });
    expect(result.isError).not.toBe(true);
  });

  it('projects field guidance without changing validation constraints or required fields', () => {
    const write = ix.get(IMemoryWriteTool).parameters;
    const search = ix.get(IMemorySearchTool).parameters;
    const read = ix.get(IMemoryReadTool).parameters;
    const scopes = { type: 'string', enum: ['global', 'workspace', 'persona', 'persona_workspace'] };
    const types = { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] };
    const expected = [
      [write, ['action', 'reason'], ['action', 'scope', 'id', 'expected_revision', 'type', 'title', 'body', 'reason', 'basis', 'validity', 'covered_by']],
      [search, undefined, ['mode', 'query', 'scope', 'type', 'statuses', 'include_superseded', 'page_size', 'cursor']],
      [read, undefined, ['id', 'ids', 'scope', 'include_pending']],
    ] as const;
    for (const [schema, required, properties] of expected) {
      expect(schema['required']).toEqual(required);
      expect(schema['additionalProperties']).toBe(false);
      const projected = schema['properties'] as Record<string, Record<string, unknown>>;
      expect(Object.keys(projected)).toEqual(properties);
      for (const field of Object.values(projected)) expect((field['description'] as string).length).toBeGreaterThan(0);
    }
    const writeFields = write['properties'] as Record<string, Record<string, unknown>>;
    const searchFields = search['properties'] as Record<string, Record<string, unknown>>;
    const readFields = read['properties'] as Record<string, Record<string, unknown>>;
    expect(writeFields['scope']).toMatchObject(scopes);
    expect(writeFields['type']).toMatchObject(types);
    expect(writeFields['title']).toMatchObject({ type: 'string', minLength: 1, maxLength: 200 });
    expect(writeFields['body']).toMatchObject({ type: 'string', minLength: 1, maxLength: 1_500 });
    expect(writeFields['basis']).toMatchObject({ type: 'object', required: ['kind', 'note'], additionalProperties: false, properties: { kind: { enum: ['human', 'observed', 'derived', 'unknown'] }, note: { minLength: 1, maxLength: 500 }, refs: { maxItems: 8, items: { minLength: 1, maxLength: 500 } } } });
    expect(writeFields['validity']).toMatchObject({ anyOf: [{ type: 'object', required: ['check'], properties: { check: { minLength: 1, maxLength: 300 }, until: { format: 'date-time' } } }, { type: 'null' }] });
    expect(writeFields['covered_by']).toMatchObject({ type: 'object', required: ['id', 'expected_revision'], additionalProperties: false });
    expect(searchFields['page_size']).toMatchObject({ type: 'integer', minimum: 1, maximum: 20 });
    expect(searchFields['query']).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(readFields['ids']).toMatchObject({ type: 'array', minItems: 1, maxItems: 10 });
    expect(writeFields['scope']!['description']).toContain('omission resolves a unique visible, permitted ID');
    expect(writeFields['body']!['description']).toContain('Archive preserves stored content and ignores legacy content fields');
    expect(writeFields['reason']!['description']).toContain('do not put retired values into the active rule');
    const incomplete = ix.get(IMemoryWriteTool).resolveExecution({ action: 'create', reason: 'Missing content' });
    expect(incomplete).toMatchObject({ isError: true });
    expect('output' in incomplete && JSON.parse(incomplete.output as string).code).toBe('invalid_input');
  });
});
