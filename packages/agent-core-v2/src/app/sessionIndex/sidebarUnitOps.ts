import type {
  IQueryStore,
  SidebarCompoundPageResult,
  SidebarCompoundUnit,
  SidebarGroupMembersResult,
  SidebarQueryMemberFilter,
  SidebarResolveUnitsResult,
  WriteOp,
} from '#/persistence/interface/queryStore';

import type { SessionSummary } from './sessionIndex';
import {
  legacyLocalParentIdOf,
  parseSessionGroupGeneration,
  selectGroupOpener,
} from './sessionGroup';
import {
  SESSION_PIN_METADATA_KEY,
  buildSidebarUnitColumns,
  sessionCollection,
  sidebarUnitCollection,
  sidebarUnitKeyForSummary,
  stripRecencyField,
  typedGroupUnitId,
  typedSessionUnitId,
  type SidebarUnitIndexEntry,
} from './sessionIndexModel';

export function* yieldAllSidebarUnitWriteOps(
  generation: number,
  summaries: readonly SessionSummary[],
): Generator<WriteOp> {
  const unitCol = sidebarUnitCollection(generation);
  const grouped = new Map<string, SessionSummary[]>();
  for (const summary of summaries) {
    if (summary.groupId !== undefined) {
      let list = grouped.get(summary.groupId);
      if (list === undefined) {
        list = [];
        grouped.set(summary.groupId, list);
      }
      list.push(summary);
      continue;
    }
    const typedId = typedSessionUnitId(summary.id);
    const columns = buildSidebarUnitColumns(generation, [summary]);
    if (Object.keys(columns).length === 0) continue;
    const entry: SidebarUnitIndexEntry = { kind: 'session', id: summary.id, typedId };
    yield { kind: 'put', collection: unitCol, key: typedId, value: entry, columns };
  }
  for (const [groupId, members] of grouped) {
    const typedId = typedGroupUnitId(groupId);
    const columns = buildSidebarUnitColumns(generation, members);
    if (Object.keys(columns).length === 0) continue;
    const entry: SidebarUnitIndexEntry = { kind: 'group', id: groupId, typedId };
    yield { kind: 'put', collection: unitCol, key: typedId, value: entry, columns };
  }
}

export function inheritLegacyGroupId(
  next: SessionSummary,
  old: SessionSummary | undefined,
): SessionSummary {
  if (
    next.groupId === undefined &&
    next.groupDetached !== true &&
    parseSessionGroupGeneration(next.custom) === 0 &&
    old?.groupId !== undefined &&
    legacyLocalParentIdOf(next) === legacyLocalParentIdOf(old)
  ) {
    return { ...next, groupId: old.groupId };
  }
  return next;
}

export async function buildAffectedSidebarUnitOps(
  queryStore: IQueryStore,
  generation: number,
  changes: readonly {
    readonly id: string;
    readonly old: SessionSummary | undefined;
    readonly next: SessionSummary | undefined;
  }[],
): Promise<WriteOp[]> {
  if (changes.length === 0) return [];
  const sessCol = sessionCollection(generation);
  const unitCol = sidebarUnitCollection(generation);
  const changedById = new Map<string, SessionSummary | undefined>();
  const affectedGroupIds = new Set<string>();
  const affectedStandaloneIds = new Set<string>();

  for (const change of changes) {
    changedById.set(change.id, change.next);
    if (change.old?.groupId !== undefined) affectedGroupIds.add(change.old.groupId);
    else if (change.old !== undefined) affectedStandaloneIds.add(change.old.id);
    if (change.next?.groupId !== undefined) affectedGroupIds.add(change.next.groupId);
    else if (change.next !== undefined) affectedStandaloneIds.add(change.next.id);
    else affectedStandaloneIds.add(change.id);
  }

  const membersByGroup = new Map<string, Map<string, SessionSummary>>();
  if (affectedGroupIds.size > 0) {
    const groupList = [...affectedGroupIds];
    for (let offset = 0; offset < groupList.length; offset += 400) {
      const chunk = groupList.slice(offset, offset + 400);
      const page = await queryStore
        .query<SessionSummary>(sessCol)
        .where({ groupId: chunk.length === 1 ? chunk[0] : { $in: chunk } })
        .execute();
      for (const raw of page.items) {
        const summary = stripRecencyField(generation, raw);
        if (changedById.has(summary.id)) continue;
        if (summary.groupId === undefined) continue;
        let map = membersByGroup.get(summary.groupId);
        if (map === undefined) {
          map = new Map();
          membersByGroup.set(summary.groupId, map);
        }
        map.set(summary.id, summary);
      }
    }
    for (const next of changedById.values()) {
      if (next === undefined || next.groupId === undefined || !affectedGroupIds.has(next.groupId)) continue;
      let map = membersByGroup.get(next.groupId);
      if (map === undefined) {
        map = new Map();
        membersByGroup.set(next.groupId, map);
      }
      map.set(next.id, next);
    }
  }

  const ops: WriteOp[] = [];
  for (const groupId of affectedGroupIds) {
    const typedId = typedGroupUnitId(groupId);
    const members = [...(membersByGroup.get(groupId)?.values() ?? [])];
    if (members.length === 0) {
      ops.push({ kind: 'delete', collection: unitCol, key: typedId });
      continue;
    }
    const columns = buildSidebarUnitColumns(generation, members);
    if (Object.keys(columns).length === 0) {
      ops.push({ kind: 'delete', collection: unitCol, key: typedId });
      continue;
    }
    const entry: SidebarUnitIndexEntry = { kind: 'group', id: groupId, typedId };
    ops.push({ kind: 'put', collection: unitCol, key: typedId, value: entry, columns });
  }

  for (const sessionId of affectedStandaloneIds) {
    const typedId = typedSessionUnitId(sessionId);
    const next = changedById.get(sessionId);
    if (next === undefined || next.groupId !== undefined) {
      ops.push({ kind: 'delete', collection: unitCol, key: typedId });
      continue;
    }
    const columns = buildSidebarUnitColumns(generation, [next]);
    if (Object.keys(columns).length === 0) {
      ops.push({ kind: 'delete', collection: unitCol, key: typedId });
      continue;
    }
    const entry: SidebarUnitIndexEntry = { kind: 'session', id: sessionId, typedId };
    ops.push({ kind: 'put', collection: unitCol, key: typedId, value: entry, columns });
  }

  return ops;
}

function ownTimeOf(summary: SessionSummary): number {
  return summary.ownUpdatedAt ?? summary.updatedAt;
}

function personaIdOf(summary: SessionSummary): string | undefined {
  if (typeof summary.personaId === 'string' && summary.personaId.length > 0) return summary.personaId;
  const custom = summary.custom;
  if (custom === undefined) return undefined;
  for (const key of ['bot_persona_id', 'room_persona_id', 'persona_id'] as const) {
    const candidate = custom[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function summaryMatchesFilter(
  summary: SessionSummary,
  filter: SidebarQueryMemberFilter,
  workspaceSet: ReadonlySet<string> | undefined,
  busySet: ReadonlySet<string> | undefined,
  needle: string | undefined,
): boolean {
  if (filter.archived === 'hide' && summary.archived) return false;
  if (filter.archived === 'only' && !summary.archived) return false;
  const isPrivate = summary.private === true;
  if (filter.privacy === 'hide' && isPrivate) return false;
  if (filter.privacy === 'only' && !isPrivate) return false;
  if (workspaceSet !== undefined && !workspaceSet.has(summary.workspaceId)) return false;
  if (filter.excludeEmpty === true && (summary.lastPrompt ?? '').length === 0) return false;
  if (filter.persona !== undefined && personaIdOf(summary) !== filter.persona) return false;
  if (filter.busy !== undefined && (busySet?.has(summary.id) ?? false) !== filter.busy) return false;
  if (needle !== undefined) {
    const matched =
      (summary.title ?? '').toLocaleLowerCase().includes(needle) ||
      (summary.cwd ?? '').toLocaleLowerCase().includes(needle) ||
      summary.workspaceId.toLocaleLowerCase().includes(needle);
    if (!matched) return false;
  }
  return true;
}

function membersMatchPin(members: readonly SessionSummary[], pinned: boolean | undefined): boolean {
  if (pinned === undefined) return true;
  return members.some((member) => member.custom?.[SESSION_PIN_METADATA_KEY] === true) === pinned;
}

function compareMemberDesc(a: SessionSummary, b: SessionSummary): number {
  const diff = ownTimeOf(b) - ownTimeOf(a);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function deriveGroupTitle(opener: SessionSummary, members: readonly SessionSummary[]): string {
  if (typeof opener.title === 'string' && opener.title.trim().length > 0) return opener.title;
  const ordered = [...members].sort((a, b) => {
    const ac = a.createdAt > 0 ? a.createdAt : Number.MAX_SAFE_INTEGER;
    const bc = b.createdAt > 0 ? b.createdAt : Number.MAX_SAFE_INTEGER;
    return ac !== bc ? ac - bc : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const member of ordered) {
    if (typeof member.title === 'string' && member.title.trim().length > 0) return member.title;
  }
  return opener.title ?? '';
}

function buildAuthoritativeUnit(
  typedUnitId: string,
  members: readonly SessionSummary[],
  sort: 'updated_desc' | 'created_desc' | 'title',
  memberLimit: number,
): SidebarCompoundUnit<SessionSummary> {
  const ordered = [...members].sort(compareMemberDesc);
  const maxOwn = ordered.reduce((acc, member) => Math.max(acc, ownTimeOf(member)), 0);
  const maxCreated = ordered.reduce((acc, member) => Math.max(acc, member.createdAt), 0);
  if (typedUnitId.startsWith('g:')) {
    const opener = selectGroupOpener(ordered);
    const title = deriveGroupTitle(opener, ordered);
    return {
      kind: 'group',
      id: typedUnitId.slice(2),
      typedUnitId,
      sortAt: sort === 'created_desc' ? maxCreated : maxOwn,
      sortText: sort === 'title' ? title.trim().toLocaleLowerCase() : undefined,
      openerId: opener.id,
      title,
      primaryWorkspaceId: opener.workspaceId,
      hasPinned: ordered.some((member) => member.custom?.[SESSION_PIN_METADATA_KEY] === true),
      memberCount: ordered.length,
      members: ordered.slice(0, memberLimit),
      hasMoreMembers: ordered.length > memberLimit,
    };
  }
  const sole = ordered[0]!;
  const title = sole.title ?? '';
  return {
    kind: 'session',
    id: sole.id,
    typedUnitId,
    sortAt: sort === 'created_desc' ? sole.createdAt : ownTimeOf(sole),
    sortText: sort === 'title' ? title.trim().toLocaleLowerCase() : undefined,
    openerId: sole.id,
    title,
    primaryWorkspaceId: sole.workspaceId,
    hasPinned: sole.custom?.[SESSION_PIN_METADATA_KEY] === true,
    memberCount: 1,
    members: [sole],
    hasMoreMembers: false,
  };
}

function compareAuthoritativeUnits(
  a: SidebarCompoundUnit<SessionSummary>,
  b: SidebarCompoundUnit<SessionSummary>,
  sort: 'updated_desc' | 'created_desc' | 'title',
): number {
  if (sort === 'title') {
    const at = a.sortText ?? '';
    const bt = b.sortText ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
  }
  if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
  return a.typedUnitId < b.typedUnitId ? 1 : a.typedUnitId > b.typedUnitId ? -1 : 0;
}

export function buildSidebarPageFromSummaries(
  summaries: readonly SessionSummary[],
  options: {
    readonly filter: SidebarQueryMemberFilter;
    readonly sort: 'updated_desc' | 'created_desc' | 'title';
    readonly limit: number;
    readonly memberLimit: number;
    readonly maxRows: number;
    readonly cursor?: { readonly sortAt: number; readonly sortText?: string; readonly typedUnitId: string };
  },
): SidebarCompoundPageResult<SessionSummary> {
  const workspaceSet = options.filter.workspaceIds === undefined ? undefined : new Set(options.filter.workspaceIds);
  const busySet = options.filter.busyIds === undefined ? undefined : new Set(options.filter.busyIds);
  const needle = options.filter.query?.trim().toLocaleLowerCase() || undefined;
  const byUnit = new Map<string, SessionSummary[]>();
  for (const summary of summaries) {
    if (!summaryMatchesFilter(summary, options.filter, workspaceSet, busySet, needle)) continue;
    const uid = sidebarUnitKeyForSummary(summary);
    let bucket = byUnit.get(uid);
    if (bucket === undefined) {
      bucket = [];
      byUnit.set(uid, bucket);
    }
    bucket.push(summary);
  }
  const allUnits: SidebarCompoundUnit<SessionSummary>[] = [];
  for (const [uid, members] of byUnit) {
    if (!membersMatchPin(members, options.filter.pinned)) continue;
    const unit = buildAuthoritativeUnit(uid, members, options.sort, options.memberLimit);
    if (options.cursor !== undefined) {
      const c = options.cursor;
      const after =
        options.sort === 'title' && (unit.sortText ?? '') !== (c.sortText ?? '')
          ? (unit.sortText ?? '') > (c.sortText ?? '')
          : unit.sortAt !== c.sortAt
            ? unit.sortAt < c.sortAt
            : unit.typedUnitId < c.typedUnitId;
      if (!after) continue;
    }
    allUnits.push(unit);
  }
  allUnits.sort((a, b) => compareAuthoritativeUnits(a, b, options.sort));
  const emitted: SidebarCompoundUnit<SessionSummary>[] = [];
  let rowCount = 0;
  let hasMore = false;
  for (const unit of allUnits) {
    if (emitted.length >= options.limit) {
      hasMore = true;
      break;
    }
    if (emitted.length > 0 && rowCount + unit.members.length > options.maxRows) {
      hasMore = true;
      break;
    }
    emitted.push(unit);
    rowCount += unit.members.length;
  }
  return {
    units: emitted,
    hasMore,
    stats: { unitsVisited: byUnit.size, rowsVisited: summaries.length },
  };
}

export function buildSidebarGroupMembersFromSummaries(
  summaries: readonly SessionSummary[],
  options: {
    readonly groupId: string;
    readonly filter: SidebarQueryMemberFilter;
    readonly limit: number;
    readonly cursor?: { readonly ownUpdatedAt: number; readonly id: string };
  },
): SidebarGroupMembersResult<SessionSummary> {
  const workspaceSet = options.filter.workspaceIds === undefined ? undefined : new Set(options.filter.workspaceIds);
  const busySet = options.filter.busyIds === undefined ? undefined : new Set(options.filter.busyIds);
  const needle = options.filter.query?.trim().toLocaleLowerCase() || undefined;
  const eligible = summaries
    .filter(
      (summary) =>
        summary.groupId === options.groupId &&
        summaryMatchesFilter(summary, options.filter, workspaceSet, busySet, needle),
    )
    .sort(compareMemberDesc);
  if (!membersMatchPin(eligible, options.filter.pinned)) {
    return { memberCount: 0, members: [], hasMore: false };
  }
  const afterCursor =
    options.cursor === undefined
      ? eligible
      : eligible.filter((summary) => {
          const own = ownTimeOf(summary);
          return (
            own < options.cursor!.ownUpdatedAt ||
            (own === options.cursor!.ownUpdatedAt && summary.id < options.cursor!.id)
          );
        });
  return {
    memberCount: eligible.length,
    members: afterCursor.slice(0, options.limit),
    hasMore: afterCursor.length > options.limit,
  };
}

export function resolveSidebarUnitsFromSummaries(
  summaries: readonly SessionSummary[],
  options: {
    readonly sessionIds: readonly string[];
    readonly groupIds: readonly string[];
    readonly filter: SidebarQueryMemberFilter;
    readonly memberLimit: number;
  },
): SidebarResolveUnitsResult<SessionSummary> {
  const workspaceSet = options.filter.workspaceIds === undefined ? undefined : new Set(options.filter.workspaceIds);
  const busySet = options.filter.busyIds === undefined ? undefined : new Set(options.filter.busyIds);
  const needle = options.filter.query?.trim().toLocaleLowerCase() || undefined;
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const targetGroups = new Set(options.groupIds);
  for (const sessionId of options.sessionIds) {
    const found = byId.get(sessionId);
    if (found?.groupId !== undefined) targetGroups.add(found.groupId);
  }
  const membersByGroup = new Map<string, SessionSummary[]>();
  for (const summary of summaries) {
    if (summary.groupId === undefined || !targetGroups.has(summary.groupId)) continue;
    let list = membersByGroup.get(summary.groupId);
    if (list === undefined) {
      list = [];
      membersByGroup.set(summary.groupId, list);
    }
    list.push(summary);
  }
  const units: SidebarCompoundUnit<SessionSummary>[] = [];
  const eligibleSessions = new Set<string>();
  const eligibleGroups = new Set<string>();
  for (const groupId of targetGroups) {
    const eligible = (membersByGroup.get(groupId) ?? []).filter((summary) =>
      summaryMatchesFilter(summary, options.filter, workspaceSet, busySet, needle),
    );
    if (eligible.length === 0 || !membersMatchPin(eligible, options.filter.pinned)) continue;
    eligibleGroups.add(groupId);
    for (const member of eligible) eligibleSessions.add(member.id);
    units.push(buildAuthoritativeUnit(typedGroupUnitId(groupId), eligible, 'updated_desc', options.memberLimit));
  }
  for (const sessionId of options.sessionIds) {
    const found = byId.get(sessionId);
    if (found === undefined || found.groupId !== undefined) continue;
    if (!summaryMatchesFilter(found, options.filter, workspaceSet, busySet, needle)) continue;
    if (!membersMatchPin([found], options.filter.pinned)) continue;
    eligibleSessions.add(sessionId);
    units.push(buildAuthoritativeUnit(typedSessionUnitId(sessionId), [found], 'updated_desc', options.memberLimit));
  }
  units.sort((a, b) => compareAuthoritativeUnits(a, b, 'updated_desc'));
  return {
    units,
    missingSessionIds: options.sessionIds.filter((id) => !eligibleSessions.has(id)),
    missingGroupIds: options.groupIds.filter((id) => !eligibleGroups.has(id)),
  };
}
