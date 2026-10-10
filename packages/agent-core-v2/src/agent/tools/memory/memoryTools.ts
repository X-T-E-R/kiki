import { z } from 'zod';
import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IMemoryStore, MemoryDomainError, memoryBasisSchema, memoryValiditySchema, memoryCoveredBySchema, memoryApplicability, type MemoryEntry, type MemoryTarget } from '#/app/memory/memoryStore';
import type { MemoryScope } from '#/app/memory/memoryScopes';
import { IAgentMemorySnapshot, type MemoryPersonaContext } from '#/app/memory/memorySnapshot';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

const typeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
const scopeSchema = z.enum(['global', 'workspace', 'persona', 'persona_workspace']);
const basisSchema = memoryBasisSchema.extend({
  kind: memoryBasisSchema.shape.kind.describe('human: directly supported human guidance; observed: verified facts or source material; derived: agent interpretation or unverified relay; unknown: attribution is not established.'),
  note: memoryBasisSchema.shape.note.describe("A concise faithful statement of the supporting evidence and any derived part, 1–500 characters. Preserve the source's scope and strength."),
  refs: memoryBasisSchema.shape.refs.describe('Up to 8 original source locators, each 1–500 characters, such as a history session/turn/message or authoritative path. Omit unavailable locators instead of inventing them.'),
});
const validitySchema = memoryValiditySchema.extend({
  check: memoryValiditySchema.shape.check.describe('What must be checked before relying on this content, 1–300 characters. Include task or event boundaries when relevant.'),
  until: memoryValiditySchema.shape.until.describe('Supported hard endpoint as an RFC3339 timestamp with timezone. Do not invent a date. After it, the entry remains stored but is not a current premise.'),
});
const writeSchema = z.object({
  action: z.enum(['create', 'update', 'supersede', 'archive']).describe('Update an existing rule; create only new guidance. Supersede creates a distinct replacement ID. Archive retires an entry while preserving its content.'),
  scope: scopeSchema.optional().describe('Explicit destination for create, or owning scope for an existing target. Create defaults to the bound persona, otherwise workspace. For other actions, omission resolves a unique visible, permitted ID; it never moves the entry.'),
  id: z.string().optional().describe('Existing target for update, supersede, or archive; omit for create. Normally maintain the current active entry. Restore a historical entry only under explicit restoration intent, reconciling any active successor. This does not approve a pending proposal.'),
  expected_revision: z.string().optional().describe('Latest target revision from a complete read or receipt. Required for existing targets. Refresh and reconcile after a conflict; do not repeat a stale request.'),
  type: typeSchema.optional().describe('feedback: working guidance; user: user information; project: useful project knowledge without an authoritative home; reference: a discovery pointer. Required except for archive.'),
  title: z.string().min(1).max(200).optional().describe('Recognizable stable subject, 1–200 characters. Include a useful applicability qualifier when needed. Required except for archive.'),
  body: z.string().min(1).max(1_500).optional().describe('Complete current content, 1–1,500 characters, including applicability and all action-changing conditions. Update replaces it in full. Archive preserves stored content and ignores legacy content fields.'),
  reason: z.string().min(1).describe('Why this change is justified. Include correction, retirement, or consolidation rationale; do not put retired values into the active rule merely to keep history.'),
  basis: basisSchema.optional().describe('Content evidence, separate from the automatically recorded writer. Provide for new or substantively revised content. Do not attribute an agent interpretation to the user.'),
  validity: validitySchema.nullable().optional().describe('Checks for a changing fact. Omit on update to preserve the existing value; use null only when evidence justifies clearing it. A missing value does not mean permanent validity.'),
  covered_by: memoryCoveredBySchema.extend({
    id: memoryCoveredBySchema.shape.id.describe("Retained entry that fully covers the target's current content and applicability; must not be the target itself."),
    expected_revision: memoryCoveredBySchema.shape.expected_revision.describe('Revision of the retained active entry whose full content was checked.'),
  }).optional().describe('For consolidation archive only: the retained same-scope active entry and its latest revision. The store checks this dependency again when applying the retirement.'),
}).strict();
const searchSchema = z.object({
  mode: z.enum(['search', 'list']).optional().describe('search for ranked lexical recall; list for a paged inventory. Defaults to search. Listing is not required before ordinary writes.'),
  query: z.string().min(1).max(200).optional().describe('Short subject, title, or alias: 1–200 characters and at most 10 whitespace-separated words. Required for search and not accepted for list.'),
  scope: scopeSchema.optional().describe('Limit to this visible scope; omit for all visible scopes. Does not grant access to other workspaces or personas.'),
  type: typeSchema.optional().describe('Optional type filter. Omit when the saved type is unknown.'),
  statuses: z.array(z.enum(['active', 'pending', 'superseded', 'archived'])).min(1).max(4).optional().describe('Statuses to inspect; defaults to active. Historical and pending entries are not effective guidance.'),
  include_superseded: z.boolean().optional().describe('Legacy option: true selects active and superseded entries. Do not combine with statuses.'),
  page_size: z.number().int().min(1).max(20).optional().describe('Items per page, 1–20. Defaults to 8 for search and 20 for list.'),
  cursor: z.string().optional().describe('Continue a previous page with cursor alone, preserving its scopes, filters, order, and page size.'),
}).strict();
const readSchema = z.object({
  id: z.string().optional().describe('One entry ID. Supply exactly one of id and ids.'),
  ids: z.array(z.string()).min(1).max(10).optional().describe('1–10 entry IDs. Read related entries together when their conditions must be compared.'),
  scope: scopeSchema.optional().describe('Optional visible owning scope. Omit to resolve across visible scopes; ambiguous matches are not selected silently.'),
  include_pending: z.boolean().optional().describe('Include known pending proposals for state inspection. Defaults to false; a returned proposal is still not active guidance.'),
}).strict();
function scopes(session: ISessionContext, persona: MemoryPersonaContext | undefined): readonly MemoryScope[] {
  const shared = persona?.shared ?? ['global', 'workspace'];
  return [
    ...(shared.includes('global') ? [{ kind: 'global' } as const] : []),
    ...(shared.includes('workspace') ? [{ kind: 'workspace', workspaceId: session.workspaceId } as const] : []),
    ...(persona === undefined ? [] : [{ kind: 'persona', personaId: persona.id } as const, { kind: 'persona_workspace', workspaceId: session.workspaceId, personaId: persona.id } as const]),
  ];
}
function resolveScope(kind: z.infer<typeof scopeSchema> | undefined, session: ISessionContext, persona: MemoryPersonaContext | undefined): MemoryScope {
  const wanted = kind ?? (persona === undefined ? 'workspace' : 'persona');
  const found = scopes(session, persona).find((scope) => scope.kind === wanted);
  if (found === undefined) throw new MemoryDomainError('scope_mismatch', `This context cannot access ${wanted} memory`, 'Choose one of this context’s visible scopes. Scope selection does not grant access.');
  return found;
}
function available(snapshot: ICapabilitySnapshotService, session: ISessionContext, tool = 'MemoryWrite'): boolean {
  return snapshot.toolAvailable(tool, session.workspaceId, session.sessionId);
}
function target(scope: MemoryScope, entry: MemoryEntry): MemoryTarget {
  return { scope: scope.kind, id: entry.id, expected_revision: entry.revision };
}
function failure(error: unknown, defaultCode = 'storage_unavailable'): { isError: true; output: string } {
  return { isError: true, output: JSON.stringify(error instanceof MemoryDomainError
    ? { code: error.code, message: error.message, recovery: error.recovery }
    : { code: defaultCode, message: error instanceof Error ? error.message : String(error), recovery: 'Inspect current state and storage before one corrected retry; do not create a duplicate.' }) };
}
async function matches(store: IMemoryStore, visible: readonly MemoryScope[], id: string): Promise<{ entry: MemoryEntry; scope: MemoryScope }[]> {
  const found = await Promise.all(visible.map(async (scope) => ({ entry: await store.get(scope, id), scope })));
  return found.flatMap(({ entry, scope }) => entry === undefined ? [] : [{ entry, scope }]);
}
function lookupFailure(code: 'not_found' | 'ambiguous_target' | 'scope_mismatch', found: readonly { entry: MemoryEntry; scope: MemoryScope }[]): { isError: true; output: string } {
  return { isError: true, output: JSON.stringify({ code, message: code === 'ambiguous_target' ? 'The ID exists in multiple visible scopes' : code === 'scope_mismatch' ? 'The target belongs to another visible scope' : 'Memory not found',
    recovery: 'Read the visible target in its owning scope and copy its target fields; do not create a duplicate.', visible_targets: found.map(({ entry, scope }) => ({ ...target(scope, entry), owner_scope: scope, title: entry.title, status: entry.status })) }) };
}

export interface IMemoryWriteTool extends AgentTool<z.infer<typeof writeSchema>> { readonly _serviceBrand: undefined }
export const IMemoryWriteTool = createDecorator<IMemoryWriteTool>('memoryWriteTool');
export class MemoryWriteTool implements IMemoryWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemoryWrite';
  readonly description = `Maintain durable guidance for future relevant tasks. First choose its home: lasting preferences and working rules belong in memory; current progress, schedules, one-off exceptions, and temporary experiments belong in task records. When an authoritative file already contains the guidance, prefer a useful pointer over a second copy. Apply direct user instructions to the current task independently of storage.

Reuse a complete, current entry already in view; otherwise search for the subject and read related entries in full. Leave an already complete rule unchanged. Prefer update on the same ID, preserving valid conditions and exceptions. Create only genuinely new guidance. Supersede creates a distinct replacement ID and retires its predecessor only when the replacement is active. Archive revoked or fully covered entries; for consolidation, first confirm the retained same-scope entry is active and pass its id and revision in covered_by. Do not replace global guidance with a narrower workspace entry or erase an intentional local exception.

For create, update, and supersede, provide type, title, the complete body, and reason. Name a stable subject and state the current guidance faithfully, with the source-backed conditions that change its application. Make the body immediately understandable; omit generic permission, safety, or honesty disclaimers added by the agent. Preserve explicit limits and exceptions, not imagined ones. Keep correction history and retired values in reason. Provide basis for new or substantively revised content, distinguishing human guidance, observed evidence, and agent-derived interpretation. A changing fact needs a validity check; add until only for a supported hard endpoint. Omitted validity is preserved on update; null explicitly clears it. Do not store secrets or pretend that a write's turn is the original human source.

For update, supersede, and archive, provide id and expected_revision. Copy the fields from a returned target when available. An explicit scope limits the target; when omitted for these actions, the ID must resolve uniquely within the caller's visible, permitted scopes. Create alone defaults to the bound persona, otherwise workspace. Scope resolution never moves an entry or grants access to another workspace or persona.

Archive is a state change: provide the target and reason, not a replacement body. The store preserves the original content. Exact no-change updates return unchanged without a new revision or journal operation. The receipt contains the stored or proposed full entry; verify it there instead of routinely rereading. Pending is not active, and unchanged is not a new write. On a lookup, coverage, or revision error, follow the recovery details, reread as needed, and make one corrected retry; never create a duplicate to bypass the failure. If it still fails, preserve the unsaved change in the task handoff and continue unrelated work.`;
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
    if (!parsed.success) return failure(parsed.error, 'invalid_input');
    const input = parsed.data;
    if (input.action !== 'archive' && (input.type === undefined || input.title === undefined || input.body === undefined)) return failure(new MemoryDomainError('invalid_input', 'type, title and body are required for this action', 'Provide the complete current content; archive alone preserves stored content.'));
    if (input.action === 'create' ? input.id !== undefined || input.expected_revision !== undefined : input.id === undefined) return failure(new MemoryDomainError('invalid_input', 'Invalid action target', 'Omit id and expected_revision for create; provide id for existing targets.'));
    if (input.action !== 'create' && !input.expected_revision) return failure(new MemoryDomainError('missing_revision', 'Memory revision is required', 'Read the complete target and copy its latest revision.'));
    if (input.action !== 'archive' && input.covered_by !== undefined) return failure(new MemoryDomainError('invalid_input', 'covered_by is only accepted for archive', 'Remove covered_by from this action.'));
    return { approvalRule: this.name, accesses: ToolAccesses.none(), description: `Remember: ${(input.title ?? input.id ?? '').slice(0, 70)}`, execute: async ({ turnId }) => {
      if (this.session.ephemeral === true || !available(this.capabilities, this.session)) return failure(new MemoryDomainError('inactive_target', 'Memory is disabled.', 'Preserve an unsaved change in existing task records instead of bypassing this restriction.'));
      try {
        const persona = this.memorySnapshot.getPersona();
        const visible = scopes(this.session, persona);
        let scope: MemoryScope;
        if (input.action === 'create') scope = resolveScope(input.scope, this.session, persona);
        else {
          if (input.scope !== undefined) resolveScope(input.scope, this.session, persona);
          const found = await matches(this.store, visible, input.id!);
          const selected = input.scope === undefined ? found : found.filter((item) => item.scope.kind === input.scope);
          if (selected.length !== 1) return lookupFailure(selected.length > 1 ? 'ambiguous_target' : found.length > 0 ? 'scope_mismatch' : 'not_found', found);
          scope = selected[0]!.scope;
        }
        const result = await this.store.put({ action: input.action, scope, type: input.type, title: input.title, body: input.body, reason: input.reason,
          id: input.id, expectedRevision: input.expected_revision, basis: input.basis, validity: input.validity, covered_by: input.covered_by,
          source: { writer: 'agent', session: this.session.sessionId, turn: turnId }, pending: this.config.get<MemoryConfig>(MEMORY_SECTION).approval === 'review' });
        const outcome = result.outcome;
        const entry = result.entry;
        const owningTarget = target(scope, entry);
        const proposedTarget = outcome === 'pending' && entry.supersedes !== undefined && entry.supersedes_revision !== undefined
          ? { scope: scope.kind, id: entry.supersedes, expected_revision: entry.supersedes_revision } : undefined;
        const hint = outcome === 'unchanged' ? 'The stored content already matches. No revision, journal operation, or projection refresh was created.'
          : outcome === 'pending' ? `This is a pending proposal, not active guidance.${proposedTarget === undefined ? '' : input.action === 'supersede' ? ' The predecessor is unchanged.' : ' The existing active entry is unchanged.'} Apply direct human instructions to the current task independently; do not retire entries that still depend on this proposal.`
          : 'The returned entry is the stored result. Reuse it as the current read; do not verify with another read unless something is incomplete or has changed.';
        return { spillExempt: true, memoryReceipt: { action: input.action, outcome, id: entry.id, revision: entry.revision, status: entry.status,
          operationId: result.operationId ?? undefined, ownerScope: scope, target: owningTarget, proposedTarget },
          output: JSON.stringify({ action: input.action, outcome, id: entry.id, title: entry.title, scope: scope.kind, owner_scope: scope, target: owningTarget,
            status: entry.status, revision: entry.revision, operation_id: result.operationId, entry, proposed_target: proposedTarget, covered_by: entry.covered_by, warnings: result.warnings, reference_hint: hint }) };
      } catch (error) {
        if (error instanceof MemoryDomainError && error.code === 'duplicate_title') {
          const scope = resolveScope(input.scope, this.session, this.memorySnapshot.getPersona());
          const found = (await this.store.list(scope, true)).filter((entry) => entry.status === 'active' && entry.title.toLowerCase() === input.title?.trim().toLowerCase()).map((entry) => ({ entry, scope }));
          return { isError: true, output: JSON.stringify({ code: error.code, message: error.message, recovery: error.recovery, visible_targets: found.map(({ entry, scope }) => ({ ...target(scope, entry), owner_scope: scope, title: entry.title, status: entry.status })) }) };
        }
        return failure(error);
      }
    } };
  }
}

export interface IMemorySearchTool extends AgentTool<z.infer<typeof searchSchema>> { readonly _serviceBrand: undefined }
export const IMemorySearchTool = createDecorator<IMemorySearchTool>('memorySearchTool');
export class MemorySearchTool implements IMemorySearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemorySearch';
  readonly description = `Find saved guidance in scopes visible to this context. Use mode=search, the default, for a short subject, title, or alias query when relevant details are missing. Reuse complete current entries already in view. Ranked search is for recall, not proof that no related rule exists. Use mode=list for a browsable inventory when a known entry is missing or scoped maintenance requires coverage; do not scan the whole inventory before ordinary work.

Search requires query: 1–200 characters and at most 10 whitespace-separated words. List accepts no query. Omitted scope searches all visible scopes; type and statuses narrow the result. Statuses default to active only. Explicit historical or pending results are not current guidance. The legacy include_superseded option means active plus superseded and cannot be combined with statuses.

Returns an object with items, next_cursor, and coverage. Search defaults to 8 results and list to 20; page_size is 1–20. Continue with cursor alone, including an empty preparation page with exhausted=false. Source scan budgets limit each call, not the retrievable inventory; ranking is local to each bounded source chunk. Coverage identifies the exact scopes and filters, whether more pages remain, and whether input was skipped or unavailable. Exhausted complete search covers that lexical query, not every possible wording. If a cursor is invalidated by changes, restart the query and reconcile IDs rather than claiming a complete inventory.

Each item has its complete title, status, owning scope, revision, and a target whose fields can be copied into MemoryWrite. Search snippets are at most 200 characters; they omit conditions. Read relevant entries in full before relying on omitted details, replacing, or merging them. An expired item is a historical lead; a recheck item requires current evidence. Query errors are reported as errors, not empty search results.`;
  readonly parameters = toInputJsonSchema(searchSchema);
  constructor(
    @IMemoryStore private readonly store: IMemoryStore,
    @ISessionContext private readonly session: ISessionContext,
    @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService,
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
  ) {}
  resolveExecution(args: z.infer<typeof searchSchema>): ToolExecution {
    const parsed = searchSchema.safeParse(args);
    if (!parsed.success) return failure(parsed.error, 'invalid_query');
    const input = parsed.data;
    if (input.statuses !== undefined && input.include_superseded !== undefined) return failure(new MemoryDomainError('invalid_query', 'statuses cannot be combined with include_superseded', 'Use statuses alone for explicit state filters.'));
    if (input.cursor !== undefined && Object.keys(input).some((key) => key !== 'cursor')) return failure(new MemoryDomainError('cursor_invalidated', 'Continue with cursor alone', 'Restart the query if its filters need changing.'));
    return { approvalRule: this.name, accesses: ToolAccesses.none(), execute: async () => {
      if (!available(this.capabilities, this.session, this.name)) return failure(new MemoryDomainError('inactive_target', 'Memory is disabled.', 'Use current guidance already in view.'));
      try {
        const persona = this.memorySnapshot.getPersona();
        if (input.scope !== undefined) resolveScope(input.scope, this.session, persona);
        const page = await this.store.query(scopes(this.session, persona), input.cursor !== undefined ? { cursor: input.cursor } : {
          mode: input.mode, query: input.query, scope: input.scope, type: input.type, page_size: input.page_size,
          statuses: input.statuses ?? (input.include_superseded === true ? ['active', 'superseded'] : undefined),
        });
        return { output: JSON.stringify({ ...page, items: page.items.map((entry) => ({ id: entry.id, title: entry.title, type: entry.type, status: entry.status,
          revision: entry.revision, scope: entry.scope, target: target(entry.scope, entry), basis_kind: entry.basis?.kind ?? 'unknown', applicability: memoryApplicability(entry),
          snippet: page.mode === 'search' ? entry.body.slice(0, 200) : undefined, score: page.mode === 'search' ? entry.score : undefined })) }) };
      } catch (error) { return failure(error); }
    } };
  }
}

export interface IMemoryReadTool extends AgentTool<z.infer<typeof readSchema>> { readonly _serviceBrand: undefined }
export const IMemoryReadTool = createDecorator<IMemoryReadTool>('memoryReadTool');
export class MemoryReadTool implements IMemoryReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MemoryRead';
  readonly description = `Read full saved memory by id or ids, up to 10 entries. Supply exactly one of id and ids. Omitted scope resolves IDs across scopes visible to this context; an explicit scope limits the lookup. Ambiguous IDs return visible candidates rather than choosing a scope silently.

Use this to recover missing conditions or inspect an entry before changing or combining it. Reuse a complete current read already in view. Each result includes the full entry, owning scope, latest revision, applicability, and target fields ready to copy into MemoryWrite. If output is incomplete, it is marked incomplete and must not be used as a full replacement source.

Check status and validity. Archived and superseded entries are history, not current guidance. Pending entries are excluded unless include_pending=true; reading a proposal does not activate it. Expired entries are historical leads. A validity check describes what must be verified before relying on a changing fact; missing validity metadata is not proof of permanence. Missing and ambiguous results include recovery information where it can be disclosed. A successful write receipt already containing the full stored entry does not need a routine verification read.`;
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
    if (!parsed.success || (parsed.data.id === undefined) === (parsed.data.ids === undefined)) return failure(new MemoryDomainError('invalid_input', 'Provide exactly one of id or ids (up to 10).', 'Use id for one entry or ids for a related batch.'));
    return { approvalRule: this.name, accesses: ToolAccesses.none(), execute: async () => {
      if (!available(this.capabilities, this.session, this.name)) return failure(new MemoryDomainError('inactive_target', 'Memory is disabled.', 'Use current guidance already in view.'));
      try {
        const persona = this.memorySnapshot.getPersona();
        const visible = parsed.data.scope === undefined ? scopes(this.session, persona) : [resolveScope(parsed.data.scope, this.session, persona)];
        const items = await Promise.all((parsed.data.ids ?? [parsed.data.id!]).map(async (id) => {
          const found = await matches(this.store, visible, id);
          if (found.length > 1) return { id, missing: true, ...JSON.parse(lookupFailure('ambiguous_target', found).output) };
          const item = found[0];
          if (item === undefined) return { id, missing: true, reason: 'not_found', recovery: 'Locate the ID in visible scopes; do not create a duplicate to bypass lookup.' };
          if (item.entry.status === 'pending' && !parsed.data.include_pending) return { id, missing: true, reason: 'pending_excluded', recovery: 'Use include_pending=true to inspect the proposal; it is not active guidance.' };
          return { ...item.entry, scope: item.scope, target: target(item.scope, item.entry), applicability: memoryApplicability(item.entry), basis_kind: item.entry.basis?.kind ?? 'unknown', complete: true };
        }));
        return { spillExempt: true, output: JSON.stringify(items) };
      } catch (error) { return failure(error); }
    } };
  }
}

const when = (accessor: ServicesAccessor): boolean => accessor.get(IAgentScopeContext).agentId === 'main';
registerAgentToolService(IMemoryWriteTool, MemoryWriteTool, { name: 'MemoryWrite', domain: 'memory', when: (accessor) => !accessor.get(ISessionContext).ephemeral && when(accessor) });
registerAgentToolService(IMemorySearchTool, MemorySearchTool, { name: 'MemorySearch', domain: 'memory' });
registerAgentToolService(IMemoryReadTool, MemoryReadTool, { name: 'MemoryRead', domain: 'memory' });
