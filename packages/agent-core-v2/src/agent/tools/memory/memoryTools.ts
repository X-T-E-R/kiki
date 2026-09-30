import { z } from 'zod';
import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IMemoryStore, type MemoryType } from '#/app/memory/memoryStore';
import type { MemoryPublicScopeKind, MemoryScope } from '#/app/memory/memoryScopes';
import { IAgentMemorySnapshot, type MemoryPersonaContext } from '#/app/memory/memorySnapshot';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

const typeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
const scopeSchema = z.enum(['global', 'workspace', 'persona', 'persona_workspace']);
const writeSchema = z.object({
  action: z.enum(['create', 'update', 'supersede', 'archive']),
  scope: scopeSchema.optional(),
  type: typeSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1_500),
  reason: z.string().min(1),
  id: z.string().optional(),
  expected_revision: z.string().optional(),
}).strict();
const searchSchema = z.object({ query: z.string().min(1).max(200), scope: scopeSchema.optional(), type: typeSchema.optional(), include_superseded: z.boolean().optional() }).strict();
const readSchema = z.object({ id: z.string().optional(), ids: z.array(z.string()).min(1).max(10).optional() }).strict();
function publicScopes(session: ISessionContext, persona: MemoryPersonaContext | undefined): readonly MemoryScope[] {
  const shared = persona?.shared ?? ['global', 'workspace'];
  return [
    ...(shared.includes('global') ? [{ kind: 'global' } as const] : []),
    ...(shared.includes('workspace') ? [{ kind: 'workspace', workspaceId: session.workspaceId } as const] : []),
  ];
}
function scopes(session: ISessionContext, persona: MemoryPersonaContext | undefined): readonly MemoryScope[] {
  return [
    ...publicScopes(session, persona),
    ...(persona === undefined ? [] : [
      { kind: 'persona', personaId: persona.id } as const,
      { kind: 'persona_workspace', workspaceId: session.workspaceId, personaId: persona.id } as const,
    ]),
  ];
}
function resolveScope(kind: z.infer<typeof scopeSchema> | undefined, session: ISessionContext, persona: MemoryPersonaContext | undefined): MemoryScope {
  switch (kind ?? (persona === undefined ? 'workspace' : 'persona')) {
    case 'global': return { kind: 'global' };
    case 'workspace': return { kind: 'workspace', workspaceId: session.workspaceId };
    case 'persona':
      if (persona === undefined) throw new Error('Persona memory requires a bound persona.');
      return { kind: 'persona', personaId: persona.id };
    case 'persona_workspace':
      if (persona === undefined) throw new Error('Persona memory requires a bound persona.');
      return { kind: 'persona_workspace', workspaceId: session.workspaceId, personaId: persona.id };
  }
}
function assertReadable(kind: z.infer<typeof scopeSchema>, persona: MemoryPersonaContext | undefined): void {
  if (kind === 'persona' || kind === 'persona_workspace') {
    if (persona === undefined) throw new Error('Persona memory requires a bound persona.');
    return;
  }
  if (persona !== undefined && !(persona.shared ?? ['global', 'workspace']).includes(kind as MemoryPublicScopeKind)) {
    throw new Error(`Bound persona cannot read ${kind} memory.`);
  }
}
function available(snapshot: ICapabilitySnapshotService, session: ISessionContext): boolean {
  return snapshot.memoryAvailable(session.workspaceId, session.sessionId);
}

export interface IMemoryWriteTool extends AgentTool<z.infer<typeof writeSchema>> { readonly _serviceBrand: undefined }
export const IMemoryWriteTool = createDecorator<IMemoryWriteTool>('memoryWriteTool');
export class MemoryWriteTool implements IMemoryWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemoryWrite';
  readonly description = 'Save reusable preferences, feedback, project facts, or reference pointers. With a bound persona, omitted scope saves to that persona memory; use workspace for project facts and global for cross-persona user preferences.';
  readonly parameters = toInputJsonSchema(writeSchema);
  constructor(
    @IMemoryStore private readonly store: IMemoryStore,
    @ISessionContext private readonly session: ISessionContext,
    @IConfigService private readonly config: IConfigService,
    @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService,
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
  ) {}
  resolveExecution(args: z.infer<typeof writeSchema>): ToolExecution {
    const parsed = writeSchema.safeParse(args);
    if (!parsed.success) return { isError: true, output: parsed.error.message };
    return { approvalRule: this.name, accesses: ToolAccesses.none(), description: `Remember: ${parsed.data.title.slice(0, 70)}`, execute: async ({ turnId }) => {
      if (this.session.ephemeral === true || !available(this.capabilities, this.session)) return { isError: true, output: 'Memory is disabled.' };
      try {
        const persona = this.memorySnapshot.getPersona();
        const scope = resolveScope(parsed.data.scope, this.session, persona);
        const result = await this.store.put({
          action: parsed.data.action, scope, type: parsed.data.type,
          title: parsed.data.title, body: parsed.data.body, reason: parsed.data.reason,
          id: parsed.data.id, expectedRevision: parsed.data.expected_revision,
          source: { writer: 'agent', session: this.session.sessionId, turn: turnId },
          pending: this.config.get<MemoryConfig>(MEMORY_SECTION).approval === 'review',
        });
        return { output: JSON.stringify({ id: result.entry.id, title: result.entry.title, scope: scope.kind, status: result.entry.status, revision: result.entry.revision, operation_id: result.operationId, reference_hint: `Reference it in TodoList notes.directives as [${result.entry.id}] if it constrains the current task.` }) };
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
    } };
  }
}

export interface IMemorySearchTool extends AgentTool<z.infer<typeof searchSchema>> { readonly _serviceBrand: undefined }
export const IMemorySearchTool = createDecorator<IMemorySearchTool>('memorySearchTool');
export class MemorySearchTool implements IMemorySearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemorySearch';
  readonly description = 'Search reusable preferences, feedback, project facts, and reference pointers visible to this persona.';
  readonly parameters = toInputJsonSchema(searchSchema);
  constructor(
    @IMemoryStore private readonly store: IMemoryStore,
    @ISessionContext private readonly session: ISessionContext,
    @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService,
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
  ) {}
  resolveExecution(args: z.infer<typeof searchSchema>): ToolExecution {
    const parsed = searchSchema.safeParse(args);
    if (!parsed.success) return { isError: true, output: parsed.error.message };
    return { approvalRule: this.name, accesses: ToolAccesses.none(), execute: async () => {
      if (!available(this.capabilities, this.session)) return { isError: true, output: 'Memory is disabled.' };
      try {
        const persona = this.memorySnapshot.getPersona();
        if (parsed.data.scope !== undefined) assertReadable(parsed.data.scope, persona);
        const targets = parsed.data.scope === undefined ? scopes(this.session, persona) : [resolveScope(parsed.data.scope, this.session, persona)];
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
  readonly description = 'Read saved preferences, feedback, project facts, or reference pointers visible to this persona by memory ID.';
  readonly parameters = toInputJsonSchema(readSchema);
  constructor(
    @IMemoryStore private readonly store: IMemoryStore,
    @ISessionContext private readonly session: ISessionContext,
    @IConfigService private readonly config: IConfigService,
    @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService,
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
  ) {}
  resolveExecution(args: z.infer<typeof readSchema>): ToolExecution {
    const parsed = readSchema.safeParse(args);
    if (!parsed.success || (parsed.data?.id === undefined && parsed.data?.ids === undefined)) return { isError: true, output: 'Provide id or ids (up to 10).' };
    return { approvalRule: this.name, accesses: ToolAccesses.none(), execute: async () => {
      if (!available(this.capabilities, this.session)) return { isError: true, output: 'Memory is disabled.' };
      try {
        const visible = scopes(this.session, this.memorySnapshot.getPersona());
        const items = await Promise.all((parsed.data.ids ?? [parsed.data.id!]).map(async (id) => {
          for (const scope of visible) {
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
