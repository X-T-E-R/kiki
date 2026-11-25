import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  CREATED_BY_SESSION_ID_KEY,
  Error2,
  ErrorCodes,
  IBootstrapService,
  IPersonaStore,
  ISessionActivityView,
  ISessionIndex,
  ISessionManager,
  IWorkspaceAliases,
  IWorkspacePersistence,
  SESSION_GROUP_DETACHED_KEY,
  SESSION_GROUP_ORIGIN_KEY,
  type Scope,
  type SessionSummary,
  type SidebarQueryMemberFilter,
} from '@kiki/agent-core-v2';
import { forkedFromOf, promotedFromOf } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import {
  ErrorCode,
  resolveSidebarUnitsRequestSchema,
  resolveSidebarUnitsResponseSchema,
  sidebarGroupMembersQuerySchema,
  sidebarGroupMembersResponseSchema,
  sidebarSessionsQuerySchema,
  sidebarSessionsPageSchema,
  type SidebarExternalClientMark,
  type SidebarRow,
  type SidebarRowGroupOrigin,
  type SidebarSessionsSort,
  type SidebarUnit,
} from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { readSessionCursor } from '../lib/sessionObserver';
import { defineRoute } from '../middleware/defineRoute';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toAttentionCursor } from '../transport/ws/v1/sessionEventJournal';
import { resolveSessionPersonaId } from './sessionPersona';
import { resolveSessionFacts, sendSessionError } from './sessions';
import { withReplyCloseSignal } from '../procedures/requestSignal';

const DEFAULT_SIDEBAR_PAGE_SIZE = 50;
const DEFAULT_SIDEBAR_MEMBER_LIMIT = 50;
const SESSION_PIN_METADATA_KEY = 'kiki.pinned';

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const sidebarGroupIdParamSchema = z.object({
  group_id: z.string().min(1),
});

const pageCursorPayloadSchema = z.object({
  v: z.literal(2),
  fp: z.string().min(1),
  gen: z.number().int().nonnegative().optional(),
  sortAt: z.number().int().nonnegative(),
  sortText: z.string().optional(),
  typedUnitId: z.string().min(1),
});

const memberCursorPayloadSchema = z.object({
  v: z.literal(1),
  fp: z.string().min(1),
  gen: z.number().int().nonnegative().optional(),
  groupId: z.string().min(1),
  ownUpdatedAt: z.number().int().nonnegative(),
  id: z.string().min(1),
});

interface SidebarRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown; raw?: IncomingMessage },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; raw?: IncomingMessage },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SidebarRoutesOptions {
  readonly serverHomeId?: string;
}

interface FilterQueryInput {
  readonly workspace_id?: string;
  readonly persona?: string;
  readonly busy?: boolean;
  readonly include_archive?: boolean;
  readonly archived_only?: boolean;
  readonly include_private?: boolean;
  readonly private_only?: boolean;
  readonly exclude_empty?: boolean;
  readonly pinned?: boolean;
  readonly q?: string;
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeBase64UrlJson(token: string): unknown {
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  return JSON.parse(raw);
}

function stringField(record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractExternalClient(custom: Readonly<Record<string, unknown>> | undefined): SidebarExternalClientMark | undefined {
  const raw = custom?.['externalClient'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj['driver'] !== 'external') return undefined;
  const connectionId = stringField(obj, 'connectionId');
  const clientName = stringField(obj, 'clientName');
  const sessionRef = stringField(obj, 'sessionRef');
  if (connectionId === undefined || clientName === undefined || sessionRef === undefined) return undefined;
  return {
    driver: 'external',
    connectionId,
    clientName,
    sessionRef,
  };
}

function extractGroupOrigin(custom: Readonly<Record<string, unknown>> | undefined): SidebarRowGroupOrigin | undefined {
  const raw = custom?.[SESSION_GROUP_ORIGIN_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const homeId = typeof obj['homeId'] === 'string' ? obj['homeId'] : typeof obj['home_id'] === 'string' ? obj['home_id'] : undefined;
  const hostId = typeof obj['hostId'] === 'string' ? obj['hostId'] : typeof obj['host_id'] === 'string' ? obj['host_id'] : undefined;
  const bridgeId = typeof obj['bridgeId'] === 'string' ? obj['bridgeId'] : typeof obj['bridge_id'] === 'string' ? obj['bridge_id'] : undefined;
  if (homeId === undefined || homeId.length === 0 || hostId === undefined || hostId.length === 0) return undefined;
  return {
    home_id: homeId,
    host_id: hostId,
    ...(bridgeId !== undefined && bridgeId.length > 0 ? { bridge_id: bridgeId } : {}),
  };
}

function collectBusySessionIds(core: Scope): string[] {
  const ids: string[] = [];
  for (const session of core.accessor.get(ISessionManager).list()) {
    if (session.accessor.get(ISessionActivityView).state().busy) {
      ids.push(session.id);
    }
  }
  return ids;
}

function normalizedFilterFingerprintPayload(
  homeKey: string,
  workspaceIds: readonly string[] | undefined,
  query: FilterQueryInput,
  extra: Record<string, unknown>,
): unknown {
  const includePrivate = query.private_only === true
    || query.include_private === true
    || (query.include_private === undefined && query.persona !== undefined);
  return {
    homeKey,
    workspaceIds: workspaceIds === undefined ? undefined : [...workspaceIds].sort(),
    persona: query.persona,
    busy: query.busy,
    includeArchive: query.archived_only === true ? true : query.include_archive === true,
    archivedOnly: query.archived_only === true,
    includePrivate,
    privateOnly: query.private_only === true,
    excludeEmpty: query.exclude_empty === true,
    pinned: query.pinned,
    q: query.q?.trim() || undefined,
    ...extra,
  };
}

function buildMemberFilter(
  core: Scope,
  workspaceIds: readonly string[] | undefined,
  query: FilterQueryInput,
): SidebarQueryMemberFilter {
  const privacy: 'hide' | 'include' | 'only' = query.private_only === true
    ? 'only'
    : query.include_private === true || (query.include_private === undefined && query.persona !== undefined)
      ? 'include'
      : 'hide';
  const archived: 'hide' | 'include' | 'only' = query.archived_only === true
    ? 'only'
    : query.include_archive === true
      ? 'include'
      : 'hide';
  const busyIds = query.busy !== undefined ? collectBusySessionIds(core) : undefined;
  return {
    ...(workspaceIds !== undefined ? { workspaceIds } : {}),
    archived,
    privacy,
    ...(query.exclude_empty === true ? { excludeEmpty: true } : {}),
    ...(query.pinned !== undefined ? { pinned: query.pinned } : {}),
    ...(query.persona !== undefined ? { persona: query.persona } : {}),
    ...(query.busy !== undefined ? { busy: query.busy, busyIds } : {}),
    ...(query.q !== undefined && query.q.trim().length > 0 ? { query: query.q.trim() } : {}),
  };
}

function toWireForkedFrom(summary: SessionSummary): SidebarRow['forked_from'] {
  const value = forkedFromOf(summary);
  if (value === undefined) return undefined;
  return {
    session_id: value.sessionId,
    title: value.title,
    through_message_id: value.throughMessageId,
    turn_index: value.turnIndex,
    through_user_message: value.throughUserMessage,
    seed: value.seed,
    forked_at: value.forkedAt === undefined ? undefined : new Date(value.forkedAt).toISOString(),
  };
}

function toWirePromotedFrom(summary: SessionSummary): SidebarRow['promoted_from'] {
  const value = promotedFromOf(summary);
  if (value === undefined) return undefined;
  return {
    session_id: value.sessionId,
    agent_id: value.agentId,
    agent_name: value.agentName,
    profile: value.profile,
    promoted_at: value.promotedAt === undefined ? undefined : new Date(value.promotedAt).toISOString(),
  };
}

async function resolvePersonaName(
  core: Scope,
  personaNames: Map<string, Promise<string>>,
  personaId: string,
): Promise<string> {
  let pending = personaNames.get(personaId);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const snapshot = await core.accessor.get(IPersonaStore).get(personaId);
        return snapshot?.definition.name ?? personaId;
      } catch {
        return personaId;
      }
    })();
    personaNames.set(personaId, pending);
  }
  return pending;
}

async function isProvenanceSourceEligible(
  core: Scope,
  cache: Map<string, Promise<boolean>>,
  visibleInPage: ReadonlySet<string>,
  filter: SidebarQueryMemberFilter,
  sourceSessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (sourceSessionId.includes(':')) return false;
  if (visibleInPage.has(sourceSessionId)) return true;
  let pending = cache.get(sourceSessionId);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const summary = await core.accessor.get(ISessionIndex).get(sourceSessionId, undefined, signal);
        if (summary === undefined) return false;
        if (filter.archived === 'hide' && summary.archived) return false;
        if (filter.archived === 'only' && !summary.archived) return false;
        const isPriv = summary.private === true;
        if (filter.privacy === 'hide' && isPriv) return false;
        if (filter.privacy === 'only' && !isPriv) return false;
        if (filter.workspaceIds !== undefined && !filter.workspaceIds.includes(summary.workspaceId)) {
          return false;
        }
        if (filter.excludeEmpty === true && (summary.lastPrompt ?? '').length === 0) return false;
        if (filter.persona !== undefined) {
          const pid = resolveSessionPersonaId(core, summary);
          if (pid !== filter.persona) return false;
        }
        if (filter.busy !== undefined) {
          const isBusy = filter.busyIds?.includes(summary.id) ?? false;
          if (isBusy !== filter.busy) return false;
        }
        if (filter.query !== undefined && filter.query.length > 0) {
          const needle = filter.query.toLocaleLowerCase();
          const matched =
            (summary.title ?? '').toLocaleLowerCase().includes(needle) ||
            (summary.cwd ?? '').toLocaleLowerCase().includes(needle) ||
            summary.workspaceId.toLocaleLowerCase().includes(needle);
          if (!matched) return false;
        }
        return true;
      } catch {
        return false;
      }
    })();
    cache.set(sourceSessionId, pending);
  }
  return pending;
}

async function projectSidebarRow(
  core: Scope,
  broadcaster: SessionEventBroadcaster | undefined,
  roots: ReadonlyMap<string, string>,
  personaNames: Map<string, Promise<string>>,
  provenanceVisibility: Map<string, Promise<boolean>>,
  visibleInPage: ReadonlySet<string>,
  filter: SidebarQueryMemberFilter,
  summary: SessionSummary,
  signal: AbortSignal,
): Promise<SidebarRow> {
  const facts = resolveSessionFacts(core, summary.id);
  const livePersona = facts.agentConfig?.persona;
  const personaId = livePersona?.id ?? resolveSessionPersonaId(core, summary);
  const persona = livePersona ?? (
    personaId === undefined
      ? undefined
      : {
          id: personaId,
          name: await resolvePersonaName(core, personaNames, personaId),
          avatarUrl: `/api/personas/${encodeURIComponent(personaId)}/avatar`,
        }
  );
  const cursor = await readSessionCursor(core, broadcaster, summary.id, signal, true, true);
  const cwd = summary.cwd ?? roots.get(summary.workspaceId);
  const ownUpdatedAt = summary.ownUpdatedAt ?? summary.updatedAt;
  const updatedAt = summary.updatedAt;
  const groupId = summary.groupId;
  const groupDetached = summary.groupDetached === true || summary.custom?.[SESSION_GROUP_DETACHED_KEY] === true;
  const executorId = facts.executorId ?? summary.executorId;
  const lastTurnReason = facts.lastTurnReason ?? (facts.live === false ? summary.lastTurnReason : undefined);
  const rawForkedFrom = toWireForkedFrom(summary);
  const forkedFrom =
    rawForkedFrom !== undefined &&
    (await isProvenanceSourceEligible(
      core,
      provenanceVisibility,
      visibleInPage,
      filter,
      rawForkedFrom.session_id,
      signal,
    ))
      ? rawForkedFrom
      : undefined;
  const rawPromotedFrom = toWirePromotedFrom(summary);
  const promotedFrom =
    rawPromotedFrom !== undefined &&
    (await isProvenanceSourceEligible(
      core,
      provenanceVisibility,
      visibleInPage,
      filter,
      rawPromotedFrom.session_id,
      signal,
    ))
      ? rawPromotedFrom
      : undefined;
  const rawCreatedBy = stringField(summary.custom, CREATED_BY_SESSION_ID_KEY);
  const createdBySessionId =
    rawCreatedBy !== undefined &&
    (await isProvenanceSourceEligible(
      core,
      provenanceVisibility,
      visibleInPage,
      filter,
      rawCreatedBy,
      signal,
    ))
      ? rawCreatedBy
      : undefined;
  const rawParentSessionId = stringField(summary.custom, 'parent_session_id');
  const parentSessionId =
    rawParentSessionId !== undefined &&
    (await isProvenanceSourceEligible(
      core,
      provenanceVisibility,
      visibleInPage,
      filter,
      rawParentSessionId,
      signal,
    ))
      ? rawParentSessionId
      : undefined;
  const createdByAgentId = stringField(summary.custom, 'created_by_agent_id');
  const childSessionKind = stringField(summary.custom, 'child_session_kind');
  const externalClient = extractExternalClient(summary.custom);
  return {
    id: summary.id,
    workspace_id: summary.workspaceId,
    ...(cwd !== undefined ? { cwd } : {}),
    title: summary.title ?? '',
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
    own_updated_at: new Date(ownUpdatedAt).toISOString(),
    ...(summary.archived ? { archived: true } : {}),
    ...(summary.archivedAt !== undefined ? { archived_at: new Date(summary.archivedAt).toISOString() } : {}),
    ...(summary.private === true ? { private: true } : {}),
    ...(summary.custom?.[SESSION_PIN_METADATA_KEY] === true ? { pinned: true } : {}),
    busy: facts.busy,
    ...(facts.executing !== undefined ? { executing: facts.executing } : {}),
    ...(facts.cleanupPending !== undefined ? { cleanup_pending: facts.cleanupPending } : {}),
    ...(facts.mainTurnActive ? { main_turn_active: true } : {}),
    ...(facts.pendingInteraction !== 'none' ? { pending_interaction: facts.pendingInteraction } : {}),
    ...(lastTurnReason !== undefined ? { last_turn_reason: lastTurnReason } : {}),
    ...(summary.executionPhase !== undefined ? { execution_phase: summary.executionPhase } : {}),
    delivery: facts.delivery ?? summary.delivery ?? 'reply',
    ...(executorId !== undefined ? { executor_id: executorId } : {}),
    ...(personaId !== undefined ? { persona_id: personaId } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(stringField(summary.custom, 'bot_persona_id') !== undefined ? { bot_persona_id: stringField(summary.custom, 'bot_persona_id') } : {}),
    ...(stringField(summary.custom, 'room_persona_id') !== undefined ? { room_persona_id: stringField(summary.custom, 'room_persona_id') } : {}),
    ...(stringField(summary.custom, 'room_member_of') !== undefined ? { room_member_of: stringField(summary.custom, 'room_member_of') } : {}),
    ...(summary.worktree !== undefined ? {
      worktree: {
        worktree_id: summary.worktree.worktreeId,
        branch: summary.worktree.branch,
        source_root: summary.worktree.sourceRoot,
        base_ref: summary.worktree.baseRef,
      },
    } : {}),
    ...(forkedFrom !== undefined ? { forked_from: forkedFrom } : {}),
    ...(promotedFrom !== undefined ? { promoted_from: promotedFrom } : {}),
    ...(createdBySessionId !== undefined ? { created_by_session_id: createdBySessionId } : {}),
    ...(createdByAgentId !== undefined ? { created_by_agent_id: createdByAgentId } : {}),
    ...(childSessionKind !== undefined ? { child_session_kind: childSessionKind } : {}),
    ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
    ...(externalClient !== undefined ? { external_client: externalClient } : {}),
    last_seq: cursor?.seq ?? 0,
    ...(toAttentionCursor(cursor) !== undefined ? { attention_cursor: toAttentionCursor(cursor) } : {}),
    ...(groupId !== undefined ? { group_id: groupId } : {}),
    ...(groupDetached ? { group_detached: true } : {}),
    ...(extractGroupOrigin(summary.custom) !== undefined ? { group_origin: extractGroupOrigin(summary.custom) } : {}),
  };
}

async function resolveWorkspaceScope(
  core: Scope,
  workspaceId: string | undefined,
): Promise<{
  readonly roots: Map<string, string>;
  readonly workspaceIds: readonly string[] | undefined;
  readonly notFound: boolean;
}> {
  const catalog = await core.accessor.get(IWorkspacePersistence).load();
  const roots = new Map((catalog?.workspaces ?? []).map((w) => [w.id, w.root]));
  const index = core.accessor.get(ISessionIndex);
  const workspaceIds =
    workspaceId === undefined
      ? undefined
      : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(workspaceId);
  const notFound =
    workspaceIds !== undefined &&
    !workspaceIds.some((id) => roots.has(id)) &&
    (workspaceIds.some((id) => catalog?.deletedIds.includes(id)) ||
      (await index.count({ workspaceIds, includeArchived: true })) === 0);
  return { roots, workspaceIds, notFound };
}

/** Register dedicated sidebar unit pagination, group expansion, and batch unit resolution routes. */
export function registerSidebarRoutes(
  app: SidebarRouteHost,
  core: Scope,
  broadcaster: SessionEventBroadcaster | undefined,
  opts?: SidebarRoutesOptions,
): void {
  const homeKey = (): string => opts?.serverHomeId ?? core.accessor.get(IBootstrapService).homeDir;

  const listUnitsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sidebar/sessions',
      querystring: sidebarSessionsQuerySchema,
      success: { data: sidebarSessionsPageSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
        [ErrorCode.SESSION_INDEX_BUILDING]: {},
      },
      description: 'List sidebar session and group units with stable keyset pagination',
      tags: ['sessions', 'sidebar'],
    },
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      try {
        const raw = req.query;
        const { roots, workspaceIds, notFound } = await resolveWorkspaceScope(core, raw.workspace_id);
        if (notFound) {
          reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${raw.workspace_id} does not exist`, req.id));
          return;
        }
        const index = core.accessor.get(ISessionIndex);
        if (index.listSidebarUnits === undefined) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'sidebar unit index is not available');
        }
        const sort: SidebarSessionsSort = raw.sort ?? 'updated_desc';
        const fp = sha256Hex(normalizedFilterFingerprintPayload(homeKey(), workspaceIds, raw, { sort }));
        const currentGen = index.status().generation;
        let decodedCursor: { readonly sortAt: number; readonly sortText?: string; readonly typedUnitId: string } | undefined;
        if (raw.cursor !== undefined) {
          let parsed: z.infer<typeof pageCursorPayloadSchema>;
          try {
            parsed = pageCursorPayloadSchema.parse(decodeBase64UrlJson(raw.cursor));
          } catch {
            reply.send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, 'invalid sidebar page cursor', req.id));
            return;
          }
          if (parsed.fp !== fp || (parsed.gen !== undefined && currentGen !== undefined && parsed.gen !== currentGen)) {
            reply.send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, 'sidebar page cursor does not match current query or index generation', req.id));
            return;
          }
          decodedCursor = {
            sortAt: parsed.sortAt,
            ...(parsed.sortText !== undefined ? { sortText: parsed.sortText } : {}),
            typedUnitId: parsed.typedUnitId,
          };
        }
        const pageSize = raw.page_size ?? DEFAULT_SIDEBAR_PAGE_SIZE;
        const memberLimit = raw.member_limit ?? DEFAULT_SIDEBAR_MEMBER_LIMIT;
        const maxRows = Math.max(200, memberLimit * 2);
        const filter = buildMemberFilter(core, workspaceIds, raw);
        const page = await index.listSidebarUnits({
          filter,
          sort,
          limit: pageSize,
          memberLimit,
          maxRows,
          cursor: decodedCursor,
          signal,
        });
        const personaNames = new Map<string, Promise<string>>();
        const provenanceVisibility = new Map<string, Promise<boolean>>();
        const visibleInPage = new Set<string>();
        for (const unit of page.units) {
          for (const member of unit.members) visibleInPage.add(member.id);
        }
        const units: SidebarUnit[] = await Promise.all(page.units.map(async (unit): Promise<SidebarUnit> => {
          if (unit.kind === 'session') {
            return {
              kind: 'session',
              id: unit.id,
              sort_at: unit.sortAt,
              row: await projectSidebarRow(
                core,
                broadcaster,
                roots,
                personaNames,
                provenanceVisibility,
                visibleInPage,
                filter,
                unit.members[0]!,
                signal,
              ),
            };
          }
          const members = await Promise.all(
            unit.members.map((member) =>
              projectSidebarRow(
                core,
                broadcaster,
                roots,
                personaNames,
                provenanceVisibility,
                visibleInPage,
                filter,
                member,
                signal,
              ),
            ),
          );
          const lastMember = unit.members.at(-1);
          const membersNextCursor = !unit.hasMoreMembers || lastMember === undefined
            ? undefined
            : encodeCursor({
                v: 1,
                fp: sha256Hex(normalizedFilterFingerprintPayload(homeKey(), workspaceIds, raw, { groupId: unit.id })),
                ...(page.generation !== undefined ? { gen: page.generation } : {}),
                groupId: unit.id,
                ownUpdatedAt: lastMember.ownUpdatedAt ?? lastMember.updatedAt,
                id: lastMember.id,
              });
          return {
            kind: 'group',
            id: unit.id,
            title: unit.title ?? '',
            ...(unit.openerId !== undefined ? { opener_id: unit.openerId } : {}),
            ...(unit.primaryWorkspaceId !== undefined ? { primary_workspace_id: unit.primaryWorkspaceId } : {}),
            sort_at: unit.sortAt,
            has_pinned: unit.hasPinned,
            member_count: unit.memberCount,
            members,
            ...(membersNextCursor !== undefined ? { members_next_cursor: membersNextCursor } : {}),
          };
        }));
        const lastUnit = page.units.at(-1);
        const nextCursor = page.hasMore && lastUnit !== undefined
          ? encodeCursor({
              v: 2,
              fp,
              ...(page.generation !== undefined ? { gen: page.generation } : {}),
              sortAt: lastUnit.sortAt,
              ...(lastUnit.sortText !== undefined ? { sortText: lastUnit.sortText } : {}),
              typedUnitId: lastUnit.typedUnitId,
            })
          : undefined;
        const busyCount = collectBusySessionIds(core).length;
        signal.throwIfAborted();
        reply.send(okEnvelope({
          revision: page.revision,
          ...(page.generation !== undefined ? { generation: page.generation } : {}),
          units,
          has_more: page.hasMore && nextCursor !== undefined,
          ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
          busy_count: busyCount,
        }, req.id));
      } catch (error) {
        sendSessionError(reply as Parameters<typeof sendSessionError>[0], req, error);
      }
    }),
  );
  app.get(
    listUnitsRoute.path,
    listUnitsRoute.options,
    listUnitsRoute.handler as Parameters<SidebarRouteHost['get']>[2],
  );

  const listGroupMembersRoute = defineRoute(
    {
      method: 'GET',
      path: '/sidebar/groups/{group_id}/members',
      params: sidebarGroupIdParamSchema,
      querystring: sidebarGroupMembersQuerySchema,
      success: { data: sidebarGroupMembersResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
        [ErrorCode.SESSION_INDEX_BUILDING]: {},
      },
      description: 'Page eligible members of one sidebar session group',
      tags: ['sessions', 'sidebar'],
    },
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      try {
        const raw = req.query;
        const groupId = req.params.group_id;
        const { roots, workspaceIds, notFound } = await resolveWorkspaceScope(core, raw.workspace_id);
        if (notFound) {
          reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${raw.workspace_id} does not exist`, req.id));
          return;
        }
        const index = core.accessor.get(ISessionIndex);
        if (index.listSidebarGroupMembers === undefined) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'sidebar group member query is not available');
        }
        const fp = sha256Hex(normalizedFilterFingerprintPayload(homeKey(), workspaceIds, raw, { groupId }));
        const currentGen = index.status().generation;
        let decodedCursor: { readonly ownUpdatedAt: number; readonly id: string } | undefined;
        if (raw.cursor !== undefined) {
          let parsed: z.infer<typeof memberCursorPayloadSchema>;
          try {
            parsed = memberCursorPayloadSchema.parse(decodeBase64UrlJson(raw.cursor));
          } catch {
            reply.send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, 'invalid group member cursor', req.id));
            return;
          }
          if (
            parsed.fp !== fp ||
            parsed.groupId !== groupId ||
            (parsed.gen !== undefined && currentGen !== undefined && parsed.gen !== currentGen)
          ) {
            reply.send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, 'group member cursor does not match current query or index generation', req.id));
            return;
          }
          decodedCursor = { ownUpdatedAt: parsed.ownUpdatedAt, id: parsed.id };
        }
        const pageSize = raw.page_size ?? DEFAULT_SIDEBAR_MEMBER_LIMIT;
        const filter = buildMemberFilter(core, workspaceIds, raw);
        const page = await index.listSidebarGroupMembers({
          groupId,
          filter,
          limit: pageSize,
          cursor: decodedCursor,
          signal,
        });
        const personaNames = new Map<string, Promise<string>>();
        const provenanceVisibility = new Map<string, Promise<boolean>>();
        const visibleInPage = new Set<string>(page.members.map((m) => m.id));
        const members = await Promise.all(
          page.members.map((member) =>
            projectSidebarRow(
              core,
              broadcaster,
              roots,
              personaNames,
              provenanceVisibility,
              visibleInPage,
              filter,
              member,
              signal,
            ),
          ),
        );
        const lastMember = page.members.at(-1);
        const nextCursor = page.hasMore && lastMember !== undefined
          ? encodeCursor({
              v: 1,
              fp,
              ...(page.generation !== undefined ? { gen: page.generation } : {}),
              groupId,
              ownUpdatedAt: lastMember.ownUpdatedAt ?? lastMember.updatedAt,
              id: lastMember.id,
            })
          : undefined;
        signal.throwIfAborted();
        reply.send(okEnvelope({
          revision: page.revision,
          ...(page.generation !== undefined ? { generation: page.generation } : {}),
          group_id: groupId,
          member_count: page.memberCount,
          members,
          has_more: page.hasMore && nextCursor !== undefined,
          ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
        }, req.id));
      } catch (error) {
        sendSessionError(reply as Parameters<typeof sendSessionError>[0], req, error);
      }
    }),
  );
  app.get(
    listGroupMembersRoute.path,
    listGroupMembersRoute.options,
    listGroupMembersRoute.handler as Parameters<SidebarRouteHost['get']>[2],
  );

  const resolveUnitsRoute = defineRoute(
    {
      method: 'POST',
      path: '/sidebar/units::resolve',
      body: resolveSidebarUnitsRequestSchema,
      success: { data: resolveSidebarUnitsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.SESSION_INDEX_BUILDING]: {},
      },
      description: 'Resolve affected sidebar session or group units in one snapshot',
      tags: ['sessions', 'sidebar'],
    },
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      try {
        const body = req.body;
        const { roots, workspaceIds, notFound } = await resolveWorkspaceScope(core, body.workspace_id);
        if (notFound) {
          reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${body.workspace_id} does not exist`, req.id));
          return;
        }
        const index = core.accessor.get(ISessionIndex);
        if (index.resolveSidebarUnits === undefined) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'sidebar unit resolver is not available');
        }
        const filter = buildMemberFilter(core, workspaceIds, body);
        const memberLimit = body.member_limit ?? DEFAULT_SIDEBAR_MEMBER_LIMIT;
        const resolved = await index.resolveSidebarUnits({
          sessionIds: body.session_ids ?? [],
          groupIds: body.group_ids ?? [],
          filter,
          memberLimit,
          signal,
        });
        const personaNames = new Map<string, Promise<string>>();
        const provenanceVisibility = new Map<string, Promise<boolean>>();
        const visibleInPage = new Set<string>();
        for (const unit of resolved.units) {
          for (const member of unit.members) visibleInPage.add(member.id);
        }
        const units: SidebarUnit[] = await Promise.all(resolved.units.map(async (unit): Promise<SidebarUnit> => {
          if (unit.kind === 'session') {
            return {
              kind: 'session',
              id: unit.id,
              sort_at: unit.sortAt,
              row: await projectSidebarRow(
                core,
                broadcaster,
                roots,
                personaNames,
                provenanceVisibility,
                visibleInPage,
                filter,
                unit.members[0]!,
                signal,
              ),
            };
          }
          const members = await Promise.all(
            unit.members.map((member) =>
              projectSidebarRow(
                core,
                broadcaster,
                roots,
                personaNames,
                provenanceVisibility,
                visibleInPage,
                filter,
                member,
                signal,
              ),
            ),
          );
          const lastMember = unit.members.at(-1);
          const membersNextCursor = !unit.hasMoreMembers || lastMember === undefined
            ? undefined
            : encodeCursor({
                v: 1,
                fp: sha256Hex(normalizedFilterFingerprintPayload(homeKey(), workspaceIds, body, { groupId: unit.id })),
                ...(resolved.generation !== undefined ? { gen: resolved.generation } : {}),
                groupId: unit.id,
                ownUpdatedAt: lastMember.ownUpdatedAt ?? lastMember.updatedAt,
                id: lastMember.id,
              });
          return {
            kind: 'group',
            id: unit.id,
            title: unit.title ?? '',
            ...(unit.openerId !== undefined ? { opener_id: unit.openerId } : {}),
            ...(unit.primaryWorkspaceId !== undefined ? { primary_workspace_id: unit.primaryWorkspaceId } : {}),
            sort_at: unit.sortAt,
            has_pinned: unit.hasPinned,
            member_count: unit.memberCount,
            members,
            ...(membersNextCursor !== undefined ? { members_next_cursor: membersNextCursor } : {}),
          };
        }));
        signal.throwIfAborted();
        reply.send(okEnvelope({
          revision: resolved.revision,
          ...(resolved.generation !== undefined ? { generation: resolved.generation } : {}),
          units,
          missing_session_ids: [...resolved.missingSessionIds],
          missing_group_ids: [...resolved.missingGroupIds],
        }, req.id));
      } catch (error) {
        sendSessionError(reply as Parameters<typeof sendSessionError>[0], req, error);
      }
    }),
  );
  app.post(
    resolveUnitsRoute.path,
    resolveUnitsRoute.options,
    resolveUnitsRoute.handler as Parameters<SidebarRouteHost['post']>[2],
  );
}
