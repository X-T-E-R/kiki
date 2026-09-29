import { createHash } from 'node:crypto';

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

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
  cursor: z.string().min(1).max(4096).optional().describe('Pass alone to continue a previous Read page.'),
}).strict().refine((input) => input.turn !== undefined || input.step_id !== undefined || input.cursor !== undefined, {
  message: 'Provide turn, step_id, or cursor.',
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
  }): Promise<HistorySearchPage>;
  readTurn(sessionId: string, agentId: string, turn: number, stepId?: string): Promise<string | undefined>;
}

export const IHistoryArchive = createDecorator<IHistoryArchive>('historyArchive');
export const IHistorySearchTool = createDecorator<AgentTool<z.infer<typeof HistorySearchInputSchema>>>('historySearchTool');
export const IHistoryReadTool = createDecorator<AgentTool<z.infer<typeof HistoryReadInputSchema>>>('historyReadTool');

const PAGE_CHARS = 3_000;

type ReadCursor = { v: 1; session: string; agent: string; turn: number; step?: string; offset: number; hash: string };

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
      ? decodeSearchCursor(input.cursor) : (() => { try { return decodeSearchCursor(input.cursor!); } catch { return undefined; } })();
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
      execute: async () => {
        if (mismatch) return { isError: true, output: JSON.stringify({ error: {
          code: 'cursor_mismatch', message: 'HistorySearch cursor conflicts with the query.',
          retryable: true, next_call: { tool: 'HistorySearch', arguments: request },
        } }) };
        const page = await this.archive.search({
          query: request.query!, mode: request.mode ?? 'auto', workspaceId: target.id,
          sessionId, agentId, includeSubagents: request.include_subagents,
          role: request.role, after: request.after === undefined ? undefined : Date.parse(request.after),
          before: request.before === undefined ? undefined : Date.parse(request.before),
          sort: request.sort, source: request.source, pageSize: request.limit ?? SEARCH_DEFAULT_LIMIT,
          pageToken: cursor?.page ?? (cursor === undefined ? input.cursor : undefined),
          fallbackSessionId: target.id === this.session.workspaceId ? this.session.sessionId : undefined,
          fallbackAgentId: target.id === this.session.workspaceId ? this.caller.agentId : undefined,
        });
        const next = page.pageToken === undefined ? undefined : Buffer.from(JSON.stringify({
          v: 2, request: { ...request, cursor: undefined }, page: page.pageToken,
        } satisfies SearchCursor)).toString('base64url');
        return { output: JSON.stringify({
          schema_version: 2, status: page.incomplete !== undefined ||
            (page.coverage !== undefined ? !page.coverage.complete :
              (page.indexState.state !== 'ready' && page.source !== 'live') || request.include_subagents === true)
            ? 'partial' : page.items.length ? 'ok' : 'no_match',
          target: { workspace_id: target.id, session_id: sessionId, agent_id: agentId,
            all_agents: request.include_subagents || undefined },
          hits: page.items.filter((hit) => hit.turn !== undefined && hit.role !== 'title')
            .map((hit) => ({ session_id: hit.sessionId, agent_id: hit.agentId, role: hit.role,
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
  readonly description = 'Read an exact transcript turn or step, including tool output. A step_id such as t42.3 is sufficient without turn. Pass only cursor to continue a page; turn is 0-based.';
  readonly parameters = toInputJsonSchema(HistoryReadInputSchema, (schema) => {
    schema['anyOf'] = [{ required: ['turn'] }, { required: ['step_id'] }, { required: ['cursor'] }];
  });

  constructor(
    @IHistoryArchive archive: IHistoryArchive,
    @ISessionContext session: ISessionContext,
    @IWorkspaceService workspaces: IWorkspaceService,
    @ISessionIndex private readonly sessions: ISessionIndex,
    @IAgentScopeContext private readonly caller: IAgentScopeContext,
  ) { super(archive, session, workspaces); }

  async resolveExecution(input: z.infer<typeof HistoryReadInputSchema>): Promise<ToolExecution> {
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
      execute: async () => {
        if (cursorMismatch) return { isError: true, output: JSON.stringify({ error: {
          code: 'cursor_mismatch', message: 'HistoryRead cursor conflicts with the selector.',
          retryable: true, next_call: { tool: 'HistoryRead', arguments: { session_id: sessionId, agent_id: agentId, turn, step_id: stepId } },
        } }) };
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

