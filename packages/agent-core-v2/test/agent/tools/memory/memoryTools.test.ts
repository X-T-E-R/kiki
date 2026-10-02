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

describe('memory maintenance guidance', () => {
  let ix: TestInstantiationService;
  beforeEach(() => {
    ix = new TestInstantiationService();
    ix.stub(ISessionContext, { workspaceId: 'example', sessionId: 'example' });
    ix.stub(IAgentMemorySnapshot, { getPersona: () => undefined });
    ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'auto', workspaces: {} }) as T });
    ix.stub(ICapabilitySnapshotService, { memoryAvailable: () => true });
    ix.stub(IMemoryStore, {});
    ix.set(IMemoryWriteTool, new SyncDescriptor(MemoryWriteTool));
    ix.set(IMemorySearchTool, new SyncDescriptor(MemorySearchTool));
    ix.set(IMemoryReadTool, new SyncDescriptor(MemoryReadTool));
  });
  afterEach(() => ix.dispose());

  it('describes complete revisions, active-before-retirement, and explicit original scope', () => {
    const write = ix.get(IMemoryWriteTool);
    for (const guidance of [
      'Prefer `update` for a complete revision',
      'after the retained content is active',
      'leave an already complete rule unchanged',
      'Write the full current rule affirmatively',
      'change history in `reason`',
      'A global target requires `scope: "global"`',
      'it is never inferred from ID',
      'MemoryRead currently omits it',
      'confirm scope and reread the target before retrying',
      "preserve the target's full type/title/body",
      'it is not active memory',
    ]) expect(write.description).toContain(guidance);
    expect(ix.get(IMemorySearchTool).description).toContain('These ranked hits are not a complete inventory');
    expect(ix.get(IMemorySearchTool).description).toContain("Retain each hit's `scope.kind`");
    expect(ix.get(IMemoryReadTool).description).toContain('archived and superseded entries can be returned as history');
    expect(ix.get(IMemoryReadTool).description).toContain('If the scope is unknown, recover it through search');
  });

  it('projects field guidance without changing validation constraints or required fields', () => {
    const write = ix.get(IMemoryWriteTool).parameters;
    const search = ix.get(IMemorySearchTool).parameters;
    const read = ix.get(IMemoryReadTool).parameters;
    const scopes = { type: 'string', enum: ['global', 'workspace', 'persona', 'persona_workspace'] };
    const types = { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] };
    const expected = [
      [write, ['action', 'type', 'title', 'body', 'reason'], {
        action: { type: 'string', enum: ['create', 'update', 'supersede', 'archive'] },
        scope: scopes, type: types, title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', minLength: 1, maxLength: 1_500 }, reason: { type: 'string', minLength: 1 },
        id: { type: 'string' }, expected_revision: { type: 'string' },
      }],
      [search, ['query'], {
        query: { type: 'string', minLength: 1, maxLength: 200 }, scope: scopes, type: types,
        include_superseded: { type: 'boolean' },
      }],
      [read, undefined, {
        id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
      }],
    ] as const;
    for (const [schema, required, properties] of expected) {
      expect(schema['required']).toEqual(required);
      expect(schema['additionalProperties']).toBe(false);
      const projected = schema['properties'] as Record<string, Record<string, unknown>>;
      const constraints = Object.fromEntries(Object.entries(projected).map(([key, value]) => {
        const { description, ...rest } = value;
        expect(typeof description).toBe('string');
        expect((description as string).length).toBeGreaterThan(0);
        return [key, rest];
      }));
      expect(constraints).toEqual(properties);
    }
    const writeFields = write['properties'] as Record<string, Record<string, unknown>>;
    const searchFields = search['properties'] as Record<string, Record<string, unknown>>;
    expect(writeFields['scope']!['description']).toContain('not inferred from id');
    expect(searchFields['scope']!['description']).toContain('Omit to search all scopes');
    expect(writeFields['body']!['description']).toContain("the target's full original body is preserved as history");
    expect(writeFields['reason']!['description']).toContain('Put change history and retired values here');
  });
});
