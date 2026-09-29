import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

const AgentIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((id) => id !== '.' && id !== '..');

export const HistoryListInputSchema = z.object({
  kind: z.enum(['turns', 'agents']).optional().describe('Directory to browse; defaults to transcript turns. Use agents to discover archived agents in one session.'),
  session_id: z.string().min(1).max(256).optional().describe('Session to browse; defaults to this session. A cursor supplies its original session.'),
  workspace_id: z.string().min(1).max(512).optional().describe('Workspace containing the session; another workspace requires access approval.'),
  agent_id: AgentIdSchema.optional().describe('Exact agent for turns; defaults to this agent in the current session or main in another session. Not valid for agents.'),
  before_turn: z.number().int().nonnegative().optional().describe('List turns strictly before this 0-based turn number.'),
  after_turn: z.number().int().nonnegative().optional().describe('List turns strictly after this 0-based turn number.'),
  at: z.iso.datetime({ offset: true }).optional().describe('Start near the turn closest to this RFC3339 timestamp with timezone; mutually exclusive with before_turn and after_turn.'),
  order: z.enum(['newest', 'oldest']).optional().describe('Order entries from newest or oldest; defaults to newest.'),
  limit: z.number().int().min(1).max(30).optional().describe('Entries per page; defaults to 10.'),
  cursor: z.string().min(1).max(4096).optional().describe('Continue a previous page; pass only cursor to preserve its target and filters.'),
}).strict();

export type HistoryListInput = z.infer<typeof HistoryListInputSchema>;
export type HistoryListKind = 'turns' | 'agents';
export type HistoryListOrder = 'newest' | 'oldest';

export interface HistoryDirectoryCursorRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly kind: HistoryListKind;
  readonly agentId?: string;
  readonly beforeTurn?: number;
  readonly afterTurn?: number;
  readonly at?: number;
  readonly order: HistoryListOrder;
  readonly limit: number;
}

export interface HistoryDirectoryCursor {
  readonly v: 1;
  readonly request: HistoryDirectoryCursorRequest;
  readonly afterTurn?: number;
  readonly afterAgent?: { readonly time?: string; readonly agentId: string };
}

export interface HistoryDirectoryRequest extends HistoryDirectoryCursorRequest {
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface HistoryDirectoryTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly agentId?: string;
}

export interface HistoryDirectoryCoverage {
  readonly complete: boolean;
  readonly domain: 'directory';
  readonly gaps?: readonly string[];
  readonly scanned?: {
    readonly turns?: readonly [number, number];
    readonly bytes: number;
    readonly records: number;
  };
}

export interface HistoryDirectoryTurn {
  readonly ref?: string;
  readonly turn: number;
  readonly startedAt?: string;
  readonly promptExcerpt?: string;
  readonly answerExcerpt?: string;
  readonly stepCount: number;
  readonly toolCount: number;
}

export interface HistoryDirectoryAgent {
  readonly agentId: string;
  readonly name?: string;
  readonly parentAgentId?: string;
  readonly firstTime?: string;
  readonly lastTime?: string;
  readonly turnCount?: number;
  readonly indexed?: boolean;
}

export interface HistoryDirectoryPage {
  readonly status: 'ok' | 'no_match' | 'partial' | 'unavailable';
  readonly target: HistoryDirectoryTarget;
  readonly source: 'navigation' | 'live' | 'transcript';
  readonly coverage: HistoryDirectoryCoverage;
  readonly turns?: readonly HistoryDirectoryTurn[];
  readonly agents?: readonly HistoryDirectoryAgent[];
  readonly nextCursor?: string;
}

export interface IHistoryDirectory {
  readonly _serviceBrand: undefined;
  list(request: HistoryDirectoryRequest): Promise<HistoryDirectoryPage>;
}

export const IHistoryDirectory = createDecorator<IHistoryDirectory>('historyDirectory');

export interface IHistoryListTool extends AgentTool<HistoryListInput> {
  readonly _serviceBrand: undefined;
}

export const IHistoryListTool = createDecorator<IHistoryListTool>('historyListTool');

export function encodeHistoryDirectoryCursor(cursor: HistoryDirectoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeHistoryDirectoryCursor(value: string): HistoryDirectoryCursor {
  if (value.length === 0 || value.length > 4096) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  const cursor = raw as Partial<HistoryDirectoryCursor>;
  const request = cursor.request;
  if (cursor.v !== 1 || request === undefined || typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  const normalized = request as Partial<HistoryDirectoryCursorRequest>;
  if (typeof normalized.workspaceId !== 'string' || normalized.workspaceId.length === 0 || normalized.workspaceId.length > 512 ||
      typeof normalized.sessionId !== 'string' || normalized.sessionId.length === 0 || normalized.sessionId.length > 256 ||
      !['turns', 'agents'].includes(normalized.kind ?? '') ||
      !['newest', 'oldest'].includes(normalized.order ?? '') ||
      !Number.isSafeInteger(normalized.limit) || (normalized.limit ?? 0) < 1 || (normalized.limit ?? 0) > 30 ||
      (normalized.agentId !== undefined && (typeof normalized.agentId !== 'string' || !AgentIdSchema.safeParse(normalized.agentId).success)) ||
      (normalized.kind === 'turns' && normalized.agentId === undefined) ||
      (normalized.kind === 'agents' && normalized.agentId !== undefined) ||
      (normalized.beforeTurn !== undefined && (!Number.isSafeInteger(normalized.beforeTurn) || normalized.beforeTurn < 0)) ||
      (normalized.afterTurn !== undefined && (!Number.isSafeInteger(normalized.afterTurn) || normalized.afterTurn < 0)) ||
      (normalized.at !== undefined && (!Number.isFinite(normalized.at) || normalized.at < 0)) ||
      (normalized.beforeTurn !== undefined && normalized.afterTurn !== undefined && normalized.afterTurn >= normalized.beforeTurn) ||
      (normalized.at !== undefined && (normalized.beforeTurn !== undefined || normalized.afterTurn !== undefined))) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  const afterAgent = cursor.afterAgent;
  if (afterAgent !== undefined &&
      (typeof afterAgent !== 'object' || afterAgent === null || Array.isArray(afterAgent) ||
       typeof afterAgent.agentId !== 'string' || !AgentIdSchema.safeParse(afterAgent.agentId).success ||
       (afterAgent.time !== undefined && typeof afterAgent.time !== 'string'))) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  if (cursor.afterTurn !== undefined && (!Number.isSafeInteger(cursor.afterTurn) || cursor.afterTurn < 0)) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  if ((normalized.kind === 'turns' && afterAgent !== undefined) ||
      (normalized.kind === 'agents' && cursor.afterTurn !== undefined)) {
    throw new Error('Invalid HistoryList cursor; restart with {kind:"turns"}.');
  }
  return cursor as HistoryDirectoryCursor;
}

const DEFAULT_LIMIT = 10;

type NormalizedList = HistoryDirectoryCursorRequest & { readonly cursor?: string };

function cursorInputMismatch(input: HistoryListInput, cursor: HistoryDirectoryCursor): boolean {
  const request = cursor.request;
  return (input.kind !== undefined && input.kind !== request.kind) ||
    (input.session_id !== undefined && input.session_id !== request.sessionId) ||
    (input.workspace_id !== undefined && input.workspace_id !== request.workspaceId) ||
    (input.agent_id !== undefined && input.agent_id !== request.agentId) ||
    (input.before_turn !== undefined && input.before_turn !== request.beforeTurn) ||
    (input.after_turn !== undefined && input.after_turn !== request.afterTurn) ||
    (input.at !== undefined && Date.parse(input.at) !== request.at) ||
    (input.order !== undefined && input.order !== request.order) ||
    (input.limit !== undefined && input.limit !== request.limit);
}

export class HistoryListTool implements IHistoryListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'HistoryList' as const;
  readonly description = 'Browse a compact transcript directory when you do not know a turn number or useful search words. Defaults to this session and this agent, newest first. Use before_turn or after_turn for a known range, at for a timestamp, and kind=agents to discover archived agents. Entries omit tool bodies and include coverage plus a ref when available; pass only cursor to continue. For currently owned child executions, use AgentList.';
  readonly parameters = toInputJsonSchema(HistoryListInputSchema, (schema) => {
    schema['allOf'] = [
      {
        if: { required: ['cursor'] },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema uses the reserved `then` keyword.
        ['then']: { not: { anyOf: [
          { required: ['kind'] }, { required: ['session_id'] }, { required: ['workspace_id'] },
          { required: ['agent_id'] }, { required: ['before_turn'] }, { required: ['after_turn'] },
          { required: ['at'] }, { required: ['order'] }, { required: ['limit'] },
        ] } },
      },
      {
        if: { properties: { kind: { const: 'agents' } }, required: ['kind'] },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema uses the reserved `then` keyword.
        ['then']: { not: { anyOf: [
          { required: ['agent_id'] }, { required: ['before_turn'] }, { required: ['after_turn'] },
          { required: ['at'] },
        ] } },
      },
      {
        if: { required: ['at'] },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema uses the reserved `then` keyword.
        ['then']: { not: { anyOf: [{ required: ['before_turn'] }, { required: ['after_turn'] }] } },
      },
    ];
  });

  constructor(
    @IHistoryDirectory private readonly directory: IHistoryDirectory,
    @ISessionContext private readonly session: ISessionContext,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @ISessionIndex private readonly sessions: ISessionIndex,
    @IAgentScopeContext private readonly caller: IAgentScopeContext,
  ) {}

  async resolveExecution(input: HistoryListInput): Promise<ToolExecution> {
    const cursor = input.cursor === undefined ? undefined : decodeHistoryDirectoryCursor(input.cursor);
    if (cursor !== undefined && cursorInputMismatch(input, cursor)) {
      throw new Error('HistoryList cursor conflicts with the supplied filters. Pass only cursor to continue.');
    }
    const source = cursor?.request;
    const kind = source?.kind ?? input.kind ?? 'turns';
    const sessionId = source?.sessionId ?? input.session_id ?? this.session.sessionId;
    const workspaceId = source?.workspaceId ?? input.workspace_id ?? this.session.workspaceId;
    const agentId = kind === 'turns'
      ? source?.agentId ?? input.agent_id ?? (sessionId === this.session.sessionId ? this.caller.agentId : 'main')
      : undefined;
    if (kind === 'agents' && input.agent_id !== undefined) throw new Error('agent_id is only valid with kind=turns.');
    const beforeTurn = source?.beforeTurn ?? input.before_turn;
    const afterTurn = source?.afterTurn ?? input.after_turn;
    const atText = source?.at === undefined ? input.at : undefined;
    const at = source?.at ?? (atText === undefined ? undefined : Date.parse(atText));
    const order = source?.order ?? input.order ?? 'newest';
    const limit = source?.limit ?? input.limit ?? DEFAULT_LIMIT;
    if (atText !== undefined && !Number.isFinite(at)) throw new Error('at must be an RFC3339 timestamp with timezone.');
    if (kind === 'agents' && (beforeTurn !== undefined || afterTurn !== undefined || at !== undefined)) {
      throw new Error('before_turn, after_turn, and at are only valid with kind=turns.');
    }
    if (at !== undefined && (beforeTurn !== undefined || afterTurn !== undefined)) {
      throw new Error('at cannot be combined with before_turn or after_turn.');
    }
    if (beforeTurn !== undefined && afterTurn !== undefined && afterTurn >= beforeTurn) {
      throw new Error('after_turn must be earlier than before_turn.');
    }
    const summary = await this.sessions.get(sessionId);
    if (summary === undefined || summary.workspaceId !== workspaceId) throw new Error('Session not found in the requested workspace.');
    const external = workspaceId === this.session.workspaceId ? undefined : await this.workspaces.get(workspaceId);
    if (workspaceId !== this.session.workspaceId && external === undefined) throw new Error('Workspace not found.');
    const request: NormalizedList = {
      workspaceId,
      sessionId,
      kind,
      agentId,
      beforeTurn,
      afterTurn,
      at,
      order,
      limit,
      cursor: input.cursor,
    };
    return {
      approvalRule: this.name,
      description: 'Listing historical transcript directory',
      accesses: external === undefined ? ToolAccesses.none() : ToolAccesses.readFile(external.root, true),
      execute: async (context) => {
        const page = await this.directory.list({ ...request, signal: context.signal });
        const target = page.target;
        return {
          output: JSON.stringify({
            schema_version: 2,
            status: page.status,
            target: {
              workspace_id: target.workspaceId,
              session_id: target.sessionId,
              agent_id: target.agentId,
            },
            kind,
            turns: page.turns?.map((turn) => ({
              ref: turn.ref,
              turn: turn.turn,
              started_at: turn.startedAt,
              prompt_excerpt: turn.promptExcerpt,
              answer_excerpt: turn.answerExcerpt,
              step_count: turn.stepCount,
              tool_count: turn.toolCount,
            })),
            agents: page.agents?.map((agent) => ({
              agent_id: agent.agentId,
              name: agent.name,
              parent_agent_id: agent.parentAgentId,
              first_time: agent.firstTime,
              last_time: agent.lastTime,
              turn_count: agent.turnCount,
              indexed: agent.indexed,
            })),
            next_cursor: page.nextCursor,
            has_more: page.nextCursor !== undefined,
            source: page.source,
            coverage: page.coverage,
          }),
          isError: false,
        };
      },
    };
  }
}
