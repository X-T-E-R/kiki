import { createHash } from 'node:crypto';

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution, type ExecutableToolResult } from '#/tool/toolContract';

const AgentIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((id) => id !== '.' && id !== '..');

export const HistorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(1024).optional().describe('Distinctive words or a phrase; required on the first page. Omit when continuing with cursor.'),
  mode: z.enum(['auto', 'all', 'any', 'literal', 'terms']).optional().describe('Defaults to auto: matching complete phrases, without requiring every phrase. all requires every phrase; any allows one; literal is contiguous; terms preserves the legacy token-AND behavior.'),
  scope: z.enum(['session', 'this_session', 'workspace']).optional().describe('Defaults to session (this session, this agent). workspace explicitly searches other sessions; this_session is the locked-current-session legacy alias.'),
  session_id: z.string().min(1).max(256).optional().describe('Choose a known session when scope=session; another session defaults to agent main.'),
  workspace_id: z.string().min(1).max(512).optional().describe('Defaults to this workspace; another workspace requires access approval.'),
  agent_id: AgentIdSchema.optional().describe('Exact agent ID; defaults to this agent in the current session, or main in another session/workspace.'),
  include_subagents: z.boolean().optional().describe('Search all readable agents in the selected scope; mutually exclusive with agent_id.'),
  role: z.enum(['user', 'assistant', 'tool']).optional().describe('Optional exact source role; by default search all three.'),
  after: z.iso.datetime({ offset: true }).optional().describe('Include matches at or after this RFC3339 timestamp with timezone.'),
  before: z.iso.datetime({ offset: true }).optional().describe('Exclude matches at or after this RFC3339 timestamp with timezone.'),
  sort: z.enum(['relevance', 'newest', 'oldest']).optional().describe('Defaults to relevance; newest/oldest sort matched text by time.'),
  source: z.enum(['auto', 'transcript']).optional().describe('Defaults to auto; transcript scans one specified session beyond indexed tool-output tails.'),
  cursor: z.string().min(1).max(4096).optional().describe('Continue a result or scan page; pass alone, or repeat only matching query parameters.'),
  limit: z.number().int().min(1).max(20).optional().describe('Number of hits per page, defaults to 5.'),
}).strict().refine((input) => input.query !== undefined || input.cursor !== undefined, {
  message: 'Provide query or cursor.',
});

export const HistoryReadInputSchema = z.object({
  session_id: z.string().min(1).max(256).optional().describe('Session to read; defaults to this session. A cursor supplies its original session.'),
  workspace_id: z.string().min(1).max(512).optional().describe('Workspace ID; another workspace requires explicit access approval.'),
  agent_id: AgentIdSchema.optional().describe('Exact agent ID; defaults to this agent here or main in another session.'),
  turn: z.number().int().nonnegative().optional().describe('0-based transcript turn; omit when step_id or cursor identifies it.'),
  step_id: z.string().regex(/^t\d+\.\d+$/).optional().describe('Step ID such as t42.3; sufficient without turn.'),
  ref: z.string().min(1).max(2048).optional().describe('Durable source ref; a List turn ref reads the whole turn as blocks, while a Search hit ref reads one focused text block.'),
  start_char: z.number().int().nonnegative().optional().describe('For one text-block ref, read from this UTF-16 offset (use range.end after a cursor expires).'),
  max_chars: z.number().int().min(1000).max(20_000).optional().describe('Text budget per page, defaults to 6000 UTF-16 characters.'),
  cursor: z.string().min(1).max(4096).optional().describe('Pass alone to continue a previous Read page.'),
}).strict().refine((input) => input.turn !== undefined || input.step_id !== undefined || input.ref !== undefined || input.cursor !== undefined, {
  message: 'Provide ref, turn, step_id, or cursor.',
});

export interface HistoryHit {
  readonly sessionId: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'title';
  readonly turn?: number;
  readonly stepId?: string;
  readonly snippet: string;
  readonly ref?: string;
  readonly time?: number;
  readonly matched?: readonly string[];
}

export interface HistorySearchPage {
  readonly items: readonly HistoryHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: string;
  readonly indexState: { readonly state: string; readonly stale?: boolean; readonly degraded?: string };
  readonly warning?: string;
  readonly fallback?: {
    readonly reason: string;
    readonly scope: string;
    readonly maxBytes: number;
    readonly maxRecords: number;
    readonly bytesRead: number;
    readonly recordsRead: number;
    readonly truncated: boolean;
  };
  readonly source: 'live' | 'index' | 'fallback';
  readonly coverage?: { readonly complete: boolean; readonly domain: 'indexed_text' | 'full_text'; readonly gaps?: readonly string[]; readonly scanned?: { readonly bytes: number; readonly records: number } };
  readonly continuation?: 'results' | 'scan';
}

export interface HistoryReadBlock {
  readonly ref: string;
  readonly turn: number;
  readonly stepId?: string;
  readonly role?: 'user' | 'assistant' | 'tool';
  readonly toolName?: string;
  readonly part?: string;
  readonly text: string;
  readonly range: { readonly start: number; readonly end: number; readonly total: number; readonly unit: 'utf16' };
}

export interface HistoryReadBlocksPage {
  readonly status: 'ok' | 'stale_ref' | 'source_missing' | 'navigation_building' | 'invalid_ref';
  readonly blocks?: readonly HistoryReadBlock[];
  readonly next?: { readonly position: number; readonly offset: number; readonly watermark: number;
    readonly asOfBytes: number };
  readonly complete?: boolean;
}

export interface IHistoryArchive {
  readonly _serviceBrand: undefined;
  search(query: {
    query: string;
    mode?: 'auto' | 'all' | 'any' | 'literal' | 'terms';
    workspaceId: string;
    sessionId?: string;
    agentId?: string;
    includeSubagents?: boolean;
    role?: 'user' | 'assistant' | 'tool';
    after?: number;
    before?: number;
    sort?: 'relevance' | 'newest' | 'oldest';
    source?: 'auto' | 'transcript';
    pageSize: number;
    pageToken?: string;
    fallbackSessionId?: string;
    fallbackAgentId?: string;
    signal?: AbortSignal;
  }): Promise<HistorySearchPage>;
  readTurn(sessionId: string, agentId: string, turn: number, stepId?: string): Promise<string | undefined>;
  readRef?(ref: string): Promise<{ status: 'ok'; text?: string; turn: number; stepId?: string;
    role?: 'user' | 'assistant' | 'tool'; toolName?: string; part?: string; ref: string } |
    { status: 'stale_ref' | 'source_missing' | 'invalid_ref' }>;
  directoryRef?(workspace: string, session: string, agent: string, turn: number, step?: string): Promise<string | undefined>;
  readDirectory?(ref: string, maxChars: number, cursor?: { readonly position: number;
    readonly offset: number; readonly watermark: number; readonly asOfBytes: number }): Promise<HistoryReadBlocksPage>;
}

export const IHistoryArchive = createDecorator<IHistoryArchive>('historyArchive');
export const IHistorySearchTool = createDecorator<AgentTool<z.infer<typeof HistorySearchInputSchema>>>('historySearchTool');
export const IHistoryReadTool = createDecorator<AgentTool<z.infer<typeof HistoryReadInputSchema>>>('historyReadTool');

const PAGE_CHARS = 3_000;

type ReadCursor = { v: 1; session: string; agent: string; turn: number; step?: string; offset: number; hash: string };
type BlockCursor = { v: 2; ref: string; offset: number; maxChars: number };
type DirectoryCursor = { v: 3; ref: string; maxChars: number; position: number; offset: number;
  watermark: number; asOfBytes: number };
type RefTarget = { workspace: string; session: string; agent: string;
  kind?: 'turn' | 'step' | 'frame'; focus?: number };

function decodeDirectoryCursor(cursor: string | undefined): DirectoryCursor | undefined {
  if (cursor === undefined) return undefined;
  let raw: Partial<DirectoryCursor>;
  try { raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<DirectoryCursor>; }
  catch { return undefined; }
  if (raw?.v !== 3) return undefined;
  if (typeof raw.ref !== 'string' || !raw.ref.startsWith('h1_') || raw.ref.length > 2048 ||
      !Number.isSafeInteger(raw.position) || raw.position! < 0 ||
      !Number.isSafeInteger(raw.offset) || raw.offset! < 0 ||
      !Number.isSafeInteger(raw.watermark) || raw.watermark! < raw.position! ||
      !Number.isSafeInteger(raw.asOfBytes) || raw.asOfBytes! < 0 ||
      !Number.isSafeInteger(raw.maxChars) || raw.maxChars! < 1000 || raw.maxChars! > 20_000) {
    throw new Error('Invalid HistoryRead directory cursor; reopen its ref.');
  }
  return raw as DirectoryCursor;
}

function decodeBlockCursor(cursor: string | undefined): BlockCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<BlockCursor>;
    if (raw?.v !== 2) return undefined;
    if (typeof raw.ref !== 'string' || !Number.isSafeInteger(raw.offset) || raw.offset! < 0 ||
        !Number.isSafeInteger(raw.maxChars) || raw.maxChars! < 1000 || raw.maxChars! > 20_000) {
      throw new Error('invalid');
    }
    return raw as BlockCursor;
  } catch { return undefined; }
}

function refTarget(ref: string): RefTarget {
  if (!ref.startsWith('h1_') || ref.length > 2048) throw new Error('Invalid HistoryRead ref.');
  try {
    const value = JSON.parse(Buffer.from(ref.slice(3), 'base64url').toString('utf8')) as Partial<RefTarget>;
    if (typeof value.workspace === 'string' && value.workspace.length > 0 &&
        typeof value.session === 'string' && value.session.length > 0 &&
        typeof value.agent === 'string' && AgentIdSchema.safeParse(value.agent).success &&
        (value.kind === undefined || value.kind === 'turn' || value.kind === 'step' || value.kind === 'frame') &&
        (value.focus === undefined || Number.isSafeInteger(value.focus) && value.focus >= 0)) return value as RefTarget;
  } catch {}
  throw new Error('Invalid HistoryRead ref.');
}

function readCursor(value: string | undefined): ReadCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const c = data as Partial<ReadCursor>;
      if (c.v === 1 && typeof c.session === 'string' && typeof c.agent === 'string' &&
          Number.isSafeInteger(c.turn) && (c.step === undefined || typeof c.step === 'string') &&
          Number.isSafeInteger(c.offset) && (c.offset as number) >= 0 && typeof c.hash === 'string') {
        return c as ReadCursor;
      }
    }
  } catch {}
  throw new Error('Invalid HistoryRead cursor.');
}

abstract class HistoryToolBase {
  constructor(
    protected readonly archive: IHistoryArchive,
    protected readonly session: ISessionContext,
    protected readonly workspaces: IWorkspaceService,
  ) {}

  protected async target(workspaceId?: string): Promise<{ id: string; externalRoot?: string }> {
    const id = workspaceId ?? this.session.workspaceId;
    if (id === this.session.workspaceId) return { id };
    const workspace = await this.workspaces.get(id);
    if (workspace === undefined) throw new Error('Workspace not found.');
    return { id, externalRoot: workspace.root };
  }
}

const SEARCH_DEFAULT_LIMIT = 5;

type SearchInput = z.infer<typeof HistorySearchInputSchema>;
type SearchCursor = { v: 2; request: SearchInput; page: string };

function decodeSearchCursor(value: string): SearchCursor {
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (raw !== null && typeof raw === 'object' && 'v' in raw && raw.v === 2 &&
        'request' in raw && 'page' in raw && typeof raw.page === 'string') {
      const request = HistorySearchInputSchema.safeParse(raw.request);
      if (request.success && request.data.query !== undefined && request.data.cursor === undefined) {
        return { v: 2, request: request.data, page: raw.page };
      }
    }
  } catch {}
  throw new Error('Invalid HistorySearch cursor; restart with {query:"..."}.');
}

export class HistorySearchTool extends HistoryToolBase implements AgentTool<SearchInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'HistorySearch';
  readonly description = 'Find earlier user, assistant, or tool text. Defaults to this session and this agent, with auto phrase matching. To search other sessions use scope=workspace or select a session_id; include_subagents explicitly expands to other readable agents. This is lexical search. Check coverage when results may be partial; use a hit ref when present or its turn/step with HistoryRead. Pass only cursor to continue available pages; use HistoryList without search words.';
  readonly parameters = toInputJsonSchema(HistorySearchInputSchema, (schema) => {
    schema['anyOf'] = [{ required: ['query'] }, { required: ['cursor'] }];
  });

  constructor(
    @IHistoryArchive archive: IHistoryArchive,
    @ISessionContext session: ISessionContext,
    @IWorkspaceService workspaces: IWorkspaceService,
    @IAgentScopeContext private readonly caller: IAgentScopeContext,
    @ISessionIndex private readonly sessions: ISessionIndex,
  ) { super(archive, session, workspaces); }

  async resolveExecution(input: SearchInput): Promise<ToolExecution> {
    const cursor = input.cursor === undefined ? undefined : input.query === undefined
      ? decodeSearchCursor(input.cursor) : (() => { try { return decodeSearchCursor(input.cursor); } catch { return undefined; } })();
    const supplied = { ...input, cursor: undefined };
    const prior = cursor?.request;
    const mismatch = cursor !== undefined && Object.entries(supplied).some(
      ([key, value]) => value !== undefined && value !== prior?.[key as keyof SearchInput],
    );
    const request = prior ?? supplied;
    const scope = request.scope ?? 'session';
    if (request.include_subagents && request.agent_id !== undefined) throw new Error('agent_id and include_subagents are mutually exclusive.');
    if (scope === 'workspace' && request.session_id !== undefined) throw new Error('session_id requires scope=session.');
    if (scope === 'this_session' && request.session_id !== undefined && request.session_id !== this.session.sessionId) {
      throw new Error('this_session cannot target another session; use scope=session.');
    }
    if (request.after !== undefined && request.before !== undefined && Date.parse(request.after) >= Date.parse(request.before)) {
      throw new Error('after must be earlier than before.');
    }
    const sessionId = scope === 'workspace' ? undefined : request.session_id ?? this.session.sessionId;
    const agentId = request.include_subagents ? undefined : request.agent_id ??
      (sessionId === this.session.sessionId && scope !== 'workspace' ? this.caller.agentId : 'main');
    const target = await this.target(request.workspace_id);
    if (sessionId !== undefined) {
      const summary = await this.sessions.get(sessionId);
      if (summary === undefined || summary.workspaceId !== target.id) throw new Error('Session not found in the requested workspace.');
    }
    if (request.source === 'transcript' && sessionId === undefined) throw new Error('source=transcript requires one session.');
    return {
      approvalRule: this.name,
      description: 'Searching history',
      accesses: target.externalRoot === undefined ? ToolAccesses.none() : ToolAccesses.searchTree(target.externalRoot, true),
      execute: async (context) => {
        context.signal.throwIfAborted();
        if (mismatch) return { isError: true, output: JSON.stringify({ scope_used: scope,
          mode_used: request.mode ?? 'auto', target: { workspace_id: target.id, session_id: sessionId,
            agent_id: agentId, all_agents: request.include_subagents === true ? true : undefined }, error: {
            code: 'cursor_mismatch', message: 'HistorySearch cursor conflicts with the query.',
            retryable: true, next_call: { tool: 'HistorySearch', arguments: request },
          } }) };
        let page: HistorySearchPage;
        try {
          page = await this.archive.search({
            query: request.query!, mode: request.mode ?? 'auto', workspaceId: target.id,
            sessionId, agentId, includeSubagents: request.include_subagents,
            role: request.role, after: request.after === undefined ? undefined : Date.parse(request.after),
            before: request.before === undefined ? undefined : Date.parse(request.before),
            sort: request.sort, source: request.source, pageSize: request.limit ?? SEARCH_DEFAULT_LIMIT,
            pageToken: cursor?.page ?? (cursor === undefined ? input.cursor : undefined),
            fallbackSessionId: target.id === this.session.workspaceId ? this.session.sessionId : undefined,
            fallbackAgentId: target.id === this.session.workspaceId ? this.caller.agentId : undefined,
            signal: context.signal,
          });
          context.signal.throwIfAborted();
        } catch (error) {
          if (error instanceof Error && (error.message === 'stale_scan_cursor' || error.message === 'invalid_scan_cursor')) {
            return { isError: true, output: JSON.stringify({ scope_used: scope,
              mode_used: request.mode ?? 'auto', target: { workspace_id: target.id, session_id: sessionId,
                agent_id: agentId, all_agents: request.include_subagents === true ? true : undefined },
              error: { code: error.message,
                message: 'HistorySearch scan cursor is no longer available; restart the original query.',
                retryable: true, next_call: { tool: 'HistorySearch', arguments: request },
              } }) };
          }
          throw error;
        }
        const next = page.pageToken === undefined ? undefined : Buffer.from(JSON.stringify({
          v: 2, request: { ...request, cursor: undefined }, page: page.pageToken,
        } satisfies SearchCursor)).toString('base64url');
        const hits = page.items.filter((hit) => hit.turn !== undefined && hit.role !== 'title');
        const expandedMode = request.mode === 'literal' || request.mode === 'terms' ? request.mode : 'terms';
        return { output: JSON.stringify({
          schema_version: 2, status: page.incomplete !== undefined ||
            (page.coverage !== undefined ? !page.coverage.complete :
              (page.indexState.state !== 'ready' && page.source !== 'live') || request.include_subagents === true)
            ? 'partial' : hits.length > 0 ? 'ok' : 'no_match',
          target: { workspace_id: target.id, session_id: sessionId, agent_id: agentId,
            all_agents: request.include_subagents === true ? true : undefined },
          scope_used: scope, mode_used: request.mode ?? 'auto',
          expand_hint: scope !== 'workspace' && hits.length < (request.limit ?? SEARCH_DEFAULT_LIMIT)
            ? { message: expandedMode === (request.mode ?? 'auto')
              ? "Need results beyond this session? Retry with scope='workspace'."
              : "Need results beyond this session? Retry with scope='workspace', mode='terms' (indexed token-AND matching).",
              next_call: { tool: 'HistorySearch', arguments: { ...request, mode: expandedMode,
                scope: 'workspace', session_id: undefined, source: undefined, cursor: undefined } } }
            : undefined,
          hits: hits.map((hit) => ({ session_id: hit.sessionId, agent_id: hit.agentId, role: hit.role,
              turn: hit.turn, step_id: hit.stepId, ref: hit.ref, time: hit.time,
              snippet: hit.snippet, matched: hit.matched })),
          next_cursor: next, has_more: next !== undefined, continuation: page.continuation,
          incomplete: page.incomplete, index_state: page.indexState,
          warning: page.warning, fallback: page.fallback, source: page.source,
          coverage: page.coverage ?? { complete: page.incomplete === undefined &&
            (page.indexState.state === 'ready' || page.source === 'live') && request.include_subagents !== true,
            domain: page.source === 'live' ? 'full_text' : 'indexed_text',
            gaps: page.source === 'live' ? [] : request.include_subagents ? ['subagents_may_be_unindexed', 'tool_tail_not_indexed'] :
              ['tool_tail_not_indexed'] },
        }) };
      },
    };
  }
}

export class HistoryReadTool extends HistoryToolBase implements AgentTool<z.infer<typeof HistoryReadInputSchema>> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'HistoryRead';
  readonly description = 'Read original history as bounded source blocks. A HistoryList turn ref opens the entire turn; step_id such as t42.3 or a 0-based turn also selects a block directory. A Search hit ref starts near its match. Pass cursor alone for more blocks, or reopen one block by its ref plus start_char=range.end; stale refs report an error.';
  readonly parameters = toInputJsonSchema(HistoryReadInputSchema, (schema) => {
    schema['anyOf'] = [{ required: ['ref'] }, { required: ['turn'] }, { required: ['step_id'] }, { required: ['cursor'] }];
  });

  constructor(
    @IHistoryArchive archive: IHistoryArchive,
    @ISessionContext session: ISessionContext,
    @IWorkspaceService workspaces: IWorkspaceService,
    @ISessionIndex private readonly sessions: ISessionIndex,
    @IAgentScopeContext private readonly caller: IAgentScopeContext,
  ) { super(archive, session, workspaces); }

  private async renderDirectory(ref: string, maxChars: number, signal: AbortSignal,
    cursor?: DirectoryCursor): Promise<ExecutableToolResult> {
    signal.throwIfAborted();
    const page = await this.archive.readDirectory?.(ref, maxChars, cursor === undefined ? undefined : {
      position: cursor.position, offset: cursor.offset, watermark: cursor.watermark,
      asOfBytes: cursor.asOfBytes,
    });
    signal.throwIfAborted();
    if (page === undefined || page.status !== 'ok') return { isError: true, output: JSON.stringify({ error: {
      code: page?.status ?? 'source_missing',
      message: page?.status === 'navigation_building' ? 'Navigation is still building; retry this selector.' :
        'The historical turn or step source is missing or stale.',
      retryable: page?.status === 'navigation_building',
      next_call: { tool: 'HistoryRead', arguments: { ref } },
    } }) };
    const next = page.next === undefined ? undefined : Buffer.from(JSON.stringify({
      v: 3, ref, maxChars, ...page.next,
    } satisfies DirectoryCursor)).toString('base64url');
    const source = refTarget(ref);
    return { output: JSON.stringify({ schema_version: 2,
      status: page.complete === false ? 'partial' : (page.blocks?.length ?? 0) > 0 || next !== undefined ? 'ok' : 'no_match',
      target: { workspace_id: source.workspace, session_id: source.session, agent_id: source.agent },
      ref, source: 'transcript', coverage: { complete: page.complete === true,
        domain: 'full_text', gaps: page.complete ? [] : ['active_turn_or_step'] },
      blocks: page.blocks?.map((block) => ({ ref: block.ref, turn: block.turn,
        step_id: block.stepId, role: block.role, tool_name: block.toolName,
        part: block.part, text: block.text, range: block.range,
        has_earlier: block.range.start > 0 })), next_cursor: next, has_more: next !== undefined,
      continuation: next === undefined ? undefined : 'results',
    }) };
  }

  private async resolveDirectory(input: z.infer<typeof HistoryReadInputSchema>, ref: string,
    cursor?: DirectoryCursor): Promise<ToolExecution> {
    const source = refTarget(ref);
    if (source.kind !== 'turn' && source.kind !== 'step') throw new Error('Directory cursor requires a turn or step ref.');
    if (input.turn !== undefined || input.step_id !== undefined || input.start_char !== undefined ||
        input.cursor !== undefined && cursor === undefined ||
        cursor !== undefined && (input.ref !== undefined && input.ref !== ref ||
          input.max_chars !== undefined && input.max_chars !== cursor.maxChars)) {
      throw new Error('HistoryRead directory cursor conflicts with another selector.');
    }
    const summary = await this.sessions.get(source.session);
    if (summary === undefined) throw new Error('Session not found.');
    const target = await this.target(input.workspace_id ?? source.workspace);
    if (summary.workspaceId !== source.workspace || target.id !== source.workspace ||
        input.session_id !== undefined && input.session_id !== source.session ||
        input.agent_id !== undefined && input.agent_id !== source.agent) {
      throw new Error('HistoryRead ref conflicts with the requested target.');
    }
    const maxChars = cursor?.maxChars ?? input.max_chars ?? 6000;
    return { approvalRule: this.name, description: 'Reading historical turn or step blocks',
      accesses: target.externalRoot === undefined ? ToolAccesses.none() : ToolAccesses.readFile(target.externalRoot, true),
      execute: (context) => this.renderDirectory(ref, maxChars, context.signal, cursor) };
  }

  private async resolveRef(input: z.infer<typeof HistoryReadInputSchema>, cursor?: BlockCursor): Promise<ToolExecution> {
    const ref = cursor?.ref ?? input.ref!;
    const source = refTarget(ref);
    if (input.turn !== undefined || input.step_id !== undefined ||
        (input.cursor !== undefined && cursor === undefined) ||
        (cursor !== undefined && (input.ref !== undefined && input.ref !== ref ||
          input.start_char !== undefined && input.start_char !== cursor.offset ||
          input.max_chars !== undefined && input.max_chars !== cursor.maxChars))) {
      throw new Error('HistoryRead ref or cursor conflicts with another selector.');
    }
    const summary = await this.sessions.get(source.session);
    if (summary === undefined) throw new Error('Session not found.');
    const target = await this.target(input.workspace_id ?? source.workspace);
    if (summary.workspaceId !== source.workspace || target.id !== source.workspace ||
        input.session_id !== undefined && input.session_id !== source.session ||
        input.agent_id !== undefined && input.agent_id !== source.agent) {
      throw new Error('HistoryRead ref conflicts with the requested target.');
    }
    const limit = cursor?.maxChars ?? input.max_chars ?? 6000;
    const start = cursor?.offset ?? input.start_char ?? Math.max(0, (source.focus ?? 0) - 160);
    return {
      approvalRule: this.name, description: 'Reading historical source block',
      accesses: target.externalRoot === undefined ? ToolAccesses.none() : ToolAccesses.readFile(target.externalRoot, true),
      execute: async () => {
        const read = await this.archive.readRef?.(ref);
        if (read === undefined || read.status !== 'ok') return { isError: true, output: JSON.stringify({ error: {
          code: read?.status ?? 'source_missing',
          message: read?.status === 'invalid_ref' ? 'Invalid historical source ref; search for a fresh hit.' :
            'Historical source is missing or no longer matches this ref.',
          retryable: read?.status === 'stale_ref',
          next_call: { tool: 'HistorySearch', arguments: { query: '<distinctive words>' } },
        } }) };
        if (read.text === undefined) return { isError: true, output: JSON.stringify({ error: {
          code: 'no_text_block', message: 'This ref identifies a turn or step directory entry; read by its turn or step_id.',
          next_call: { tool: 'HistoryRead', arguments: { session_id: source.session, agent_id: source.agent,
            turn: read.turn, step_id: read.stepId } },
        } }) };
        if (start > read.text.length) return { isError: true, output: JSON.stringify({ error: {
          code: 'range_out_of_bounds', message: 'start_char exceeds the verified block length.',
          next_call: { tool: 'HistoryRead', arguments: { ref: read.ref, start_char: 0 } },
        } }) };
        let end = Math.min(read.text.length, start + limit);
        if (end < read.text.length && /[\uD800-\uDBFF]/.test(read.text[end - 1]!)) end -= 1;
        const next = end < read.text.length ? Buffer.from(JSON.stringify({ v: 2, ref: read.ref,
          offset: end, maxChars: limit } satisfies BlockCursor)).toString('base64url') : undefined;
        return { output: JSON.stringify({ schema_version: 2, status: 'ok', ref, target: {
          workspace_id: source.workspace, session_id: source.session, agent_id: source.agent },
          source: 'transcript', coverage: { complete: true, domain: 'full_text' },
          blocks: [{ ref: read.ref, turn: read.turn, step_id: read.stepId, role: read.role,
            tool_name: read.toolName, part: read.part, text: read.text.slice(start, end),
            range: { start, end, total: read.text.length, unit: 'utf16' },
            has_earlier: start > 0 }], next_cursor: next, has_more: next !== undefined,
          continuation: next === undefined ? undefined : 'results',
        }) };
      },
    };
  }

  async resolveExecution(input: z.infer<typeof HistoryReadInputSchema>): Promise<ToolExecution> {
    const directoryCursor = decodeDirectoryCursor(input.cursor);
    if (directoryCursor !== undefined) return this.resolveDirectory(input, directoryCursor.ref, directoryCursor);
    const refKind = input.ref === undefined ? undefined : refTarget(input.ref).kind;
    if (input.ref !== undefined && (refKind === 'turn' || refKind === 'step')) {
      return this.resolveDirectory(input, input.ref);
    }
    const blockCursor = decodeBlockCursor(input.cursor);
    if (input.ref !== undefined || blockCursor !== undefined) return this.resolveRef(input, blockCursor);
    if (input.start_char !== undefined) throw new Error('start_char requires a text-block ref.');
    const cursor = readCursor(input.cursor);
    const stepTurn = input.step_id === undefined ? undefined : Number(input.step_id.match(/^t(\d+)\.\d+$/)?.[1]);
    if (input.turn === undefined && stepTurn === undefined && cursor === undefined) {
      throw new Error('Provide turn, step_id, or cursor.');
    }
    const turn = input.turn ?? stepTurn ?? cursor!.turn;
    if (!Number.isSafeInteger(turn) || turn < 0 ||
      (stepTurn !== undefined && input.turn !== undefined && stepTurn !== input.turn)) {
      throw new Error('step_id does not belong to turn.');
    }
    const sessionId = input.session_id ?? cursor?.session ?? this.session.sessionId;
    const summary = await this.sessions.get(sessionId);
    if (summary === undefined) throw new Error('Session not found.');
    const target = await this.target(input.workspace_id ?? (cursor === undefined ? undefined : summary.workspaceId));
    if (summary.workspaceId !== target.id) throw new Error('Session not found in the requested workspace.');
    const agentId = input.agent_id ?? cursor?.agent ??
      (sessionId === this.session.sessionId ? this.caller.agentId : 'main');
    const stepId = input.step_id ?? cursor?.step;
    const cursorMismatch = cursor !== undefined && (cursor.session !== sessionId || cursor.agent !== agentId ||
      cursor.turn !== turn || cursor.step !== stepId);
    return {
      approvalRule: this.name,
      description: 'Reading historical transcript',
      accesses: target.externalRoot === undefined ? ToolAccesses.none() : ToolAccesses.readFile(target.externalRoot, true),
      execute: async (context) => {
        if (cursorMismatch) return { isError: true, output: JSON.stringify({ error: {
          code: 'cursor_mismatch', message: 'HistoryRead cursor conflicts with the selector.',
          retryable: true, next_call: { tool: 'HistoryRead', arguments: { session_id: sessionId, agent_id: agentId, turn, step_id: stepId } },
        } }) };
        if (cursor === undefined && this.archive.directoryRef !== undefined && this.archive.readDirectory !== undefined) {
          const ref = await this.archive.directoryRef(target.id, sessionId, agentId, turn, stepId);
          if (ref === undefined) return { isError: true, output: JSON.stringify({ error: {
            code: 'navigation_building_or_missing', message: 'This turn or step is not yet in the navigation directory.',
            retryable: true, next_call: { tool: 'HistoryRead', arguments: {
              session_id: sessionId, agent_id: agentId, turn, step_id: stepId } },
          } }) };
          return this.renderDirectory(ref, input.max_chars ?? 6000, context.signal);
        }
        const text = await this.archive.readTurn(sessionId, agentId, turn, stepId);
        if (text === undefined) return { isError: true, output: 'Turn or step not found.' };
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
        if (cursor !== undefined && (cursor.hash !== hash || cursor.offset >= text.length)) {
          return { isError: true, output: JSON.stringify({ error: {
            code: 'cursor_mismatch', message: 'HistoryRead cursor no longer matches this transcript.',
            retryable: true, next_call: { tool: 'HistoryRead', arguments: { session_id: sessionId, agent_id: agentId, turn, step_id: stepId } },
          } }) };
        }
        const offset = cursor?.offset ?? 0;
        let end = Math.min(text.length, offset + PAGE_CHARS);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
        const next = end < text.length ? Buffer.from(JSON.stringify({ v: 1, session: sessionId, agent: agentId,
          turn, step: stepId, offset: end, hash } satisfies ReadCursor)).toString('base64url') : undefined;
        return { output: JSON.stringify({ session_id: sessionId, agent_id: agentId, turn,
          step_id: stepId, text: text.slice(offset, end), next_cursor: next,
          has_more: next !== undefined, truncated: next !== undefined, offset, total_chars: text.length }) };
      },
    };
  }
}

