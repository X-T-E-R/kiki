import { createHash } from 'node:crypto';

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

const AgentIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((id) => id !== '.' && id !== '..');

export const HistorySearchInputSchema = z.object({
  query: z.string().min(1).max(1024),
  mode: z.enum(['terms', 'literal']).optional(),
  scope: z.enum(['this_session', 'workspace']).optional(),
  workspace_id: z.string().min(1).max(512).optional(),
  agent_id: AgentIdSchema.optional(),
  role: z.enum(['user', 'assistant', 'tool']).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

export const HistoryReadInputSchema = z.object({
  session_id: z.string().min(1).max(256).optional(),
  workspace_id: z.string().min(1).max(512).optional(),
  agent_id: AgentIdSchema.optional(),
  turn: z.number().int().nonnegative(),
  step_id: z.string().regex(/^t\d+\.\d+$/).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict();

export interface HistoryHit {
  readonly sessionId: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'title';
  readonly turn?: number;
  readonly stepId?: string;
  readonly snippet: string;
}

export interface HistorySearchPage {
  readonly items: readonly HistoryHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: string;
  readonly indexState: { readonly state: string; readonly stale?: boolean; readonly degraded?: string };
  readonly source: 'live' | 'index';
}

export interface IHistoryArchive {
  readonly _serviceBrand: undefined;
  search(query: {
    query: string;
    mode?: 'terms' | 'literal';
    workspaceId: string;
    sessionId?: string;
    agentId?: string;
    role?: 'user' | 'assistant' | 'tool';
    pageSize: number;
    pageToken?: string;
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

export class HistorySearchTool extends HistoryToolBase implements AgentTool<z.infer<typeof HistorySearchInputSchema>> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'HistorySearch';
  readonly description = 'Search past user, assistant, or tool text. scope defaults to workspace; mode defaults to terms; literal requires at least 2 characters. Pass workspace_id for another workspace; use cursor to continue.';
  readonly parameters = toInputJsonSchema(HistorySearchInputSchema);

  constructor(
    @IHistoryArchive archive: IHistoryArchive,
    @ISessionContext session: ISessionContext,
    @IWorkspaceService workspaces: IWorkspaceService,
  ) { super(archive, session, workspaces); }

  async resolveExecution(input: z.infer<typeof HistorySearchInputSchema>): Promise<ToolExecution> {
    const target = await this.target(input.workspace_id);
    return {
      approvalRule: this.name,
      description: 'Searching history',
      accesses: target.externalRoot === undefined ? ToolAccesses.none() : ToolAccesses.searchTree(target.externalRoot, true),
      execute: async () => {
        const page = await this.archive.search({
          query: input.query,
          mode: input.mode,
          workspaceId: target.id,
          sessionId: input.scope === 'this_session' ? this.session.sessionId : undefined,
          agentId: input.agent_id,
          role: input.role,
          pageSize: input.limit ?? 8,
          pageToken: input.cursor,
        });
        return { output: JSON.stringify({
          hits: page.items.filter((hit) => hit.turn !== undefined && hit.role !== 'title')
            .map((hit) => ({ session_id: hit.sessionId, agent_id: hit.agentId, role: hit.role,
              turn: hit.turn, step_id: hit.stepId, snippet: hit.snippet })),
          next_cursor: page.pageToken, has_more: page.hasMore, incomplete: page.incomplete,
          index_state: page.indexState, source: page.source,
        }) };
      },
    };
  }
}

export class HistoryReadTool extends HistoryToolBase implements AgentTool<z.infer<typeof HistoryReadInputSchema>> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'HistoryRead';
  readonly description = 'Read an exact transcript turn or step, including tool output. turn is 0-based; step_id must belong to turn. Use cursor for the next text chunk.';
  readonly parameters = toInputJsonSchema(HistoryReadInputSchema);

  constructor(
    @IHistoryArchive archive: IHistoryArchive,
    @ISessionContext session: ISessionContext,
    @IWorkspaceService workspaces: IWorkspaceService,
    @ISessionIndex private readonly sessions: ISessionIndex,
  ) { super(archive, session, workspaces); }

  async resolveExecution(input: z.infer<typeof HistoryReadInputSchema>): Promise<ToolExecution> {
    const sessionId = input.session_id ?? this.session.sessionId;
    const summary = await this.sessions.get(sessionId);
    if (summary === undefined) throw new Error('Session not found.');
    const target = await this.target(input.workspace_id);
    if (summary.workspaceId !== target.id) throw new Error('Session not found in the requested workspace.');
    if (input.step_id !== undefined && !input.step_id.startsWith(`t${input.turn}.`)) {
      throw new Error('step_id does not belong to turn.');
    }
    const agentId = input.agent_id ?? 'main';
    return {
      approvalRule: this.name,
      description: 'Reading historical transcript',
      accesses: target.externalRoot === undefined ? ToolAccesses.none() : ToolAccesses.readFile(target.externalRoot, true),
      execute: async () => {
        const text = await this.archive.readTurn(sessionId, agentId, input.turn, input.step_id);
        if (text === undefined) return { isError: true, output: 'Turn or step not found.' };
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
        const cursor = readCursor(input.cursor);
        if (cursor !== undefined && (cursor.session !== sessionId || cursor.agent !== agentId ||
            cursor.turn !== input.turn || cursor.step !== input.step_id || cursor.hash !== hash || cursor.offset >= text.length)) {
          return { isError: true, output: 'HistoryRead cursor does not match this transcript; restart without cursor.' };
        }
        const offset = cursor?.offset ?? 0;
        let end = Math.min(text.length, offset + PAGE_CHARS);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
        const next = end < text.length ? Buffer.from(JSON.stringify({ v: 1, session: sessionId, agent: agentId,
          turn: input.turn, step: input.step_id, offset: end, hash } satisfies ReadCursor)).toString('base64url') : undefined;
        return { output: JSON.stringify({ session_id: sessionId, agent_id: agentId, turn: input.turn,
          step_id: input.step_id, text: text.slice(offset, end), next_cursor: next,
          has_more: next !== undefined, truncated: next !== undefined, offset, total_chars: text.length }) };
      },
    };
  }
}

