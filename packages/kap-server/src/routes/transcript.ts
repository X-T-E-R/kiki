import { MAIN_AGENT_ID, type Scope } from '@kiki/agent-core-v2';
import {
  isPlainAgentId,
  TRANSCRIPT_CLIENT_UPGRADE_MESSAGE,
  TRANSCRIPT_COVERAGE_VERSION,
  transcriptDetailListQuerySchema,
  transcriptDetailListResponseSchema,
  transcriptDetailQuerySchema,
  transcriptDetailResponseSchema,
  transcriptOpsCatchupResponseSchema,
  transcriptOpsQuerySchema,
  transcriptPlanResponseSchema,
  transcriptResponseSchema,
  transcriptUserMessagesResponseSchema,
  jsonBytes,
  type ContentRef,
  type TranscriptAttachment,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptTurn,
  type TurnOrigin,
  type TurnState,
} from '@kiki/transcript';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { defineRoute } from '../middleware/defineRoute';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { projectTurnPlans, type PlanInfo } from '../services/transcript/planProjection';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { boundedEntity } from '../transport/klient/boundedContent';
import {
  readPlanInteractions,
  readSessionViewTranscriptCatchUp,
  readSessionViewTranscriptDetails,
  readSessionViewTranscriptDetail,
  readSessionViewTranscriptPage,
  TranscriptDetailCursorError,
} from '../transport/klient/sessionViewReads';

interface TranscriptRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

type ReplyCloseSource = Parameters<typeof withReplyCloseSignal>[0];

interface RouteReply {
  send(payload: unknown): unknown;
}

function replySignalSource(reply: RouteReply): ReplyCloseSource {
  return reply as unknown as ReplyCloseSource;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const transcriptQueryCoercion = z
  .object({
    agent_id: z.string().min(1),
    before_turn: z.string().min(1).optional(),
    before_item: z.string().min(1).max(512).optional(),
    after_turn: z.string().min(1).optional(),
    after_item: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    transcript_coverage_version: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if ([value.before_turn, value.before_item, value.after_turn, value.after_item].filter((entry) => entry !== undefined).length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_turn, before_item, after_turn and after_item are mutually exclusive',
        path: ['before_turn'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const userMessagesQueryCoercion = z
  .object({
    agent_id: z.string().min(1).optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.agent_id !== undefined && !isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.cursor !== undefined && value.agent_id === undefined && decodeListCursor(value.cursor)?.list !== 'roster') {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id is required when cursor is set',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const planQueryCoercion = z
  .object({
    agent_id: z.string().min(1),
    tool_call_id: z.string().min(1).optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .superRefine((value, ctx) => {
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export interface TranscriptRouteDeps {
  readonly core: Scope;
  readonly transcriptService: TranscriptService;
}

export function registerTranscriptRoutes(app: TranscriptRouteHost, deps: TranscriptRouteDeps): void {
  const { transcriptService } = deps;

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript',
      params: sessionIdParamSchema,
      querystring: transcriptQueryCoercion,
      success: { data: transcriptResponseSchema.extend({ transcript_coverage_version: z.literal(TRANSCRIPT_COVERAGE_VERSION) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Turn-granular session transcript page: live sessions read the in-memory store (wire-records backfill awaited per requested agent), cold sessions rebuild the requested agent from the persisted wire records',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;
      if (query.transcript_coverage_version !== String(TRANSCRIPT_COVERAGE_VERSION)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, TRANSCRIPT_CLIENT_UPGRADE_MESSAGE, req.id));
        return;
      }
      let data;
      try {
        data = await withReplyCloseSignal(replySignalSource(reply), (signal) =>
          readSessionViewTranscriptPage(transcriptService, session_id, {
            agentId: query.agent_id, beforeTurn: query.before_turn, beforeItem: query.before_item,
            afterTurn: query.after_turn, afterItem: query.after_item, pageSize: query.page_size, signal,
          }),
        );
      } catch (error) {
        if (!(error instanceof TranscriptDetailCursorError)) throw error;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      if (data === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      reply.send(okEnvelope({ ...data, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION }, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<TranscriptRouteHost['get']>[2]);

  const detailListRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/details',
      params: sessionIdParamSchema,
      querystring: transcriptDetailListQuerySchema,
      success: { data: transcriptDetailListResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Paginated canonical transcript global entities. kind selects task, attachment, or prompt; cursor is an opaque keyset cursor returned as next_cursor; limit is 1..100 and defaults to 20.',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;
      let data;
      try {
        data = await withReplyCloseSignal(replySignalSource(reply), (signal) =>
          readSessionViewTranscriptDetails(transcriptService, session_id, {
            agentId: query.agent_id,
            kind: query.kind,
            cursor: query.cursor,
            limit: query.limit,
            signal,
          }),
        );
      } catch (error) {
        if (!(error instanceof TranscriptDetailCursorError)) throw error;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      if (data === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(detailListRoute.path, detailListRoute.options, detailListRoute.handler as Parameters<TranscriptRouteHost['get']>[2]);

  const detailRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/detail',
      params: sessionIdParamSchema,
      querystring: transcriptDetailQuerySchema,
      success: { data: transcriptDetailResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Read one windowed transcript global entity by reference. The detail endpoint returns the canonical task, attachment, or prompt body that a transcript.reset summary omitted or truncated.',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;
      const data = await withReplyCloseSignal(replySignalSource(reply), (signal) =>
        readSessionViewTranscriptDetail(transcriptService, session_id, {
          agentId: query.agent_id,
          kind: query.kind,
          id: query.id,
          signal,
        }),
      );
      if (data === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(detailRoute.path, detailRoute.options, detailRoute.handler as Parameters<TranscriptRouteHost['get']>[2]);

  const opsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/ops',
      params: sessionIdParamSchema,
      querystring: transcriptOpsQuerySchema,
      success: { data: transcriptOpsCatchupResponseSchema.extend({ transcript_coverage_version: z.literal(TRANSCRIPT_COVERAGE_VERSION) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Point-to-point transcript catch-up: journaled op batches with seq > since_seq for one agent, oldest first. complete:false means the session is not live or the journal no longer reaches back to since_seq — the caller must fall back to a full transcript refresh',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;
      if (query.transcript_coverage_version !== String(TRANSCRIPT_COVERAGE_VERSION)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, TRANSCRIPT_CLIENT_UPGRADE_MESSAGE, req.id));
        return;
      }
      const data = await readSessionViewTranscriptCatchUp(transcriptService, session_id, {
        agentId: query.agent_id,
        since: { epoch: query.epoch, seq: query.since_seq },
        grade: query.grade,
      });
      if (data === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      reply.send(okEnvelope({ ...data, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION }, req.id));
    },
  );
  app.get(opsRoute.path, opsRoute.options, opsRoute.handler as Parameters<TranscriptRouteHost['get']>[2]);

  const userMessagesRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/user-messages',
      params: sessionIdParamSchema,
      querystring: userMessagesQueryCoercion,
      success: { data: transcriptUserMessagesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Turn-opening inputs ("user messages") of a session, grouped per agent: every turn with a defined prompt (real user text, user-slash skill/plugin commands, cron prompts — distinguish via origin), plus attachment-only prompts projected with an empty prompt string. agent_id optional: present reads one agent, absent reads the roster through one shared 64 KiB page rather than one page per agent. Each page stays chronological; has_more and next_cursor are omitted when it is complete. A cursor for one agent requires that agent_id. A cursor from an all-agent page names the agent to resume and is sent on its own. A long prompt is a preview plus contentRefs. Live sessions answer from the in-memory store (history backfill awaited per agent), cold sessions read a wire page. Attachment entities referenced by the returned messages ride along (metadata only)',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const { agent_id, cursor } = req.query;
      const live = transcriptService.forSessionLive(session_id) !== undefined;
      if (live) await transcriptService.whenReady(session_id);
      let page;
      try {
        page = live
          ? await readUserMessageAgents(transcriptService, session_id, agent_id, cursor, undefined)
          : await withReplyCloseSignal(replySignalSource(reply), (signal) => readUserMessageAgents(transcriptService, session_id, agent_id, cursor, signal));
      } catch (error) {
        if (!(error instanceof TranscriptDetailCursorError)) throw error;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      if (page === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      reply.send(okEnvelope(page, req.id));
    },
  );
  app.get(
    userMessagesRoute.path,
    userMessagesRoute.options,
    userMessagesRoute.handler as Parameters<TranscriptRouteHost['get']>[2],
  );

  const planRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/plan',
      params: sessionIdParamSchema,
      querystring: planQueryCoercion,
      success: { data: transcriptPlanResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TOOL_CALL_NOT_FOUND]: {},
      },
      description:
        'Plan information of an agent\'s ExitPlanMode tool calls: the reviewed plan content, plan file path, offered options, and the review outcome, in timeline order. agent_id required; tool_call_id optional — present narrows the read to that one call (unknown id or non-ExitPlanMode call → 40416), absent lists the newest window of calls with recoverable plan content. has_more and next_cursor are omitted when nothing older remains. cursor continues toward older history, and a page that stops inside one turn resumes at the next older plan in that turn. A long plan or review is a preview plus contentRefs. Content is projected from the linked approval interaction (interactive reviews, live or cold), the tool frame display (auto mode), or the tool result output text. Live sessions read the in-memory store (history backfill awaited), cold sessions read a wire page',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const { agent_id, tool_call_id, cursor } = req.query;
      const read = async (signal?: AbortSignal) => {
        if (transcriptService.forSessionLive(session_id) !== undefined) {
          const transcript = await transcriptService.ensureAgentHistory(session_id, agent_id);
          if (transcript === undefined) return undefined;
        }
        return readPlanWindow(transcriptService, session_id, agent_id, tool_call_id, tool_call_id === undefined ? cursor : undefined, signal);
      };
      let result;
      try {
        result = transcriptService.forSessionLive(session_id) !== undefined
          ? await read()
          : await withReplyCloseSignal(replySignalSource(reply), read);
      } catch (error) {
        if (!(error instanceof TranscriptDetailCursorError)) throw error;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      if (result === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      if (result.missingTool) {
        sendToolCallNotFound(reply, req.id, tool_call_id ?? '');
        return;
      }
      reply.send(okEnvelope({ agent_id, plans: result.plans, ...result.page }, req.id));
    },
  );
  app.get(planRoute.path, planRoute.options, planRoute.handler as Parameters<TranscriptRouteHost['get']>[2]);
}

const LIST_PAGE_BYTES = 64 * 1024;
const LIST_TURN_PAGE = 20;
const PROMPT_INLINE_BYTES = 24 * 1024;

interface UserMessageEntry {
  turn_id: string;
  ordinal: number;
  state: TurnState;
  origin: TurnOrigin;
  prompt: string;
  attachment_ids?: readonly string[];
  started_at?: string;
  contentRefs?: ContentRef[];
}

interface ListedPage {
  has_more?: true;
  next_cursor?: string;
}

function listedPage(hasMore: boolean, cursor: string | undefined): ListedPage {
  if (!hasMore) return {};
  return cursor === undefined ? { has_more: true } : { has_more: true, next_cursor: cursor };
}

interface ListCursor {
  readonly v: 2;
  readonly agentId: string;
  readonly source: 'live' | 'cold' | 'derived';
  readonly anchor: string;
  readonly list?: 'roster' | 'plan';
  readonly frameId?: string;
}

function decodeListCursor(cursor: string | undefined): ListCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ListCursor>;
    if (parsed.v !== 2 || typeof parsed.agentId !== 'string' || !isPlainAgentId(parsed.agentId)) return undefined;
    if (typeof parsed.anchor !== 'string' || parsed.anchor.length === 0) return undefined;
    if (parsed.source !== 'live' && parsed.source !== 'cold' && parsed.source !== 'derived') return undefined;
    if (parsed.list !== undefined && parsed.list !== 'roster' && parsed.list !== 'plan') return undefined;
    if (parsed.frameId !== undefined && (typeof parsed.frameId !== 'string' || parsed.frameId.length === 0)) return undefined;
    return parsed as ListCursor;
  } catch {
    return undefined;
  }
}

function encodeListCursor(agentId: string, anchor: string, source: ListCursor['source'], extra?: { readonly list?: ListCursor['list']; readonly frameId?: string }): string {
  return Buffer.from(JSON.stringify({ v: 2, agentId, source, anchor, ...extra } satisfies ListCursor)).toString('base64url');
}

function agentCursor(cursor: string | undefined, agentId: string): string | undefined {
  const parsed = decodeListCursor(cursor);
  if (parsed?.list === 'roster' && parsed.agentId === agentId) return parsed.anchor === '*' ? undefined : parsed.anchor;
  return cursor;
}

async function readUserMessageAgents(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string | undefined,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ agents: Array<{ agent_id: string; messages: UserMessageEntry[]; attachments: TranscriptAttachment[] } & ListedPage> } & ListedPage | undefined> {
  const store = transcriptService.forSessionLive(sessionId);
  const source: ListCursor['source'] = store !== undefined ? 'live' : 'cold';
  let agentIds: string[];
  if (store !== undefined) {
    agentIds = agentId !== undefined ? [agentId] : store.agents().map((descriptor) => descriptor.agentId);
  } else {
    const roster = await transcriptService.readColdRoster(sessionId);
    signal?.throwIfAborted();
    if (roster === undefined) return undefined;
    agentIds = agentId !== undefined ? [agentId] : roster.map((descriptor) => descriptor.agentId);
    if (agentId === undefined && !agentIds.includes(MAIN_AGENT_ID)) agentIds.unshift(MAIN_AGENT_ID);
  }
  if (agentId !== undefined) {
    const window = await readUserMessageWindow(transcriptService, sessionId, agentId, agentCursor(cursor, agentId), signal);
    return window === undefined ? undefined : { agents: [window] };
  }
  const parsed = cursor === undefined ? undefined : decodeListCursor(cursor);
  if (cursor !== undefined && parsed?.list !== 'roster') throw new TranscriptDetailCursorError();
  let index = 0;
  let before = parsed === undefined || parsed.anchor === '*' ? undefined : parsed.anchor;
  if (parsed !== undefined) {
    index = agentIds.indexOf(parsed.agentId);
    if (index < 0) throw new TranscriptDetailCursorError();
  }
  const agents: Array<{ agent_id: string; messages: UserMessageEntry[]; attachments: TranscriptAttachment[] }> = [];
  let used = 0;
  for (; index < agentIds.length; index += 1) {
    const id = agentIds[index]!;
    const window = await readUserMessageWindow(transcriptService, sessionId, id, before, signal);
    before = undefined;
    if (window === undefined) return undefined;
    const entry = { agent_id: window.agent_id, messages: window.messages, attachments: window.attachments };
    const size = jsonBytes(entry);
    if (agents.length > 0 && used + size > LIST_PAGE_BYTES) {
      return { agents, ...listedPage(true, encodeListCursor(id, '*', source, { list: 'roster' })) };
    }
    agents.push(entry);
    used += size;
    if (window.has_more === true) {
      return { agents, ...listedPage(true, window.next_cursor === undefined ? undefined : encodeListCursor(id, window.next_cursor, source, { list: 'roster' })) };
    }
  }
  return { agents };
}

function fitNewest<T>(entries: readonly T[], sizeOf: (subset: readonly T[]) => number): { kept: T[]; trimmed: boolean } {
  const kept: T[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = [entries[index]!, ...kept];
    if (kept.length > 0 && sizeOf(candidate) > LIST_PAGE_BYTES) break;
    kept.unshift(entries[index]!);
  }
  return { kept, trimmed: kept.length < entries.length };
}

function projectUserMessages(
  items: readonly TranscriptItem[],
  resolveAttachment: (id: string) => TranscriptAttachment | undefined,
): { messages: UserMessageEntry[]; attachments: TranscriptAttachment[] } {
  const messages: UserMessageEntry[] = [];
  const attachments = new Map<string, TranscriptAttachment>();
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    const hasAttachments = item.attachmentIds !== undefined && item.attachmentIds.length > 0;
    if (item.prompt === undefined && !hasAttachments) continue;
    messages.push({
      turn_id: item.turnId,
      ordinal: item.ordinal,
      state: item.state,
      origin: item.origin,
      prompt: item.prompt ?? '',
      attachment_ids: item.attachmentIds,
      started_at: item.startedAt,
    });
    for (const id of item.attachmentIds ?? []) {
      const attachment = resolveAttachment(id);
      if (attachment !== undefined) attachments.set(id, attachment);
    }
  }
  return { messages, attachments: [...attachments.values()] };
}

function sendSessionNotFound(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  sessionId: string,
): void {
  reply.send(
    errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`, requestId),
  );
}

function sendToolCallNotFound(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  toolCallId: string,
): void {
  reply.send(
    errEnvelope(
      ErrorCode.TOOL_CALL_NOT_FOUND,
      `no ExitPlanMode tool call found for tool_call_id: ${toolCallId}`,
      requestId,
    ),
  );
}

function boundPrompt(entry: UserMessageEntry, turn: TranscriptTurn): UserMessageEntry {
  const refs = (turn.contentRefs ?? []).filter((ref) => ref.kind === 'text' && ref.path.length === 1 && ref.path[0] === 'prompt');
  if (refs.length > 0) return { ...entry, prompt: turn.prompt ?? '', contentRefs: [...refs] };
  if (jsonBytes(entry.prompt) <= PROMPT_INLINE_BYTES) return entry;
  const bounded = boundedEntity({ prompt: entry.prompt }, { kind: 'turn', id: turn.turnId }, PROMPT_INLINE_BYTES);
  return { ...entry, prompt: bounded.prompt, ...(bounded.contentRefs === undefined ? {} : { contentRefs: [...bounded.contentRefs] }) };
}

function attachmentsFor(messages: readonly UserMessageEntry[], attachments: readonly TranscriptAttachment[]): TranscriptAttachment[] {
  const ids = new Set(messages.flatMap((message) => message.attachment_ids ?? []));
  return attachments.filter((attachment) => ids.has(attachment.attachmentId));
}

async function readUserMessageWindow(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ agent_id: string; messages: UserMessageEntry[]; attachments: TranscriptAttachment[] } & ListedPage | undefined> {
  let beforeItem = cursor;
  const seen = new Set<string>();
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await readSessionViewTranscriptPage(transcriptService, sessionId, {
      agentId, beforeItem, pageSize: LIST_TURN_PAGE, signal,
    });
    if (page === undefined) return undefined;
    const attachments = new Map(page.attachments.map((attachment) => [attachment.attachmentId, attachment]));
    const projected = projectUserMessages(page.items, (id) => attachments.get(id));
    const messages = projected.messages.map((message) => {
      const turn = page.items.find((item) => item.kind === 'turn' && item.turnId === message.turn_id);
      return turn?.kind === 'turn' ? boundPrompt(message, turn) : message;
    });
    if (messages.length > 0 || page.has_more !== true) {
      const fitted = fitNewest(messages, (subset) => jsonBytes({
        messages: subset,
        attachments: attachmentsFor(subset, projected.attachments),
      }));
      const oldest = fitted.kept[0];
      const hasMore = fitted.trimmed || page.has_more === true;
      const next = fitted.trimmed && oldest !== undefined ? `turn:${oldest.turn_id}` : page.next_cursor;
      return {
        agent_id: agentId,
        messages: fitted.kept,
        attachments: attachmentsFor(fitted.kept, projected.attachments),
        ...listedPage(hasMore, next),
      };
    }
    if (page.next_cursor === undefined || seen.has(page.next_cursor)) {
      return { agent_id: agentId, messages: [], attachments: [] };
    }
    seen.add(page.next_cursor);
    beforeItem = page.next_cursor;
  }
  return { agent_id: agentId, messages: [], attachments: [] };
}

function turnHidesPlan(turn: TranscriptTurn): boolean {
  const refs = turn.contentRefs ?? [];
  if (refs.some((ref) => ref.path[0] === 'steps' || ref.path.includes('output') || ref.path.includes('display') || ref.path.includes('input'))) return true;
  return turn.steps.some((step) => step.frames.some((frame) => (frame.contentRefs?.length ?? 0) > 0));
}

async function completeTurn(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string,
  turn: TranscriptTurn,
  signal: AbortSignal | undefined,
): Promise<TranscriptTurn> {
  if (!turnHidesPlan(turn)) return turn;
  const resident = transcriptService.forSessionLive(sessionId)?.getAgent(agentId)?.getTurn(turn.turnId);
  if (resident !== undefined && !turnHidesPlan(resident)) return resident;
  if (typeof transcriptService.readProjectedColdTurn === 'function') {
    const cold = await transcriptService.readProjectedColdTurn(sessionId, agentId, turn.turnId, signal);
    if (cold !== undefined) return cold;
  }
  if (typeof transcriptService.readCanonicalEntity === 'function') {
    const entity = await transcriptService.readCanonicalEntity(sessionId, agentId, { kind: 'turn', id: turn.turnId }, signal);
    if (entity !== undefined && (entity as TranscriptTurn).kind === 'turn') return entity as TranscriptTurn;
  }
  return resident ?? turn;
}

interface ListedPlan extends PlanInfo {
  contentRefs?: ContentRef[];
}

function boundPlan(info: PlanInfo, frameId: string, stepId: string): ListedPlan {
  if (jsonBytes(info) <= PROMPT_INLINE_BYTES) return info;
  const bounded = boundedEntity({ ...info }, { kind: 'frame', id: frameId, turnId: info.turn_id, stepId }, PROMPT_INLINE_BYTES);
  const { contentRefs, ...rest } = bounded;
  return contentRefs === undefined ? rest : { ...rest, contentRefs: [...contentRefs] };
}

async function plansOnPage(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string,
  items: readonly TranscriptItem[],
  interactions: readonly TranscriptInteraction[],
  toolCallId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<PlanEntry[]> {
  const saved = await readPlanInteractions(transcriptService, sessionId, agentId, signal);
  const usable = saved.length > 0 ? saved : interactions;
  const plans: PlanEntry[] = [];
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    const turn = await completeTurn(transcriptService, sessionId, agentId, item, signal);
    for (const projected of projectTurnPlans(turn, usable, toolCallId)) {
      plans.push({ plan: boundPlan(projected.info, projected.frameId, projected.stepId), turnId: turn.turnId, frameId: projected.frameId });
    }
  }
  return plans;
}

interface PlanEntry {
  readonly plan: ListedPlan;
  readonly turnId: string;
  readonly frameId: string;
}

async function loadListedTurn(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string,
  turnId: string,
  signal: AbortSignal | undefined,
): Promise<TranscriptTurn | undefined> {
  const resident = transcriptService.forSessionLive(sessionId)?.getAgent(agentId)?.getTurn(turnId);
  if (resident !== undefined) return resident;
  if (typeof transcriptService.readProjectedColdTurn === 'function') {
    const cold = await transcriptService.readProjectedColdTurn(sessionId, agentId, turnId, signal);
    if (cold !== undefined) return cold;
  }
  if (typeof transcriptService.readCanonicalEntity === 'function') {
    const entity = await transcriptService.readCanonicalEntity(sessionId, agentId, { kind: 'turn', id: turnId }, signal);
    if (entity !== undefined && (entity as TranscriptTurn).kind === 'turn') return entity as TranscriptTurn;
  }
  return undefined;
}

function planContinuation(agentId: string, source: ListCursor['source'], entries: readonly PlanEntry[], fitted: { kept: PlanEntry[]; trimmed: boolean }, pageCursor: string | undefined): string | undefined {
  if (!fitted.trimmed) return pageCursor;
  const oldest = fitted.kept[0];
  if (oldest === undefined) return pageCursor;
  const kept = new Set(fitted.kept.map((entry) => entry.frameId));
  const inside = entries.some((entry) => entry.turnId === oldest.turnId && !kept.has(entry.frameId));
  if (inside) return encodeListCursor(agentId, `turn:${oldest.turnId}`, source, { list: 'plan', frameId: oldest.frameId });
  return `turn:${oldest.turnId}`;
}

async function readPlanWindow(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string,
  toolCallId: string | undefined,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ plans: ListedPlan[]; page: ListedPage; missingTool?: boolean } | undefined> {
  const parsed = decodeListCursor(cursor);
  if (parsed?.frameId !== undefined && parsed.agentId !== agentId) throw new TranscriptDetailCursorError();
  const frameResume = parsed?.frameId !== undefined && parsed.anchor.startsWith('turn:')
    ? { turnId: parsed.anchor.slice(5), frameId: parsed.frameId }
    : undefined;
  let beforeItem = frameResume === undefined ? cursor : `turn:${frameResume.turnId}`;
  let pending: PlanEntry[] = [];
  if (frameResume !== undefined) {
    const turn = await loadListedTurn(transcriptService, sessionId, agentId, frameResume.turnId, signal);
    if (turn !== undefined) {
      const projected = await plansOnPage(transcriptService, sessionId, agentId, [turn], [], toolCallId, signal);
      const index = projected.findIndex((entry) => entry.frameId === frameResume.frameId);
      pending = index < 0 ? [] : projected.slice(0, index);
    }
  }
  const source: ListCursor['source'] = transcriptService.forSessionLive(sessionId) !== undefined ? 'live' : 'cold';
  const seen = new Set<string>();
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await readSessionViewTranscriptPage(transcriptService, sessionId, {
      agentId, beforeItem, pageSize: LIST_TURN_PAGE, signal,
    });
    if (page === undefined) return undefined;
    const pagePlans = await plansOnPage(transcriptService, sessionId, agentId, page.items, page.interactions, toolCallId, signal);
    const plans = [...pagePlans, ...pending];
    pending = [];
    if (toolCallId !== undefined) {
      if (plans.length > 0) return { plans: plans.map((entry) => entry.plan), page: {} };
    } else if (plans.length > 0 || page.has_more !== true) {
      const fitted = fitNewest(plans, (subset) => jsonBytes(subset.map((entry) => entry.plan)));
      const hasMore = fitted.trimmed || page.has_more === true;
      const next = planContinuation(agentId, source, plans, fitted, page.next_cursor);
      return { plans: fitted.kept.map((entry) => entry.plan), page: listedPage(hasMore, next) };
    }
    if (page.has_more !== true || page.next_cursor === undefined || seen.has(page.next_cursor)) {
      return toolCallId === undefined ? { plans: [], page: {} } : { plans: [], page: {}, missingTool: true };
    }
    seen.add(page.next_cursor);
    beforeItem = page.next_cursor;
  }
  return toolCallId === undefined ? { plans: [], page: {} } : { plans: [], page: {}, missingTool: true };
}
