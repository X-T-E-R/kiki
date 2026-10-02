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
  action: z.enum(['create', 'update', 'supersede', 'archive']).describe('Prefer update for an existing rule. Use supersede for a distinct replacement record, archive for obsolete or fully covered entries, and create only for genuinely new guidance. Supersede creates a new ID; update keeps the target ID.'),
  scope: scopeSchema.optional().describe('Target scope. For update, supersede, or archive, explicitly use the existing entry\'s original scope (MemorySearch hit.scope.kind). Global targets require global. Omitted scope resolves to the bound persona, otherwise workspace; it is not inferred from id. Persona scopes require a bound persona.'),
  type: typeSchema.describe('feedback: how to work; user: user information; project: durable project facts absent from repository records; reference: pointers. Required for every action. Preserve the target type when archiving.'),
  title: z.string().min(1).max(200).describe('Stable title for the rule or subject, 1–200 characters. Keep related revisions under the same topic. Required for every action; preserve the original title when archiving.'),
  body: z.string().min(1).max(1_500).describe('Complete current rule, 1–1,500 characters: affirmative wording, applicability, action or value, necessary exceptions, and known effective date. Update replaces the full body. Required even for archive, where the target\'s full original body is preserved as history.'),
  reason: z.string().min(1).describe('Why this change is justified, including the user instruction or current evidence and any consolidation or retirement rationale. Put change history and retired values here rather than in the active rule body. Required for every action.'),
  id: z.string().optional().describe('Existing target ID for update, supersede, or archive; required for those actions. For supersede, this is the predecessor, not the new entry. Omit for create.'),
  expected_revision: z.string().optional().describe('Latest target revision from MemoryRead or MemorySearch; required for update, supersede, and archive. On conflict, confirm scope, reread, and reconcile before retrying.'),
}).strict();
const searchSchema = z.object({
  query: z.string().min(1).max(200).describe('Short subject, title, or alias query, up to 200 characters and 10 whitespace-separated words. Search related wording before creating a new entry; a single empty result does not establish that no related rule exists.'),
  scope: scopeSchema.optional().describe('Search only this visible scope. Omit to search all scopes visible to the current persona. This search default differs from MemoryWrite\'s default destination.'),
  type: typeSchema.optional().describe('Optional memory-type filter. Omit when locating a rule whose saved type is unknown.'),
  include_superseded: z.boolean().optional().describe('Include replaced entries for historical lookup. Defaults to active entries only. Archived and pending entries remain excluded; check each result\'s status.'),
}).strict();
const readSchema = z.object({
  id: z.string().optional().describe('One saved entry ID. Supply id or ids. Read returns full content and revision, but not the owning scope.'),
  ids: z.array(z.string()).min(1).max(10).optional().describe('Saved entry IDs to read together, 1–10. Use for related entries before consolidation; check each entry\'s status and preserve distinct conditions.'),
}).strict();
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
  readonly description = 'Maintain durable memory for scoped recall. When the user establishes or changes guidance useful across tasks, reconcile existing entries in the same turn. Search by subject before creating; read related entries in full before modifying them. Reuse a full, current read already in view.\n\nPrefer `update` for a complete revision of an existing rule. Consolidate overlapping entries with the same scope and applicability into one retained entry, then `archive` fully covered entries after the retained content is active. Use `supersede` when a separate replacement record is useful; it creates a new ID and, when active, marks the specified predecessor superseded. Archive revoked or obsolete guidance. Create only genuinely new guidance; leave an already complete rule unchanged.\n\nWrite the full current rule affirmatively, including its conditions and known effective date. Keep the rule and its qualifications together, with change history in `reason`. For `update`, `supersede`, and `archive`, provide the target\'s original `scope`, `id`, and latest `expected_revision`. A global target requires `scope: "global"`. Omitted scope defaults to the bound persona, otherwise workspace; it is never inferred from ID. Take the scope string from MemorySearch\'s `scope.kind` or a known write receipt; MemoryRead currently omits it. On lookup or revision errors, confirm scope and reread the target before retrying.\n\nEvery action requires `type`, `title`, `body`, and `reason`. Update replaces the full content. For archive, preserve the target\'s full type/title/body and put the retirement or consolidation rationale in reason. Respect the user\'s scope: workspace for project-specific guidance, global for guidance across workspaces, and the bound persona scope for persona-specific guidance. Types: feedback for how to work, user for who the user is, project for durable project facts absent from repository records, reference for pointers. Keep secrets out, task progress in task notes, and repository-owned facts in their authoritative files. A pending receipt awaits review; it is not active memory. Direct user instructions still govern the current task.';
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
        return { output: JSON.stringify({ id: result.entry.id, title: result.entry.title, scope: scope.kind, status: result.entry.status, revision: result.entry.revision, operation_id: result.operationId, reference_hint: result.entry.status === 'pending'
          ? 'Awaiting review; not active memory. Do not cite this pending entry as an effective standing rule. Follow direct user instructions for the current task independently of storage review.'
          : `Reference it in TodoList notes.directives as [${result.entry.id}] if it constrains the current task.` }) };
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
    } };
  }
}

export interface IMemorySearchTool extends AgentTool<z.infer<typeof searchSchema>> { readonly _serviceBrand: undefined }
export const IMemorySearchTool = createDecorator<IMemorySearchTool>('memorySearchTool');
export class MemorySearchTool implements IMemorySearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemorySearch';
  readonly description = 'Find saved guidance visible to this persona when relevant details are missing, and find existing entries to maintain before creating memory. Search by subject and likely aliases, including related rules with different wording. Reuse entries already complete and current in view. Omitted scope searches all visible scopes; an explicit scope narrows the search.\n\nReturns up to 8 active hits with id, revision, scope, status, and a body snippet of up to 200 characters. Read related entries with MemoryRead before merging, replacing, or relying on omitted conditions. Retain each hit\'s `scope.kind` for MemoryWrite; MemoryRead currently omits scope. These ranked hits are not a complete inventory: narrow or rephrase a query when a known entry is missing. Use short queries of at most 10 whitespace-separated words. `include_superseded` also returns replaced entries for historical lookup; archived and pending entries are excluded. Historical hits are not current rules.';
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
        return { output: JSON.stringify(hits.filter((hit) => hit.status === 'active' || (parsed.data.include_superseded === true && hit.status === 'superseded')).slice(0, 8).map(({ id, title, body, type, source, scope, score, revision, status }) => ({ id, title, type, status, revision, snippet: body.slice(0, 200), source, scope, score }))) };
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
    } };
  }
}

export interface IMemoryReadTool extends AgentTool<z.infer<typeof readSchema>> { readonly _serviceBrand: undefined }
export const IMemoryReadTool = createDecorator<IMemoryReadTool>('memoryReadTool');
export class MemoryReadTool implements IMemoryReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemoryRead';
  readonly description = 'Read full saved memory by `id` or `ids` (up to 10) across scopes visible to this persona. Use it to recover omitted conditions and inspect existing entries before an update, replacement, merge, or archive; reuse a full, current read already in view. Returns the entry\'s revision for `expected_revision`.\n\nCheck status: archived and superseded entries can be returned as history, while pending entries are excluded. Read does not return scope; retain the original scope from MemorySearch\'s `scope.kind` or a known write receipt and pass it explicitly to MemoryWrite. If the scope is unknown, recover it through search before modifying the entry. An unavailable entry is returned with `missing: true`.';
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
