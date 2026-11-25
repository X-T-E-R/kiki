import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  IndexDef,
  SidebarCompoundPageQuery,
  SidebarCompoundPageResult,
  SidebarCompoundUnit,
  SidebarGroupMembersQuery,
  SidebarGroupMembersResult,
  SidebarQueryMemberFilter,
  SidebarResolveUnitsQuery,
  SidebarResolveUnitsResult,
} from '../../interface/queryStore.ts';
// oxlint-disable-next-line import/extensions
import { scalarKey } from './querySemantics.ts';

interface StoredSessionDoc {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly personaId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ownUpdatedAt?: number;
  readonly archived: boolean;
  readonly private?: boolean;
  readonly groupId?: string;
  readonly groupDetached?: boolean;
  readonly custom?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

const PIN_KEY = 'kiki.pinned';
const IN_CHUNK_SIZE = 400;

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stripField(doc: StoredSessionDoc, field: string): StoredSessionDoc {
  if (!(field in doc)) return doc;
  const copy: Record<string, unknown> = { ...doc };
  delete copy[field];
  return copy as unknown as StoredSessionDoc;
}

function ownTimeOf(doc: StoredSessionDoc): number {
  return typeof doc.ownUpdatedAt === 'number' && Number.isFinite(doc.ownUpdatedAt)
    ? doc.ownUpdatedAt
    : doc.updatedAt;
}

function typedUnitIdOf(doc: StoredSessionDoc): string {
  return typeof doc.groupId === 'string' && doc.groupId.length > 0 ? `g:${doc.groupId}` : `s:${doc.id}`;
}

function localBareParent(value: unknown, selfId: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value === selfId || value.includes(':')) return undefined;
  return value;
}

function legacyParentOf(doc: StoredSessionDoc): string | undefined {
  const custom = doc.custom;
  if (custom === undefined) return undefined;
  const createdBy = localBareParent(custom['created_by_session_id'], doc.id);
  if (createdBy !== undefined) return createdBy;
  if (custom['child_session_kind'] === 'child') {
    const parent = localBareParent(custom['parent_session_id'], doc.id);
    if (parent !== undefined) return parent;
  }
  const promoted = custom['promoted_from'];
  if (promoted !== null && typeof promoted === 'object' && !Array.isArray(promoted)) {
    const promotedParent = localBareParent((promoted as Record<string, unknown>)['sessionId'], doc.id);
    if (promotedParent !== undefined) return promotedParent;
  }
  const forked = custom['forked_from'];
  if (forked !== null && typeof forked === 'object' && !Array.isArray(forked)) {
    const forkedParent = localBareParent((forked as Record<string, unknown>)['sessionId'], doc.id);
    if (forkedParent !== undefined) return forkedParent;
  }
  return undefined;
}

function compareDeterministicMember(a: StoredSessionDoc, b: StoredSessionDoc): number {
  const aCreated = a.createdAt > 0 ? a.createdAt : Number.MAX_SAFE_INTEGER;
  const bCreated = b.createdAt > 0 ? b.createdAt : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareMemberRecencyDesc(a: StoredSessionDoc, b: StoredSessionDoc): number {
  const diff = ownTimeOf(b) - ownTimeOf(a);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function selectOpener(members: readonly StoredSessionDoc[]): StoredSessionDoc {
  const ids = new Set(members.map((member) => member.id));
  const roots = members.filter((member) => {
    const parent = legacyParentOf(member);
    return parent === undefined || !ids.has(parent);
  });
  const pool = roots.length > 0 ? roots : members;
  let best = pool[0]!;
  for (let index = 1; index < pool.length; index += 1) {
    if (compareDeterministicMember(pool[index]!, best) < 0) best = pool[index]!;
  }
  return best;
}

function deriveGroupTitle(opener: StoredSessionDoc, members: readonly StoredSessionDoc[]): string {
  if (typeof opener.title === 'string' && opener.title.trim().length > 0) return opener.title;
  const ordered = [...members].sort(compareDeterministicMember);
  for (const member of ordered) {
    if (typeof member.title === 'string' && member.title.trim().length > 0) return member.title;
  }
  return opener.title ?? '';
}

function personaIdOf(doc: StoredSessionDoc): string | undefined {
  if (typeof doc.personaId === 'string' && doc.personaId.length > 0) return doc.personaId;
  const custom = doc.custom;
  if (custom === undefined) return undefined;
  for (const key of ['bot_persona_id', 'room_persona_id', 'persona_id'] as const) {
    const candidate = custom[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function memberMatchesFilter(
  doc: StoredSessionDoc,
  filter: SidebarQueryMemberFilter,
  workspaceSet: ReadonlySet<string> | undefined,
  busySet: ReadonlySet<string> | undefined,
  needle: string | undefined,
): boolean {
  if (filter.archived === 'hide' && doc.archived) return false;
  if (filter.archived === 'only' && !doc.archived) return false;
  const isPrivate = doc.private === true;
  if (filter.privacy === 'hide' && isPrivate) return false;
  if (filter.privacy === 'only' && !isPrivate) return false;
  if (workspaceSet !== undefined && !workspaceSet.has(doc.workspaceId)) return false;
  if (filter.excludeEmpty === true && (doc.lastPrompt ?? '').length === 0) return false;
  if (filter.persona !== undefined && personaIdOf(doc) !== filter.persona) return false;
  if (filter.busy !== undefined && (busySet?.has(doc.id) ?? false) !== filter.busy) return false;
  if (needle !== undefined) {
    const matched =
      (doc.title ?? '').toLocaleLowerCase().includes(needle) ||
      (doc.cwd ?? '').toLocaleLowerCase().includes(needle) ||
      doc.workspaceId.toLocaleLowerCase().includes(needle);
    if (!matched) return false;
  }
  return true;
}

function unitMatchesPinFilter(
  members: readonly StoredSessionDoc[],
  pinned: boolean | undefined,
): boolean {
  if (pinned === undefined) return true;
  const anyPinned = members.some((member) => member.custom?.[PIN_KEY] === true);
  return anyPinned === pinned;
}

function readCheckpointRevision(
  getStmt: ReturnType<DatabaseSync['prepare']>,
  checkpointKey: string | undefined,
): number | undefined {
  if (checkpointKey === undefined) return undefined;
  const row = getStmt.get('__checkpoint__', Buffer.from(checkpointKey));
  if (row === undefined) return 0;
  try {
    const parsed = JSON.parse(String(row['json'])) as { seq?: unknown };
    return typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : 0;
  } catch {
    return 0;
  }
}

function buildUnit(
  typedUnitId: string,
  eligibleMembers: readonly StoredSessionDoc[],
  sort: 'updated_desc' | 'created_desc' | 'title',
  memberLimit: number,
  recencyField: string,
): SidebarCompoundUnit<StoredSessionDoc> {
  const ordered = [...eligibleMembers].sort(compareMemberRecencyDesc);
  const maxOwn = ordered.reduce((acc, member) => Math.max(acc, ownTimeOf(member)), 0);
  const maxCreated = ordered.reduce((acc, member) => Math.max(acc, member.createdAt), 0);
  const hasPinned = ordered.some((member) => member.custom?.[PIN_KEY] === true);
  if (typedUnitId.startsWith('g:')) {
    const groupId = typedUnitId.slice(2);
    const opener = selectOpener(ordered);
    const title = deriveGroupTitle(opener, ordered);
    const sliced = ordered.slice(0, memberLimit).map((member) => stripField(member, recencyField));
    return {
      kind: 'group',
      id: groupId,
      typedUnitId,
      sortAt: sort === 'created_desc' ? maxCreated : maxOwn,
      sortText: sort === 'title' ? title.trim().toLocaleLowerCase() : undefined,
      openerId: opener.id,
      title,
      primaryWorkspaceId: opener.workspaceId,
      hasPinned,
      memberCount: ordered.length,
      members: sliced,
      hasMoreMembers: ordered.length > memberLimit,
    };
  }
  const sole = stripField(ordered[0]!, recencyField);
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
    hasPinned,
    memberCount: 1,
    members: [sole],
    hasMoreMembers: false,
  };
}

function compareUnits(
  a: SidebarCompoundUnit<StoredSessionDoc>,
  b: SidebarCompoundUnit<StoredSessionDoc>,
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

function unitStrictlyAfterCursor(
  unit: SidebarCompoundUnit<StoredSessionDoc>,
  cursor: NonNullable<SidebarCompoundPageQuery['cursor']>,
  sort: 'updated_desc' | 'created_desc' | 'title',
): boolean {
  if (sort === 'title') {
    const unitText = unit.sortText ?? '';
    const cursorText = cursor.sortText ?? '';
    if (unitText !== cursorText) return unitText > cursorText;
  }
  if (unit.sortAt !== cursor.sortAt) return unit.sortAt < cursor.sortAt;
  return unit.typedUnitId < cursor.typedUnitId;
}

function findValueIndexName(
  connection: DatabaseSync,
  collection: string,
  field: string,
): string | undefined {
  const rows = connection
    .prepare('SELECT id,json FROM definitions WHERE collection=? ORDER BY id ASC')
    .all(collection);
  for (const row of rows) {
    const id = Number(row['id']);
    if (!Number.isSafeInteger(id)) continue;
    const def = JSON.parse(String(row['json'])) as IndexDef;
    if (def.kind === 'value' && def.field === field) return `query_value_${id}`;
  }
  return undefined;
}

function explainLines(connection: DatabaseSync, sql: string, params: readonly SQLInputValue[]): string[] {
  const rows = connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.map((row) => String(row['detail'] ?? ''));
}

function fetchByKeys(
  getStmt: ReturnType<DatabaseSync['prepare']>,
  collection: string,
  keys: readonly string[],
  check: () => void,
): { readonly docs: Map<string, StoredSessionDoc>; readonly visited: number } {
  const docs = new Map<string, StoredSessionDoc>();
  let visited = 0;
  for (const key of keys) {
    check();
    const row = getStmt.get(collection, Buffer.from(key));
    visited += 1;
    if (row !== undefined) docs.set(key, JSON.parse(String(row['json'])) as StoredSessionDoc);
  }
  return { docs, visited };
}

function fetchByIndexedValues(
  connection: DatabaseSync,
  collection: string,
  field: string,
  indexName: string | undefined,
  values: readonly string[],
  check: () => void,
  explainOut?: string[],
): { readonly docs: StoredSessionDoc[]; readonly visited: number } {
  if (values.length === 0) return { docs: [], visited: 0 };
  const docs: StoredSessionDoc[] = [];
  let visited = 0;
  const unique = [...new Set(values)];
  const from = indexName === undefined ? 'rows r' : `rows r INDEXED BY ${indexName}`;
  for (let offset = 0; offset < unique.length; offset += IN_CHUNK_SIZE) {
    check();
    const chunk = unique.slice(offset, offset + IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const sql = `SELECT r.json FROM ${from} WHERE r.collection=${quote(collection)} AND kiki_value(r.json,${quote(field)}) IN (${placeholders})`;
    const params = chunk.map((value) => scalarKey(value));
    if (explainOut !== undefined && offset === 0) {
      explainOut.push(...explainLines(connection, sql, params));
    }
    const rows = connection.prepare(sql).all(...params);
    for (const row of rows) {
      check();
      visited += 1;
      docs.push(JSON.parse(String(row['json'])) as StoredSessionDoc);
    }
  }
  return { docs, visited };
}

function resolvePendingOverlay(
  getStmt: ReturnType<DatabaseSync['prepare']>,
  sessionCollection: string,
  pendingRaw: readonly unknown[] | undefined,
  check: () => void,
): {
  readonly byId: Map<string, StoredSessionDoc>;
  readonly affectedUnitIds: Set<string>;
  readonly affectedGroupIds: Set<string>;
  readonly visited: number;
} {
  const byId = new Map<string, StoredSessionDoc>();
  const affectedUnitIds = new Set<string>();
  const affectedGroupIds = new Set<string>();
  if (pendingRaw === undefined || pendingRaw.length === 0) {
    return { byId, affectedUnitIds, affectedGroupIds, visited: 0 };
  }
  const incoming = pendingRaw as readonly StoredSessionDoc[];
  const stored = fetchByKeys(getStmt, sessionCollection, incoming.map((doc) => doc.id), check);
  for (const doc of incoming) {
    const old = stored.docs.get(doc.id);
    const effective: StoredSessionDoc = doc;
    byId.set(effective.id, effective);
    const nextUnitId = typedUnitIdOf(effective);
    affectedUnitIds.add(nextUnitId);
    if (effective.groupId !== undefined) affectedGroupIds.add(effective.groupId);
    if (old !== undefined) {
      const oldUnitId = typedUnitIdOf(old);
      affectedUnitIds.add(oldUnitId);
      if (old.groupId !== undefined) affectedGroupIds.add(old.groupId);
    }
  }
  return { byId, affectedUnitIds, affectedGroupIds, visited: stored.visited };
}

function canUseIndexedUnitWalk(query: SidebarCompoundPageQuery): boolean {
  return (
    query.sort === 'updated_desc' &&
    query.filter.workspaceIds === undefined &&
    query.filter.excludeEmpty !== true &&
    query.filter.persona === undefined &&
    query.filter.busy === undefined &&
    (query.filter.query === undefined || query.filter.query.trim().length === 0) &&
    query.filter.pinned !== false
  );
}

export async function executeSidebarPage(
  connection: DatabaseSync,
  getStmt: ReturnType<DatabaseSync['prepare']>,
  query: SidebarCompoundPageQuery,
  check: () => void,
): Promise<SidebarCompoundPageResult<StoredSessionDoc>> {
  const workspaceSet = query.filter.workspaceIds === undefined ? undefined : new Set(query.filter.workspaceIds);
  const busySet = query.filter.busyIds === undefined ? undefined : new Set(query.filter.busyIds);
  const needle = query.filter.query?.trim().toLocaleLowerCase() || undefined;
  const groupIndex = findValueIndexName(connection, query.sessionCollection, 'groupId');
  const workspaceIndex = findValueIndexName(connection, query.sessionCollection, 'workspaceId');
  const pending = resolvePendingOverlay(getStmt, query.sessionCollection, query.pending, check);
  const explainPlan: string[] | undefined = query.explain === true ? [] : undefined;
  let unitsVisited = 0;
  let rowsVisited = pending.visited;

  if (canUseIndexedUnitWalk(query)) {
    const pendingUnits: SidebarCompoundUnit<StoredSessionDoc>[] = [];
    if (pending.affectedUnitIds.size > 0) {
      const groupedMembers = new Map<string, Map<string, StoredSessionDoc>>();
      if (pending.affectedGroupIds.size > 0) {
        const fetched = fetchByIndexedValues(
          connection,
          query.sessionCollection,
          'groupId',
          groupIndex,
          [...pending.affectedGroupIds],
          check,
        );
        rowsVisited += fetched.visited;
        for (const doc of fetched.docs) {
          const overlay = pending.byId.get(doc.id);
          const effective = overlay ?? doc;
          const uid = typedUnitIdOf(effective);
          let bucket = groupedMembers.get(uid);
          if (bucket === undefined) {
            bucket = new Map();
            groupedMembers.set(uid, bucket);
          }
          bucket.set(effective.id, effective);
        }
      }
      for (const doc of pending.byId.values()) {
        const uid = typedUnitIdOf(doc);
        let bucket = groupedMembers.get(uid);
        if (bucket === undefined) {
          bucket = new Map();
          groupedMembers.set(uid, bucket);
        }
        bucket.set(doc.id, doc);
      }
      for (const [uid, map] of groupedMembers) {
        const eligible = [...map.values()].filter((member) =>
          memberMatchesFilter(member, query.filter, workspaceSet, busySet, needle),
        );
        if (eligible.length === 0 || !unitMatchesPinFilter(eligible, query.filter.pinned)) continue;
        const unit = buildUnit(uid, eligible, query.sort, query.memberLimit, query.recencyField);
        if (query.cursor === undefined || unitStrictlyAfterCursor(unit, query.cursor, query.sort)) {
          pendingUnits.push(unit);
        }
      }
    }

    const revision = readCheckpointRevision(getStmt, query.revisionCheckpointKey);
    const clauses = ['c.collection=?', 'c.name=?'];
    const params: SQLInputValue[] = [query.unitCollection, query.unitColumn];
    if (query.cursor !== undefined) {
      clauses.push('(c.value, c.key) < (?, ?)');
      params.push(query.cursor.sortAt, Buffer.from(query.cursor.typedUnitId));
    }
    const unitSql = `SELECT c.key,c.value FROM columns c WHERE ${clauses.join(' AND ')} ORDER BY c.value DESC,c.key DESC`;
    if (explainPlan !== undefined) {
      explainPlan.push(...explainLines(connection, unitSql, params));
    }

    const indexedCandidates: Array<{ readonly typedUnitId: string; readonly sortAt: number }> = [];
    const targetCandidates = query.limit + 1;
    const iterator = connection.prepare(unitSql).iterate(...params);
    try {
      for (const row of iterator) {
        check();
        const typedUnitId = Buffer.from(row['key'] as Uint8Array).toString('utf8');
        unitsVisited += 1;
        if (pending.affectedUnitIds.has(typedUnitId)) continue;
        indexedCandidates.push({ typedUnitId, sortAt: Number(row['value']) });
        if (indexedCandidates.length >= targetCandidates) break;
        if (unitsVisited % 256 === 0) await yieldToEventLoop();
      }
    } finally {
      iterator.return?.();
    }

    const standaloneIds: string[] = [];
    const groupIds: string[] = [];
    for (const candidate of indexedCandidates) {
      if (candidate.typedUnitId.startsWith('g:')) groupIds.push(candidate.typedUnitId.slice(2));
      else if (candidate.typedUnitId.startsWith('s:')) standaloneIds.push(candidate.typedUnitId.slice(2));
    }

    const standaloneDocs = fetchByKeys(getStmt, query.sessionCollection, standaloneIds, check);
    rowsVisited += standaloneDocs.visited;
    const groupDocs = fetchByIndexedValues(
      connection,
      query.sessionCollection,
      'groupId',
      groupIndex,
      groupIds,
      check,
      explainPlan,
    );
    rowsVisited += groupDocs.visited;

    const byGroup = new Map<string, StoredSessionDoc[]>();
    for (const doc of groupDocs.docs) {
      if (pending.byId.has(doc.id)) continue;
      const gid = doc.groupId;
      if (gid === undefined) continue;
      let bucket = byGroup.get(gid);
      if (bucket === undefined) {
        bucket = [];
        byGroup.set(gid, bucket);
      }
      bucket.push(doc);
    }

    const combined: SidebarCompoundUnit<StoredSessionDoc>[] = [...pendingUnits];
    for (const candidate of indexedCandidates) {
      if (candidate.typedUnitId.startsWith('g:')) {
        const gid = candidate.typedUnitId.slice(2);
        const members = (byGroup.get(gid) ?? []).filter((member) =>
          memberMatchesFilter(member, query.filter, workspaceSet, busySet, needle),
        );
        if (members.length === 0 || !unitMatchesPinFilter(members, query.filter.pinned)) continue;
        combined.push(buildUnit(candidate.typedUnitId, members, query.sort, query.memberLimit, query.recencyField));
      } else {
        const sid = candidate.typedUnitId.slice(2);
        const doc = standaloneDocs.docs.get(sid);
        if (doc === undefined || pending.byId.has(sid)) continue;
        if (!memberMatchesFilter(doc, query.filter, workspaceSet, busySet, needle)) continue;
        if (!unitMatchesPinFilter([doc], query.filter.pinned)) continue;
        combined.push(buildUnit(candidate.typedUnitId, [doc], query.sort, query.memberLimit, query.recencyField));
      }
    }

    combined.sort((a, b) => compareUnits(a, b, query.sort));
    return {
      ...applyPageBudgets(combined, query.limit, query.maxRows, {
        unitsVisited,
        rowsVisited,
        indexPlan: explainPlan,
      }),
      revision,
    };
  }

  const revision = readCheckpointRevision(getStmt, query.revisionCheckpointKey);
  const membersByUnit = new Map<string, Map<string, StoredSessionDoc>>();
  const addMember = (doc: StoredSessionDoc): void => {
    if (!memberMatchesFilter(doc, query.filter, workspaceSet, busySet, needle)) return;
    const uid = typedUnitIdOf(doc);
    let bucket = membersByUnit.get(uid);
    if (bucket === undefined) {
      bucket = new Map();
      membersByUnit.set(uid, bucket);
    }
    bucket.set(doc.id, doc);
  };

  if (query.filter.workspaceIds !== undefined && query.filter.workspaceIds.length > 0) {
    const fetched = fetchByIndexedValues(
      connection,
      query.sessionCollection,
      'workspaceId',
      workspaceIndex,
      query.filter.workspaceIds,
      check,
      explainPlan,
    );
    rowsVisited += fetched.visited;
    for (const doc of fetched.docs) {
      if (pending.byId.has(doc.id)) continue;
      addMember(doc);
    }
  } else {
    const scanSql = `SELECT r.json FROM rows r WHERE r.collection=${quote(query.sessionCollection)}`;
    if (explainPlan !== undefined) explainPlan.push(...explainLines(connection, scanSql, []));
    const iterator = connection.prepare(scanSql).iterate();
    try {
      for (const row of iterator) {
        check();
        rowsVisited += 1;
        const doc = JSON.parse(String(row['json'])) as StoredSessionDoc;
        if (!pending.byId.has(doc.id)) addMember(doc);
        if (rowsVisited % 256 === 0) await yieldToEventLoop();
      }
    } finally {
      iterator.return?.();
    }
  }

  for (const doc of pending.byId.values()) addMember(doc);

  const units: SidebarCompoundUnit<StoredSessionDoc>[] = [];
  for (const [uid, map] of membersByUnit) {
    unitsVisited += 1;
    const members = [...map.values()];
    if (members.length === 0 || !unitMatchesPinFilter(members, query.filter.pinned)) continue;
    const unit = buildUnit(uid, members, query.sort, query.memberLimit, query.recencyField);
    if (query.cursor === undefined || unitStrictlyAfterCursor(unit, query.cursor, query.sort)) {
      units.push(unit);
    }
  }
  units.sort((a, b) => compareUnits(a, b, query.sort));
  return {
    ...applyPageBudgets(units, query.limit, query.maxRows, {
      unitsVisited,
      rowsVisited,
      indexPlan: explainPlan,
    }),
    revision,
  };
}

function applyPageBudgets(
  candidates: readonly SidebarCompoundUnit<StoredSessionDoc>[],
  limit: number,
  maxRows: number,
  stats: SidebarCompoundPageResult<StoredSessionDoc>['stats'],
): SidebarCompoundPageResult<StoredSessionDoc> {
  const emitted: SidebarCompoundUnit<StoredSessionDoc>[] = [];
  let rowCount = 0;
  let hasMore = false;
  for (const unit of candidates) {
    if (emitted.length >= limit) {
      hasMore = true;
      break;
    }
    const nextRows = unit.members.length;
    if (emitted.length > 0 && rowCount + nextRows > maxRows) {
      hasMore = true;
      break;
    }
    emitted.push(unit);
    rowCount += nextRows;
  }
  return { units: emitted, hasMore, stats };
}

export async function executeSidebarGroupMembers(
  connection: DatabaseSync,
  getStmt: ReturnType<DatabaseSync['prepare']>,
  query: SidebarGroupMembersQuery,
  check: () => void,
): Promise<SidebarGroupMembersResult<StoredSessionDoc>> {
  const revision = readCheckpointRevision(getStmt, query.revisionCheckpointKey);
  const workspaceSet = query.filter.workspaceIds === undefined ? undefined : new Set(query.filter.workspaceIds);
  const busySet = query.filter.busyIds === undefined ? undefined : new Set(query.filter.busyIds);
  const needle = query.filter.query?.trim().toLocaleLowerCase() || undefined;
  const groupIndex = findValueIndexName(connection, query.sessionCollection, 'groupId');
  const pending = resolvePendingOverlay(getStmt, query.sessionCollection, query.pending, check);
  const fetched = fetchByIndexedValues(
    connection,
    query.sessionCollection,
    'groupId',
    groupIndex,
    [query.groupId],
    check,
  );
  const byId = new Map<string, StoredSessionDoc>();
  for (const doc of fetched.docs) {
    if (!pending.byId.has(doc.id)) byId.set(doc.id, doc);
  }
  for (const doc of pending.byId.values()) {
    if (doc.groupId === query.groupId) byId.set(doc.id, doc);
  }
  const eligible = [...byId.values()]
    .filter((doc) => memberMatchesFilter(doc, query.filter, workspaceSet, busySet, needle))
    .sort(compareMemberRecencyDesc);
  if (!unitMatchesPinFilter(eligible, query.filter.pinned)) {
    return { memberCount: 0, members: [], hasMore: false, revision };
  }
  const afterCursor =
    query.cursor === undefined
      ? eligible
      : eligible.filter((doc) => {
          const own = ownTimeOf(doc);
          return own < query.cursor!.ownUpdatedAt || (own === query.cursor!.ownUpdatedAt && doc.id < query.cursor!.id);
        });
  const page = afterCursor.slice(0, query.limit).map((doc) => stripField(doc, query.recencyField));
  return {
    memberCount: eligible.length,
    members: page,
    hasMore: afterCursor.length > query.limit,
    revision,
  };
}

export async function executeSidebarResolveUnits(
  connection: DatabaseSync,
  getStmt: ReturnType<DatabaseSync['prepare']>,
  query: SidebarResolveUnitsQuery,
  check: () => void,
): Promise<SidebarResolveUnitsResult<StoredSessionDoc>> {
  const revision = readCheckpointRevision(getStmt, query.revisionCheckpointKey);
  const workspaceSet = query.filter.workspaceIds === undefined ? undefined : new Set(query.filter.workspaceIds);
  const busySet = query.filter.busyIds === undefined ? undefined : new Set(query.filter.busyIds);
  const needle = query.filter.query?.trim().toLocaleLowerCase() || undefined;
  const groupIndex = findValueIndexName(connection, query.sessionCollection, 'groupId');
  const pending = resolvePendingOverlay(getStmt, query.sessionCollection, query.pending, check);

  const requestedSessions = fetchByKeys(getStmt, query.sessionCollection, query.sessionIds, check);
  const resolvedSessionDocs = new Map<string, StoredSessionDoc>();
  const targetGroupIds = new Set<string>(query.groupIds);
  for (const sessionId of query.sessionIds) {
    const doc = pending.byId.get(sessionId) ?? requestedSessions.docs.get(sessionId);
    if (doc === undefined) continue;
    resolvedSessionDocs.set(sessionId, doc);
    if (doc.groupId !== undefined) targetGroupIds.add(doc.groupId);
  }

  const groupMembers = new Map<string, Map<string, StoredSessionDoc>>();
  if (targetGroupIds.size > 0) {
    const fetched = fetchByIndexedValues(
      connection,
      query.sessionCollection,
      'groupId',
      groupIndex,
      [...targetGroupIds],
      check,
    );
    for (const doc of fetched.docs) {
      if (pending.byId.has(doc.id)) continue;
      if (doc.groupId === undefined) continue;
      let bucket = groupMembers.get(doc.groupId);
      if (bucket === undefined) {
        bucket = new Map();
        groupMembers.set(doc.groupId, bucket);
      }
      bucket.set(doc.id, doc);
    }
    for (const doc of pending.byId.values()) {
      if (doc.groupId === undefined || !targetGroupIds.has(doc.groupId)) continue;
      let bucket = groupMembers.get(doc.groupId);
      if (bucket === undefined) {
        bucket = new Map();
        groupMembers.set(doc.groupId, bucket);
      }
      bucket.set(doc.id, doc);
    }
  }

  const unitsByTypedId = new Map<string, SidebarCompoundUnit<StoredSessionDoc>>();
  const eligibleSessionIds = new Set<string>();
  const eligibleGroupIds = new Set<string>();

  for (const gid of targetGroupIds) {
    const map = groupMembers.get(gid);
    if (map === undefined) continue;
    const eligible = [...map.values()].filter((doc) =>
      memberMatchesFilter(doc, query.filter, workspaceSet, busySet, needle),
    );
    if (eligible.length === 0 || !unitMatchesPinFilter(eligible, query.filter.pinned)) continue;
    eligibleGroupIds.add(gid);
    for (const member of eligible) eligibleSessionIds.add(member.id);
    const typedId = `g:${gid}`;
    unitsByTypedId.set(typedId, buildUnit(typedId, eligible, 'updated_desc', query.memberLimit, query.recencyField));
  }

  for (const [sessionId, doc] of resolvedSessionDocs) {
    if (doc.groupId !== undefined) continue;
    if (!memberMatchesFilter(doc, query.filter, workspaceSet, busySet, needle)) continue;
    if (!unitMatchesPinFilter([doc], query.filter.pinned)) continue;
    eligibleSessionIds.add(sessionId);
    const typedId = `s:${sessionId}`;
    unitsByTypedId.set(typedId, buildUnit(typedId, [doc], 'updated_desc', query.memberLimit, query.recencyField));
  }

  const units = [...unitsByTypedId.values()].sort((a, b) => compareUnits(a, b, 'updated_desc'));
  const missingSessionIds = query.sessionIds.filter((id) => !eligibleSessionIds.has(id));
  const missingGroupIds = query.groupIds.filter((id) => !eligibleGroupIds.has(id));
  return { units, missingSessionIds, missingGroupIds, revision };
}
