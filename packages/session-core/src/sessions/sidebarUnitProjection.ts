import {
  emptySessionUsage,
  ErrorCode,
  type RoomListItem,
  type Session,
  type SidebarGroupUnit,
  type SidebarRow,
  type SidebarRowGroupOrigin,
  type SidebarSessionsSort,
  type SidebarUnit,
} from '@kiki/protocol';
import { roomSeenKey, roomUnreadCount } from '../settings/roomReadState';
import {
  encodeConversationRef,
  type ConversationSeenMap,
  type SessionSeenMap,
} from '../settings/sessionReadState';
import { roomRefLink } from './conversationLinks';
import {
  roomWorkspaceId,
  type ConversationListItem,
  type NamedConversationWorkspace,
} from './conversationList';
import {
  filterSessions,
  SESSION_NOTIFICATION_MODE_META_KEY,
  SESSION_PIN_META_KEY,
  sessionNotificationMode,
  sessionStatusOf,
  type SessionFilterInput,
  type SessionSortOrder,
  type TimeGroupKey,
  type TimeGroupLabels,
  WORKSPACE_UNGROUPED_KEY,
} from './sessionList';
import {
  sidebarUnitRows,
  type SidebarUnitPagesData,
} from './sidebarUnits';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Convert a bounded `SidebarRow` DTO into a `Session`-compatible view for UI row/menu consumers. */
export function sidebarRowToSession(row: SidebarRow): Session {
  const metadata: Record<string, unknown> = {
    cwd: row.cwd ?? '',
  };
  if (row.pinned === true) metadata[SESSION_PIN_META_KEY] = true;
  if (row.notifications === 'off' || row.notifications === 'urgent') {
    metadata[SESSION_NOTIFICATION_MODE_META_KEY] = row.notifications;
  }
  if (row.bot_persona_id !== undefined) metadata['bot_persona_id'] = row.bot_persona_id;
  if (row.room_persona_id !== undefined) metadata['room_persona_id'] = row.room_persona_id;
  if (row.room_member_of !== undefined) metadata['room_member_of'] = row.room_member_of;
  if (row.persona_id !== undefined) metadata['persona_id'] = row.persona_id;
  if (row.created_by_session_id !== undefined) metadata['created_by_session_id'] = row.created_by_session_id;
  if (row.group_id !== undefined) metadata['kiki.group_id'] = row.group_id;
  if (row.group_detached === true) metadata['kiki.group_detached'] = true;
  if (row.child_session_kind !== undefined) metadata['child_session_kind'] = row.child_session_kind;
  if (row.parent_session_id !== undefined) metadata['parent_session_id'] = row.parent_session_id;
  if (row.created_by_agent_id !== undefined) metadata['created_by_agent_id'] = row.created_by_agent_id;
  if (row.external_client !== undefined) metadata['externalClient'] = row.external_client;

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    own_updated_at: row.own_updated_at,
    busy: row.busy,
    ...(row.executing !== undefined ? { executing: row.executing } : {}),
    ...(row.cleanup_pending !== undefined ? { cleanup_pending: row.cleanup_pending } : {}),
    ...(row.main_turn_active !== undefined ? { main_turn_active: row.main_turn_active } : {}),
    ...(row.pending_interaction !== undefined ? { pending_interaction: row.pending_interaction } : {}),
    ...(row.last_turn_reason !== undefined ? { last_turn_reason: row.last_turn_reason } : {}),
    ...(row.execution_phase !== undefined ? { execution_phase: row.execution_phase } : {}),
    ...(row.delivery !== undefined ? { delivery: row.delivery } : {}),
    ...(row.executor_id !== undefined ? { executor_id: row.executor_id } : {}),
    ...(row.archived !== undefined ? { archived: row.archived } : {}),
    ...(row.archived_at !== undefined ? { archived_at: row.archived_at } : {}),
    ...(row.private !== undefined ? { private: row.private } : {}),
    ...(row.worktree !== undefined ? { worktree: row.worktree } : {}),
    ...(row.forked_from !== undefined ? { forked_from: row.forked_from } : {}),
    ...(row.promoted_from !== undefined ? { promoted_from: row.promoted_from } : {}),
    metadata: metadata as Session['metadata'],
    agent_config: {
      model: '',
      ...(row.persona !== undefined
        ? { persona: row.persona }
        : row.persona_id !== undefined
          ? { persona: { id: row.persona_id, name: row.persona_id } }
          : {}),
    },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: row.last_seq,
    ...(row.attention_cursor !== undefined ? { attention_cursor: row.attention_cursor } : {}),
  };
}

/** Map sidebar GUI sort order onto the wire `SidebarSessionsSort` enum. */
export function sidebarUnitQuerySort(order: SessionSortOrder): SidebarSessionsSort {
  if (order === 'created-desc') return 'created_desc';
  if (order === 'title') return 'title';
  return 'updated_desc';
}

/** Detect server `40922 PAGE_TOKEN_MISMATCH` errors so callers can cleanly rebase from page 1. */
export function isPageTokenMismatchError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object') {
    const rec = error as { code?: unknown; data?: { code?: unknown }; cause?: unknown };
    if (rec.code === ErrorCode.PAGE_TOKEN_MISMATCH || rec.code === 'PAGE_TOKEN_MISMATCH') return true;
    if (rec.data?.code === ErrorCode.PAGE_TOKEN_MISMATCH) return true;
    if (rec.cause !== undefined && rec.cause !== error && isPageTokenMismatchError(rec.cause)) return true;
  }
  if (error instanceof Error) {
    return error.message.includes('PAGE_TOKEN_MISMATCH') || error.message.includes(String(ErrorCode.PAGE_TOKEN_MISMATCH));
  }
  return false;
}

/** Flatten deduplicated sidebar units into `Session[]` for non-grouped consumers (QuickSwitcher, notifications, personas). */
export function flattenSidebarUnitsToSessions(units: readonly SidebarUnit[]): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  for (const unit of units) {
    for (const row of sidebarUnitRows(unit)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(sidebarRowToSession(row));
    }
  }
  return out;
}

/**
 * Patch a single row inside `SidebarUnitPagesData` in place (for optimistic pin/rename/private/archive),
 * preserving structural sharing on untouched pages and units.
 */
export function patchSidebarUnitRow(
  old: SidebarUnitPagesData | undefined,
  sessionId: string,
  transform: (row: SidebarRow) => SidebarRow,
): SidebarUnitPagesData | undefined {
  if (old === undefined || old === null || !Array.isArray(old.pages)) return old;
  let pagesChanged = false;
  const nextPages = old.pages.map((page) => {
    if (!Array.isArray(page?.units)) return page;
    let unitsChanged = false;
    const nextUnits = page.units.map((unit): SidebarUnit => {
      if (unit.kind === 'session') {
        if (unit.row.id !== sessionId) return unit;
        const nextRow = transform(unit.row);
        if (nextRow === unit.row) return unit;
        unitsChanged = true;
        return { ...unit, row: nextRow };
      }
      let membersChanged = false;
      const nextMembers = unit.members.map((member) => {
        if (member.id !== sessionId) return member;
        const nextMember = transform(member);
        if (nextMember !== member) membersChanged = true;
        return nextMember;
      });
      if (!membersChanged) return unit;
      unitsChanged = true;
      const opener = unit.opener_id !== undefined
        ? nextMembers.find((member) => member.id === unit.opener_id)
        : nextMembers[0];
      const nextTitle = opener !== undefined && opener.title.trim() !== '' ? opener.title : unit.title;
      const anyLoadedPinned = nextMembers.some((member) => member.pinned === true);
      const nextHasPinned = unit.members_next_cursor !== undefined
        ? (anyLoadedPinned || unit.has_pinned)
        : anyLoadedPinned;
      return {
        ...unit,
        title: nextTitle,
        has_pinned: nextHasPinned,
        members: nextMembers,
      };
    });
    if (!unitsChanged) return page;
    pagesChanged = true;
    return { ...page, units: nextUnits };
  });
  return pagesChanged ? { ...old, pages: nextPages } : old;
}

export interface SidebarUnitSpaceSource {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly isRemote: boolean;
  readonly serverHomeId?: string;
  readonly units: readonly SidebarUnit[];
  readonly rooms?: readonly RoomListItem[];
  readonly workspaces?: readonly NamedConversationWorkspace[];
  readonly partialCoverage?: boolean;
}

export type SidebarSessionItem = Extract<ConversationListItem, { kind: 'session' }> & {
  readonly groupId?: string;
  readonly groupOrigin?: SidebarRowGroupOrigin;
};

export interface SidebarSessionGroupEntry {
  readonly kind: 'session-group';
  readonly key: string;
  readonly groupId: string;
  readonly title: string;
  readonly sortAt: number;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly workspaceId: string;
  readonly pinned: boolean;
  readonly memberCount: number;
  readonly members: readonly SidebarSessionItem[];
  readonly membersNextCursor?: string;
  readonly spaceKey: string;
  readonly openerId?: string;
  readonly partialCoverage?: boolean;
}

export type SidebarDisplayItem = ConversationListItem | SidebarSessionGroupEntry;

export interface SidebarDisplayBucket {
  readonly key: string;
  readonly label: string;
  readonly items: readonly SidebarDisplayItem[];
  readonly total: number;
}

export interface ProjectSidebarUnitGroupsOptions {
  readonly groupBy: 'time' | 'workspace' | 'none';
  readonly workspaces: readonly NamedConversationWorkspace[];
  readonly filters: SessionFilterInput;
  readonly nowMs: number;
  readonly order?: SessionSortOrder;
  readonly labels?: TimeGroupLabels;
  readonly ungroupedLabel?: string;
  readonly seenV2?: ConversationSeenMap;
  readonly fallbackLocalSpaceKey?: string;
  readonly fallbackLocalSeen?: SessionSeenMap;
  /** Per-member suppression predicate (e.g., active persona home / room member), applied BEFORE counts and placement. */
  readonly shouldHideRow?: (row: SidebarRow, session: Session, spaceKey: string, isRemote: boolean) => boolean;
}

interface RawFragment {
  readonly source: SidebarUnitSpaceSource;
  readonly unit: SidebarGroupUnit;
  readonly origins: readonly SidebarRowGroupOrigin[];
}

function sameOrigin(a: SidebarRowGroupOrigin, b: SidebarRowGroupOrigin): boolean {
  return a.home_id === b.home_id && a.host_id === b.host_id;
}

function fragmentsVerifiedLinked(a: RawFragment, b: RawFragment): boolean {
  if (a.source.spaceKey === b.source.spaceKey) return true;
  if (a.source.serverHomeId !== undefined && b.origins.some((origin) => origin.home_id === a.source.serverHomeId)) {
    return true;
  }
  if (b.source.serverHomeId !== undefined && a.origins.some((origin) => origin.home_id === b.source.serverHomeId)) {
    return true;
  }
  for (const oa of a.origins) {
    for (const ob of b.origins) {
      if (sameOrigin(oa, ob)) return true;
    }
  }
  return false;
}

function rowTimestampMs(iso: string | undefined): number {
  if (iso === undefined) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function makeSidebarSessionItem(
  row: SidebarRow,
  session: Session,
  source: SidebarUnitSpaceSource,
  seenV2: ConversationSeenMap,
  fallbackLocalSpaceKey: string,
  fallbackLocalSeen: SessionSeenMap,
): SidebarSessionItem {
  const connectionId = source.isRemote && source.spaceKey.startsWith('remote:')
    ? source.spaceKey.slice('remote:'.length)
    : undefined;
  const prefix = connectionId !== undefined ? `/p/${encodeURIComponent(connectionId)}` : '';
  const isLocalDefault = !source.isRemote && source.spaceKey === fallbackLocalSpaceKey;
  const itemKey = source.isRemote ? `${source.spaceKey}:session:${row.id}` : `session:${row.id}`;
  const refKey = encodeConversationRef({ spaceKey: source.spaceKey, kind: 'session', id: row.id });
  const seenSeq = seenV2[refKey]?.seq ?? (isLocalDefault ? (fallbackLocalSeen[row.id] ?? 0) : 0);
  const mode = sessionNotificationMode(session);
  const suppressUnread = mode === 'off' || (mode === 'urgent' && row.last_turn_reason !== 'failed');
  return {
    ...session,
    updated_at: row.own_updated_at ?? row.updated_at,
    kind: 'session',
    session,
    key: itemKey,
    href: `${prefix}/s/${encodeURIComponent(row.id)}`,
    unread_count: suppressUnread ? 0 : Math.max(0, (row.attention_cursor?.seq ?? row.last_seq) - seenSeq),
    needs_you: row.pending_interaction === 'approval' || row.pending_interaction === 'question',
    failed: row.last_turn_reason === 'failed',
    pinned: row.pinned === true,
    spaceKey: source.spaceKey,
    spaceName: source.spaceName,
    isRemote: source.isRemote,
    ...(row.group_id !== undefined ? { groupId: row.group_id } : {}),
    ...(row.group_origin !== undefined ? { groupOrigin: row.group_origin } : {}),
  };
}

function memberMatchesFilters(
  row: SidebarRow,
  session: Session,
  filters: SessionFilterInput,
  workspaceSet: ReadonlySet<string>,
  statusSet: ReadonlySet<string>,
): boolean {
  const archived = row.archived === true;
  if (filters.archived === 'hide' && archived) return false;
  if (filters.archived === 'only' && !archived) return false;
  const isPrivate = row.private === true;
  const privateFilter = filters.private ?? 'hide';
  if (privateFilter === 'hide' && isPrivate) return false;
  if (privateFilter === 'only' && !isPrivate) return false;
  if (workspaceSet.size > 0 && !workspaceSet.has(row.workspace_id)) return false;
  if (statusSet.size > 0 && !statusSet.has(sessionStatusOf(session))) return false;
  return true;
}

function itemSortAt(item: SidebarDisplayItem): number {
  if (item.kind === 'session-group') return item.sortAt;
  return rowTimestampMs(item.updated_at);
}

function itemCreatedAt(item: SidebarDisplayItem): string {
  return item.kind === 'session-group' ? item.createdAt : item.created_at;
}

function itemTitle(item: SidebarDisplayItem): string {
  return item.title.trim();
}

function itemWorkspaceId(item: SidebarDisplayItem): string {
  return item.kind === 'session-group' ? item.workspaceId : item.workspace_id;
}

function compareDisplayItems(
  a: SidebarDisplayItem,
  b: SidebarDisplayItem,
  order: SessionSortOrder,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    const diff = itemSortAt(b) - itemSortAt(a);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  }
  if (order === 'title') {
    const ta = itemTitle(a);
    const tb = itemTitle(b);
    if (ta !== tb) return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
    const diff = itemSortAt(b) - itemSortAt(a);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  }
  if (order === 'created-desc') {
    const c = itemCreatedAt(b).localeCompare(itemCreatedAt(a));
    if (c !== 0) return c;
    const diff = itemSortAt(b) - itemSortAt(a);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  }
  if (order === 'updated-asc') {
    const diff = itemSortAt(a) - itemSortAt(b);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  }
  const diff = itemSortAt(b) - itemSortAt(a);
  return diff !== 0 ? diff : a.key.localeCompare(b.key);
}

/** Collect group IDs present in loaded multi-space sources so other online hosts can batch-resolve fragments. */
export function collectCrossHostGroupIds(sources: readonly SidebarUnitSpaceSource[]): readonly string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    for (const unit of source.units) {
      if (unit.kind === 'group') {
        ids.add(unit.id);
      } else if (unit.row.group_id !== undefined) {
        ids.add(unit.row.group_id);
      }
    }
  }
  return [...ids];
}

/**
 * Project server-paginated sidebar units and rooms from one or more spaces into
 * ordered, persona-suppressed, filtered, single-placement sidebar buckets.
 */
export function projectSidebarUnitGroups(
  sources: readonly SidebarUnitSpaceSource[],
  options: ProjectSidebarUnitGroupsOptions,
): SidebarDisplayBucket[] {
  const seenV2 = options.seenV2 ?? {};
  const fallbackLocalSpaceKey = options.fallbackLocalSpaceKey ?? 'main';
  const fallbackLocalSeen = options.fallbackLocalSeen ?? {};
  const order = options.order ?? 'updated-desc';
  const workspaceSet = new Set(options.filters.workspaces);
  const statusSet = new Set(options.filters.status);
  const hasAnyPartialSource = sources.some((src) => src.partialCoverage === true);
  const narrowMemberFilterActive = workspaceSet.size > 0 || statusSet.size > 0;

  const groupFragmentsById = new Map<string, RawFragment[]>();
  const standaloneItems: SidebarDisplayItem[] = [];
  const seenStandaloneKeys = new Set<string>();

  for (const source of sources) {
    for (const unit of source.units) {
      if (unit.kind === 'session') {
        const session = sidebarRowToSession(unit.row);
        if (options.shouldHideRow?.(unit.row, session, source.spaceKey, source.isRemote) === true) {
          continue;
        }
        if (!memberMatchesFilters(unit.row, session, options.filters, workspaceSet, statusSet)) {
          continue;
        }
        const item = makeSidebarSessionItem(unit.row, session, source, seenV2, fallbackLocalSpaceKey, fallbackLocalSeen);
        if (seenStandaloneKeys.has(item.key)) continue;
        seenStandaloneKeys.add(item.key);
        standaloneItems.push(item);
        continue;
      }
      const origins: SidebarRowGroupOrigin[] = [];
      for (const member of unit.members) {
        if (member.group_origin !== undefined) origins.push(member.group_origin);
      }
      const list = groupFragmentsById.get(unit.id);
      const fragment: RawFragment = { source, unit, origins };
      if (list === undefined) groupFragmentsById.set(unit.id, [fragment]);
      else list.push(fragment);
    }
  }

  const groupItems: SidebarDisplayItem[] = [];
  for (const [groupId, fragments] of groupFragmentsById) {
    // Partition fragments into verified-linked clusters so unverified collisions across hosts never merge.
    const clusters: RawFragment[][] = [];
    for (const fragment of fragments) {
      let target: RawFragment[] | undefined;
      for (const cluster of clusters) {
        if (cluster.some((member) => fragmentsVerifiedLinked(member, fragment))) {
          target = cluster;
          break;
        }
      }
      if (target === undefined) clusters.push([fragment]);
      else target.push(fragment);
    }

    for (const cluster of clusters) {
      const eligibleMembers: SidebarSessionItem[] = [];
      const memberSeenKeys = new Set<string>();
      let loadedRawCount = 0;
      let droppedLoadedCount = 0;
      let totalReportedCount = 0;
      let anyHasPinnedOnWire = false;
      let maxWireSortAt = 0;
      let primaryOpenerId: string | undefined;
      let primaryWorkspaceId: string | undefined;
      let wireTitle = '';
      let primarySpaceKey = cluster[0]!.source.spaceKey;
      let membersNextCursor: string | undefined;
      let crossHostCoalesced = cluster.length > 1;
      let hasCrossHostOriginHint = false;

      for (const fragment of cluster) {
        totalReportedCount += fragment.unit.member_count;
        if (fragment.unit.has_pinned) anyHasPinnedOnWire = true;
        if (fragment.unit.sort_at > maxWireSortAt) maxWireSortAt = fragment.unit.sort_at;
        if (primaryOpenerId === undefined && fragment.unit.opener_id !== undefined) {
          primaryOpenerId = fragment.unit.opener_id;
        }
        if (primaryWorkspaceId === undefined && fragment.unit.primary_workspace_id !== undefined) {
          primaryWorkspaceId = fragment.unit.primary_workspace_id;
        }
        if (wireTitle === '' && fragment.unit.title.trim() !== '') {
          wireTitle = fragment.unit.title;
        }
        if (membersNextCursor === undefined && fragment.unit.members_next_cursor !== undefined) {
          membersNextCursor = fragment.unit.members_next_cursor;
          primarySpaceKey = fragment.source.spaceKey;
        }
        if (!fragment.source.isRemote) {
          primarySpaceKey = fragment.source.spaceKey;
        }
        if (fragment.origins.length > 0) hasCrossHostOriginHint = true;

        for (const row of fragment.unit.members) {
          loadedRawCount += 1;
          const session = sidebarRowToSession(row);
          if (options.shouldHideRow?.(row, session, fragment.source.spaceKey, fragment.source.isRemote) === true) {
            droppedLoadedCount += 1;
            continue;
          }
          if (!memberMatchesFilters(row, session, options.filters, workspaceSet, statusSet)) {
            droppedLoadedCount += 1;
            continue;
          }
          const item = makeSidebarSessionItem(
            row,
            session,
            fragment.source,
            seenV2,
            fallbackLocalSpaceKey,
            fallbackLocalSeen,
          );
          if (memberSeenKeys.has(item.key)) continue;
          memberSeenKeys.add(item.key);
          eligibleMembers.push(item);
        }
      }

      if (eligibleMembers.length === 0) continue;

      // Sort members deterministically: own_updated_at DESC, then key ASC.
      eligibleMembers.sort((a, b) => {
        const diff = rowTimestampMs(b.updated_at) - rowTimestampMs(a.updated_at);
        return diff !== 0 ? diff : a.key.localeCompare(b.key);
      });

      const effectiveMemberCount = droppedLoadedCount === 0
        ? Math.max(totalReportedCount, eligibleMembers.length)
        : Math.max(eligibleMembers.length, totalReportedCount - droppedLoadedCount);

      // Unwrap singletons when no unloaded continuation remains.
      if (eligibleMembers.length === 1 && membersNextCursor === undefined && effectiveMemberCount <= 1) {
        const lone = eligibleMembers[0]!;
        if (!seenStandaloneKeys.has(lone.key)) {
          seenStandaloneKeys.add(lone.key);
          standaloneItems.push(lone);
        }
        continue;
      }

      const eligibleOpener = primaryOpenerId !== undefined
        ? eligibleMembers.find((member) => member.id === primaryOpenerId)
        : undefined;
      const titleSource = eligibleOpener ?? eligibleMembers[0]!;
      const groupTitle = eligibleOpener !== undefined
        ? (eligibleOpener.title.trim() !== '' ? eligibleOpener.title : (wireTitle || titleSource.title))
        : (droppedLoadedCount === 0 && wireTitle !== '' ? wireTitle : titleSource.title);

      const resolvedWorkspaceId = eligibleOpener !== undefined
        ? eligibleOpener.workspace_id
        : (primaryWorkspaceId !== undefined && eligibleMembers.some((member) => member.workspace_id === primaryWorkspaceId)
            ? primaryWorkspaceId
            : eligibleMembers[0]!.workspace_id);

      let maxEligibleSortAt = 0;
      let maxCreatedAt = eligibleMembers[0]!.created_at;
      for (const member of eligibleMembers) {
        const ts = rowTimestampMs(member.updated_at);
        if (ts > maxEligibleSortAt) maxEligibleSortAt = ts;
        if (member.created_at.localeCompare(maxCreatedAt) > 0) maxCreatedAt = member.created_at;
      }
      const effectiveSortAt =
        droppedLoadedCount === 0 && (membersNextCursor !== undefined || loadedRawCount < totalReportedCount)
          ? Math.max(maxWireSortAt, maxEligibleSortAt)
          : (maxEligibleSortAt > 0 ? maxEligibleSortAt : maxWireSortAt);

      const anyEligiblePinned = eligibleMembers.some((member) => member.pinned);
      const pinned = anyEligiblePinned || (
        anyHasPinnedOnWire
        && !narrowMemberFilterActive
        && (membersNextCursor !== undefined || totalReportedCount > loadedRawCount)
      );

      const hasLocal = cluster.some((fragment) => !fragment.source.isRemote);
      const groupKey = hasLocal
        ? `group:${groupId}`
        : `${cluster[0]!.source.spaceKey}:group:${groupId}`;

      groupItems.push({
        kind: 'session-group',
        key: groupKey,
        groupId,
        title: groupTitle,
        sortAt: effectiveSortAt,
        updatedAt: new Date(effectiveSortAt).toISOString(),
        createdAt: maxCreatedAt,
        workspaceId: resolvedWorkspaceId,
        pinned,
        memberCount: effectiveMemberCount,
        members: eligibleMembers,
        ...(membersNextCursor !== undefined ? { membersNextCursor } : {}),
        spaceKey: primarySpaceKey,
        ...(eligibleOpener !== undefined ? { openerId: eligibleOpener.id } : {}),
        ...(hasAnyPartialSource && (crossHostCoalesced || hasCrossHostOriginHint) ? { partialCoverage: true } : {}),
      });
    }
  }

  // Merge rooms alongside units using the exact same filter & workspace rules.
  const roomItems: ConversationListItem[] = [];
  const seenRoomKeys = new Set<string>();
  for (const source of sources) {
    const workspaces = source.workspaces ?? options.workspaces;
    const connectionId = source.isRemote && source.spaceKey.startsWith('remote:')
      ? source.spaceKey.slice('remote:'.length)
      : undefined;
    const prefix = connectionId !== undefined ? `/p/${encodeURIComponent(connectionId)}` : '';
    const isLocalDefault = !source.isRemote && source.spaceKey === fallbackLocalSpaceKey;

    for (const room of source.rooms ?? []) {
      const baseRoomKey = roomSeenKey(room.id);
      const itemKey = source.isRemote ? `${source.spaceKey}:${baseRoomKey}` : baseRoomKey;
      if (seenRoomKeys.has(itemKey)) continue;
      seenRoomKeys.add(itemKey);
      const refKey = encodeConversationRef({ spaceKey: source.spaceKey, kind: 'room', id: room.id });
      const seenSeq = seenV2[refKey]?.seq ?? (isLocalDefault ? (fallbackLocalSeen[baseRoomKey] ?? 0) : 0);
      roomItems.push({
        kind: 'room',
        room,
        id: room.id,
        key: itemKey,
        href: `${prefix}${roomRefLink(room.id)}`,
        title: room.title,
        workspace_id: roomWorkspaceId(room.workspace, workspaces),
        created_at: room.createdAt,
        updated_at: room.updatedAt,
        metadata: { cwd: '', [SESSION_PIN_META_KEY]: room.pinned },
        archived: room.archived,
        busy: room.busy,
        pending_interaction: room.pendingInteraction,
        last_seq: room.lastSeq,
        unread_count: roomUnreadCount(room.id, room.lastSeq, { [baseRoomKey]: seenSeq }),
        needs_you: room.needsYou,
        failed: room.failed,
        pinned: room.pinned,
        member_count: room.memberCount,
        spaceKey: source.spaceKey,
        spaceName: source.spaceName,
        isRemote: source.isRemote,
      });
    }
  }
  const filteredRooms = filterSessions(roomItems, { ...options.filters, status: [] }).filter((item) =>
    options.filters.status.length === 0
    || options.filters.status.includes(item.needs_you ? 'needs-me' : item.busy ? 'running' : 'idle'),
  );

  // Drop any standalone row already covered by a group in the same space.
  const coveredMemberKeys = new Set<string>();
  for (const item of groupItems) {
    if (item.kind === 'session-group') {
      for (const member of item.members) coveredMemberKeys.add(member.key);
    }
  }
  const allItems: SidebarDisplayItem[] = [
    ...groupItems,
    ...standaloneItems.filter((item) => !coveredMemberKeys.has(item.key)),
    ...filteredRooms,
  ];
  allItems.sort((a, b) => compareDisplayItems(a, b, order));

  const countOf = (items: readonly SidebarDisplayItem[]): number =>
    items.reduce((sum, item) => sum + (item.kind === 'session-group' ? item.memberCount : 1), 0);

  if (options.groupBy === 'none') {
    if (allItems.length === 0) return [];
    return [{ key: 'all', label: '', items: allItems, total: countOf(allItems) }];
  }

  if (options.groupBy === 'time') {
    const labels = options.labels ?? {};
    const keys: readonly TimeGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older'];
    const buckets = keys.map((key) => ({ key, label: labels[key] ?? key, items: [] as SidebarDisplayItem[] }));
    const [pinnedBucket, today, yesterday, week, month, older] = buckets as [
      { key: string; label: string; items: SidebarDisplayItem[] },
      { key: string; label: string; items: SidebarDisplayItem[] },
      { key: string; label: string; items: SidebarDisplayItem[] },
      { key: string; label: string; items: SidebarDisplayItem[] },
      { key: string; label: string; items: SidebarDisplayItem[] },
      { key: string; label: string; items: SidebarDisplayItem[] },
    ];
    const todayStart = startOfLocalDay(options.nowMs);
    const yesterdayStart = todayStart - DAY_MS;
    const weekStart = todayStart - 6 * DAY_MS;
    const monthStart = todayStart - 29 * DAY_MS;

    for (const item of allItems) {
      if (item.pinned) {
        pinnedBucket.items.push(item);
        continue;
      }
      const ts = itemSortAt(item);
      if (ts <= 0) older.items.push(item);
      else if (ts >= todayStart) today.items.push(item);
      else if (ts >= yesterdayStart) yesterday.items.push(item);
      else if (ts >= weekStart) week.items.push(item);
      else if (ts >= monthStart) month.items.push(item);
      else older.items.push(item);
    }
    return buckets
      .filter((bucket) => bucket.items.length > 0)
      .map((bucket) => ({ ...bucket, total: countOf(bucket.items) }));
  }

  // Workspace grouping: pinned lifts into leading global `pinned` bucket; every unit placed once.
  const pinnedLabel = options.labels?.pinned;
  const ungroupedLabel = options.ungroupedLabel ?? 'ungrouped';
  const pinnedItems: SidebarDisplayItem[] = [];
  const wsOrder = new Map<string, number>(options.workspaces.map((ws, idx) => [ws.id, idx]));
  const wsNames = new Map<string, string>(options.workspaces.map((ws) => [ws.id, ws.name]));
  const buckets = new Map<string, { key: string; label: string; items: SidebarDisplayItem[] }>();
  const ensure = (key: string, label: string) => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { key, label, items: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const item of allItems) {
    if (pinnedLabel !== undefined && item.pinned) {
      pinnedItems.push(item);
      continue;
    }
    const wsId = itemWorkspaceId(item);
    if (wsOrder.has(wsId)) {
      ensure(wsId, wsNames.get(wsId) ?? wsId).items.push(item);
    } else {
      ensure(WORKSPACE_UNGROUPED_KEY, ungroupedLabel).items.push(item);
    }
  }

  const ordered: SidebarDisplayBucket[] = [];
  if (pinnedLabel !== undefined && pinnedItems.length > 0) {
    ordered.push({ key: 'pinned', label: pinnedLabel, items: pinnedItems, total: countOf(pinnedItems) });
  }
  for (const ws of options.workspaces) {
    const bucket = buckets.get(ws.id);
    if (bucket !== undefined) ordered.push({ ...bucket, total: countOf(bucket.items) });
  }
  const orphan = buckets.get(WORKSPACE_UNGROUPED_KEY);
  if (orphan !== undefined) ordered.push({ ...orphan, total: countOf(orphan.items) });
  return ordered;
}
