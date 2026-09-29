import { z } from 'zod';
import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IMemoryStore, type MemoryType } from '#/app/memory/memoryStore';
import type { MemoryScope } from '#/app/memory/memoryScopes';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

const typeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
const writeSchema = z.object({
  action: z.enum(['create', 'update', 'supersede', 'archive']),
  scope: z.enum(['global', 'workspace']),
  type: typeSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1_500),
  reason: z.string().min(1),
  id: z.string().optional(),
  expected_revision: z.string().optional(),
}).strict();
const searchSchema = z.object({ query: z.string().min(1).max(200), scope: z.enum(['global', 'workspace']).optional(), type: typeSchema.optional(), include_superseded: z.boolean().optional() }).strict();
const readSchema = z.object({ id: z.string().optional(), ids: z.array(z.string()).min(1).max(10).optional() }).strict();
function scopes(session: ISessionContext): readonly MemoryScope[] {
  return [{ kind: 'workspace', workspaceId: session.workspaceId }, { kind: 'global' }];
}
function resolveScope(kind: 'global' | 'workspace', session: ISessionContext): MemoryScope {
  return kind === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId: session.workspaceId };
}
function available(snapshot: ICapabilitySnapshotService, session: ISessionContext): boolean {
  return snapshot.memoryAvailable(session.workspaceId);
}

export interface IMemoryWriteTool extends AgentTool<z.infer<typeof writeSchema>> { readonly _serviceBrand: undefined }
export const IMemoryWriteTool = createDecorator<IMemoryWriteTool>('memoryWriteTool');
export class MemoryWriteTool implements IMemoryWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemoryWrite';
  readonly description = 'Save reusable user preferences, user feedback, verified project facts, or reference pointers. Do not save transient tasks.';
  readonly parameters = toInputJsonSchema(writeSchema);
  constructor(@IMemoryStore private readonly store: IMemoryStore, @ISessionContext private readonly session: ISessionContext, @IConfigService private readonly config: IConfigService, @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService) {}
  resolveExecution(args: z.infer<typeof writeSchema>): ToolExecution {
    const parsed = writeSchema.safeParse(args);
    if (!parsed.success) return { isError: true, output: parsed.error.message };
    return { approvalRule: this.name, accesses: ToolAccesses.none(), description: `Remember: ${parsed.data.title.slice(0, 70)}`, execute: async ({ turnId }) => {
      if (this.session.ephemeral === true || !available(this.capabilities, this.session)) return { isError: true, output: 'Memory is disabled.' };
      try {
        const result = await this.store.put({
          action: parsed.data.action, scope: resolveScope(parsed.data.scope, this.session), type: parsed.data.type,
          title: parsed.data.title, body: parsed.data.body, reason: parsed.data.reason,
          id: parsed.data.id, expectedRevision: parsed.data.expected_revision,
          source: { writer: 'agent', session: this.session.sessionId, turn: turnId },
          pending: this.config.get<MemoryConfig>(MEMORY_SECTION).approval === 'review',
        });
        return { output: JSON.stringify({ id: result.entry.id, title: result.entry.title, scope: parsed.data.scope, status: result.entry.status, revision: result.entry.revision, operation_id: result.operationId }) };
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
    } };
  }
}

export interface IMemorySearchTool extends AgentTool<z.infer<typeof searchSchema>> { readonly _serviceBrand: undefined }
export const IMemorySearchTool = createDecorator<IMemorySearchTool>('memorySearchTool');
export class MemorySearchTool implements IMemorySearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemorySearch';
  readonly description = 'Search reusable user preferences, feedback, project facts, and reference pointers.';
  readonly parameters = toInputJsonSchema(searchSchema);
  constructor(@IMemoryStore private readonly store: IMemoryStore, @ISessionContext private readonly session: ISessionContext, @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService) {}
  resolveExecution(args: z.infer<typeof searchSchema>): ToolExecution {
    const parsed = searchSchema.safeParse(args);
    if (!parsed.success) return { isError: true, output: parsed.error.message };
    return { approvalRule: this.name, accesses: ToolAccesses.none(), execute: async () => {
      if (!available(this.capabilities, this.session)) return { isError: true, output: 'Memory is disabled.' };
      try {
        const targets = parsed.data.scope === undefined ? scopes(this.session) : [resolveScope(parsed.data.scope, this.session)];
        const hits = await this.store.search(targets, parsed.data.query, parsed.data.type as MemoryType | undefined, parsed.data.include_superseded);
        return { output: JSON.stringify(hits.filter((hit) => hit.status === 'active' || (parsed.data.include_superseded === true && hit.status === 'superseded')).slice(0, 8).map(({ id, title, body, type, source, scope, score }) => ({ id, title, type, snippet: body.slice(0, 200), source, scope, score }))) };
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
    } };
  }
}

export interface IMemoryReadTool extends AgentTool<z.infer<typeof readSchema>> { readonly _serviceBrand: undefined }
export const IMemoryReadTool = createDecorator<IMemoryReadTool>('memoryReadTool');
export class MemoryReadTool implements IMemoryReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemoryRead';
  readonly description = 'Read saved user preferences, feedback, project facts, or reference pointers by memory ID.';
  readonly parameters = toInputJsonSchema(readSchema);
  constructor(@IMemoryStore private readonly store: IMemoryStore, @ISessionContext private readonly session: ISessionContext, @IConfigService private readonly config: IConfigService, @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService) {}
  resolveExecution(args: z.infer<typeof readSchema>): ToolExecution {
    const parsed = readSchema.safeParse(args);
    if (!parsed.success || (parsed.data?.id === undefined && parsed.data?.ids === undefined)) return { isError: true, output: 'Provide id or ids (up to 10).' };
    return { approvalRule: this.name, accesses: ToolAccesses.none(), execute: async () => {
      if (!available(this.capabilities, this.session)) return { isError: true, output: 'Memory is disabled.' };
      try {
        const items = await Promise.all((parsed.data.ids ?? [parsed.data.id!]).map(async (id) => {
          for (const scope of scopes(this.session)) {
            const found = await this.store.get(scope, id);
            if (found !== undefined && found.status !== 'pending') return found;
          }
          return { id, missing: true };
        }));
        return { output: JSON.stringify(items) };
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
    } };
  }
}

const when = (accessor: ServicesAccessor): boolean =>
  accessor.get(IAgentScopeContext).agentId === 'main';
registerAgentToolService(IMemoryWriteTool, MemoryWriteTool, { name: 'MemoryWrite', domain: 'memory', when: (accessor) => !accessor.get(ISessionContext).ephemeral && when(accessor) });
registerAgentToolService(IMemorySearchTool, MemorySearchTool, { name: 'MemorySearch', domain: 'memory', when });
registerAgentToolService(IMemoryReadTool, MemoryReadTool, { name: 'MemoryRead', domain: 'memory', when });
