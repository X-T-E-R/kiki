import type {
  MetaResponse,
  ResolveSidebarUnitsResponse,
  SessionAttentionCursor,
  SidebarGroupMembersResponse,
  SidebarGroupUnit,
  SidebarRow,
  SidebarSessionsPage,
  SidebarSessionsSort,
  SidebarUnit,
} from '@kiki/protocol';
import type { SessionWorkChangedPatch } from './sessionList';

export type SidebarUnitPage = SidebarSessionsPage;

export interface SidebarUnitPagesData {
  readonly pages: SidebarUnitPage[];
  readonly pageParams: unknown[];
  readonly unitRevisions?: Readonly<Record<string, number>>;
  readonly tombstones?: Readonly<Record<string, number>>;
}

export interface SidebarUnitReplacementOptions {
  readonly sort?: SidebarSessionsSort;
  readonly insertMissingAtHead?: boolean;
}

export function typedUnitKey(unit: Pick<SidebarUnit, 'kind' | 'id'>): string {
  return `${unit.kind === 'group' ? 'g' : 's'}:${unit.id}`;
}

export function hasSidebarGroupsCapability(
  meta: Pick<MetaResponse, 'capabilities'> | undefined,
): boolean {
  return meta?.capabilities?.sidebar_groups === true;
}

export function sidebarUnitRows(unit: SidebarUnit): readonly SidebarRow[] {
  return unit.kind === 'session' ? [unit.row] : unit.members;
}

export function isSidebarUnitPinned(unit: SidebarUnit): boolean {
  return unit.kind === 'session'
    ? unit.row.pinned === true
    : (unit.has_pinned === true || unit.members.some((member) => member.pinned === true));
}

function mergeAttentionCursor(
  current: SessionAttentionCursor | undefined,
  incoming: SessionAttentionCursor | undefined,
): SessionAttentionCursor | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  if (incoming.epoch !== current.epoch) return incoming;
  return incoming.seq >= current.seq ? incoming : current;
}

function sameAttentionCursor(
  a: SessionAttentionCursor | undefined,
  b: SessionAttentionCursor | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.epoch === b.epoch && a.seq === b.seq;
}

function retainRowCursors(
  incoming: SidebarRow,
  previous: SidebarRow | undefined,
): SidebarRow {
  if (previous === undefined) return incoming;
  const attention_cursor = mergeAttentionCursor(previous.attention_cursor, incoming.attention_cursor);
  const sameEpoch =
    incoming.attention_cursor?.epoch !== undefined &&
    previous.attention_cursor?.epoch !== undefined &&
    incoming.attention_cursor.epoch === previous.attention_cursor.epoch;
  const last_seq = sameEpoch
    ? Math.max(incoming.last_seq, previous.last_seq)
    : incoming.last_seq;
  if (
    last_seq === incoming.last_seq &&
    sameAttentionCursor(attention_cursor, incoming.attention_cursor)
  ) {
    return incoming;
  }
  return {
    ...incoming,
    last_seq,
    ...(attention_cursor !== undefined ? { attention_cursor } : {}),
  };
}

function retainUnitCursors(
  incoming: SidebarUnit,
  previousRows: ReadonlyMap<string, SidebarRow>,
): SidebarUnit {
  if (incoming.kind === 'session') {
    const nextRow = retainRowCursors(incoming.row, previousRows.get(incoming.row.id));
    return nextRow === incoming.row ? incoming : { ...incoming, row: nextRow };
  }
  let changed = false;
  const nextMembers = incoming.members.map((member) => {
    const nextMember = retainRowCursors(member, previousRows.get(member.id));
    if (nextMember !== member) changed = true;
    return nextMember;
  });
  return changed ? { ...incoming, members: nextMembers } : incoming;
}

function collectPreviousRows(data: SidebarUnitPagesData | undefined): Map<string, SidebarRow> {
  const rows = new Map<string, SidebarRow>();
  if (data === undefined) return rows;
  for (const page of data.pages) {
    for (const unit of page.units) {
      for (const row of sidebarUnitRows(unit)) {
        if (!rows.has(row.id)) rows.set(row.id, row);
      }
    }
  }
  return rows;
}

function unitSortText(unit: SidebarUnit): string {
  const title = unit.kind === 'group' ? unit.title : unit.row.title;
  return title.trim().toLowerCase();
}

function unitCreatedAtMs(unit: SidebarUnit): number {
  if (unit.kind === 'session') {
    const ms = Date.parse(unit.row.created_at);
    return Number.isFinite(ms) ? ms : 0;
  }
  let best = 0;
  for (const member of unit.members) {
    const ms = Date.parse(member.created_at);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return best;
}

/** Deterministic comparator matching the server's unit keyset ordering. */
export function compareSidebarUnits(
  a: SidebarUnit,
  b: SidebarUnit,
  sort: SidebarSessionsSort = 'updated_desc',
): number {
  if (sort === 'title') {
    const ta = unitSortText(a);
    const tb = unitSortText(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (a.sort_at !== b.sort_at) return b.sort_at - a.sort_at;
    return typedUnitKey(b).localeCompare(typedUnitKey(a));
  }
  if (sort === 'created_desc') {
    const ca = unitCreatedAtMs(a);
    const cb = unitCreatedAtMs(b);
    if (ca !== cb) return cb - ca;
    if (a.sort_at !== b.sort_at) return b.sort_at - a.sort_at;
    return typedUnitKey(b).localeCompare(typedUnitKey(a));
  }
  if (a.sort_at !== b.sort_at) return b.sort_at - a.sort_at;
  const ka = typedUnitKey(a);
  const kb = typedUnitKey(b);
  return ka === kb ? 0 : kb < ka ? -1 : 1;
}

function patchSidebarRowWorkChanged(row: SidebarRow, change: SessionWorkChangedPatch): SidebarRow {
  if (row.id !== change.sessionId) return row;
  const attention_cursor = mergeAttentionCursor(row.attention_cursor, change.attention_cursor);
  const nextPending = change.pending_interaction === 'none' ? undefined : change.pending_interaction;
  const nextMainActive = change.main_turn_active ? true : undefined;
  if (
    row.busy === change.busy &&
    row.executing === change.executing &&
    row.cleanup_pending === change.cleanup_pending &&
    row.main_turn_active === nextMainActive &&
    row.pending_interaction === nextPending &&
    row.last_turn_reason === change.last_turn_reason &&
    sameAttentionCursor(row.attention_cursor, attention_cursor)
  ) {
    return row;
  }
  return {
    ...row,
    busy: change.busy,
    ...(change.executing !== undefined ? { executing: change.executing } : {}),
    ...(change.cleanup_pending !== undefined ? { cleanup_pending: change.cleanup_pending } : {}),
    ...(nextMainActive !== undefined ? { main_turn_active: nextMainActive } : { main_turn_active: undefined }),
    ...(nextPending !== undefined ? { pending_interaction: nextPending } : { pending_interaction: undefined }),
    ...(change.last_turn_reason !== undefined ? { last_turn_reason: change.last_turn_reason } : {}),
    ...(attention_cursor !== undefined ? { attention_cursor } : {}),
  };
}

/** Patch status/attention fields in place without reordering units or cloning untouched rows/pages. */
export function patchSidebarUnitWorkChanged(
  old: SidebarUnitPagesData | undefined,
  change: SessionWorkChangedPatch,
): SidebarUnitPagesData | undefined {
  if (old === undefined || old === null || !Array.isArray(old.pages)) return old;
  let pagesChanged = false;
  const nextPages = old.pages.map((page) => {
    let unitsChanged = false;
    const nextUnits = page.units.map((unit): SidebarUnit => {
      if (unit.kind === 'session') {
        const nextRow = patchSidebarRowWorkChanged(unit.row, change);
        if (nextRow === unit.row) return unit;
        unitsChanged = true;
        return { ...unit, row: nextRow };
      }
      let membersChanged = false;
      const nextMembers = unit.members.map((member) => {
        const nextMember = patchSidebarRowWorkChanged(member, change);
        if (nextMember !== member) membersChanged = true;
        return nextMember;
      });
      if (!membersChanged) return unit;
      unitsChanged = true;
      return { ...unit, members: nextMembers };
    });
    if (!unitsChanged) return page;
    pagesChanged = true;
    return { ...page, units: nextUnits };
  });
  return pagesChanged ? { ...old, pages: nextPages } : old;
}

/** Flatten and deduplicate sidebar units across loaded pages while dropping obsolete standalone rows covered by a group. */
export function dedupeSidebarUnits(data: SidebarUnitPagesData | undefined): SidebarUnit[] {
  if (data === undefined || data === null || !Array.isArray(data.pages)) return [];
  const coveredByGroup = new Set<string>();
  for (const page of data.pages) {
    for (const unit of page.units) {
      if (unit.kind === 'group') {
        for (const member of unit.members) coveredByGroup.add(member.id);
      }
    }
  }
  const seen = new Set<string>();
  const out: SidebarUnit[] = [];
  for (const page of data.pages) {
    for (const unit of page.units) {
      const key = typedUnitKey(unit);
      if (seen.has(key)) continue;
      if (unit.kind === 'session' && coveredByGroup.has(unit.row.id)) continue;
      seen.add(key);
      out.push(unit);
    }
  }
  return out;
}

/** Combine loaded recency units with dedicated pinned units, deduplicating by unit and member identity. */
export function withPinnedSidebarUnits(
  list: SidebarUnitPagesData | undefined,
  pinned: SidebarUnitPagesData | undefined,
): SidebarUnit[] {
  const loaded = dedupeSidebarUnits(list);
  const loadedKeys = new Set(loaded.map(typedUnitKey));
  const loadedMemberIds = new Set<string>();
  for (const unit of loaded) {
    for (const row of sidebarUnitRows(unit)) loadedMemberIds.add(row.id);
  }
  const extra = dedupeSidebarUnits(pinned).filter((unit) => {
    if (!isSidebarUnitPinned(unit)) return false;
    if (loadedKeys.has(typedUnitKey(unit))) return false;
    if (unit.kind === 'session' && loadedMemberIds.has(unit.row.id)) return false;
    return true;
  });
  return extra.length === 0 ? loaded : [...loaded, ...extra];
}

function recordRevision(
  revisions: Record<string, number>,
  tombstones: Record<string, number>,
  key: string,
  revision: number,
  tombstone = false,
): void {
  const prevRev = revisions[key] ?? -1;
  if (revision > prevRev) revisions[key] = revision;
  if (tombstone) {
    const prevTomb = tombstones[key] ?? -1;
    if (revision > prevTomb) tombstones[key] = revision;
  } else if ((tombstones[key] ?? -1) <= revision) {
    delete tombstones[key];
  }
}

function isStaleForKey(
  revisions: Readonly<Record<string, number>>,
  tombstones: Readonly<Record<string, number>>,
  key: string,
  revision: number,
): boolean {
  const rev = revisions[key];
  if (rev !== undefined && revision < rev) return true;
  const tomb = tombstones[key];
  if (tomb !== undefined && revision < tomb) return true;
  return false;
}

/**
 * Apply revisioned unit replacements and removals across all loaded pages.
 * Eliminates duplicate occurrences and obsolete standalone/member rows,
 * preserves server traversal cursors and untouched page references, and
 * rejects out-of-order stale replies.
 */
export function applySidebarUnitReplacements(
  old: SidebarUnitPagesData | undefined,
  resolved: ResolveSidebarUnitsResponse,
  options: SidebarUnitReplacementOptions = {},
): SidebarUnitPagesData | undefined {
  if (old === undefined || old === null || !Array.isArray(old.pages) || old.pages.length === 0) {
    return old;
  }
  const existingGen = old.pages[0]?.generation;
  if (resolved.generation !== undefined && existingGen !== undefined && resolved.generation < existingGen) {
    return old;
  }
  const sort = options.sort ?? 'updated_desc';
  const insertMissingAtHead = options.insertMissingAtHead ?? true;
  const revision = resolved.revision;
  const previousRows = collectPreviousRows(old);
  const nextRevisions: Record<string, number> = { ...(old.unitRevisions ?? {}) };
  const nextTombstones: Record<string, number> = { ...(old.tombstones ?? {}) };

  const acceptedUnits: SidebarUnit[] = [];
  const replacedUnitKeys = new Set<string>();
  const claimedSessionIds = new Set<string>();

  for (const rawUnit of resolved.units) {
    const key = typedUnitKey(rawUnit);
    if (isStaleForKey(nextRevisions, nextTombstones, key, revision)) continue;
    const unit = retainUnitCursors(rawUnit, previousRows);
    acceptedUnits.push(unit);
    replacedUnitKeys.add(key);
    recordRevision(nextRevisions, nextTombstones, key, revision, false);
    for (const row of sidebarUnitRows(unit)) {
      claimedSessionIds.add(row.id);
      recordRevision(nextRevisions, nextTombstones, `s:${row.id}`, revision, false);
    }
  }

  const removedUnitKeys = new Set<string>();
  const removedSessionIds = new Set<string>();
  for (const sessionId of resolved.missing_session_ids) {
    const key = `s:${sessionId}`;
    if (isStaleForKey(nextRevisions, nextTombstones, key, revision)) continue;
    removedUnitKeys.add(key);
    removedSessionIds.add(sessionId);
    recordRevision(nextRevisions, nextTombstones, key, revision, true);
  }
  for (const groupId of resolved.missing_group_ids) {
    const key = `g:${groupId}`;
    if (isStaleForKey(nextRevisions, nextTombstones, key, revision)) continue;
    removedUnitKeys.add(key);
    recordRevision(nextRevisions, nextTombstones, key, revision, true);
  }

  if (acceptedUnits.length === 0 && removedUnitKeys.size === 0) {
    return old;
  }

  const hadUnitKey = new Set<string>();
  const hadSessionId = new Set<string>();
  for (const page of old.pages) {
    for (const unit of page.units) {
      hadUnitKey.add(typedUnitKey(unit));
      for (const row of sidebarUnitRows(unit)) hadSessionId.add(row.id);
    }
  }

  const strippedPages: SidebarUnitPage[] = old.pages.map((page) => {
    let changed = false;
    const nextUnits: SidebarUnit[] = [];
    for (const unit of page.units) {
      const key = typedUnitKey(unit);
      if (replacedUnitKeys.has(key) || removedUnitKeys.has(key)) {
        changed = true;
        continue;
      }
      if (unit.kind === 'session') {
        if (claimedSessionIds.has(unit.row.id) || removedSessionIds.has(unit.row.id)) {
          changed = true;
          continue;
        }
        nextUnits.push(unit);
        continue;
      }
      let membersChanged = false;
      const surviving = unit.members.filter((member) => {
        if (claimedSessionIds.has(member.id) || removedSessionIds.has(member.id)) {
          membersChanged = true;
          return false;
        }
        return true;
      });
      if (!membersChanged) {
        nextUnits.push(unit);
        continue;
      }
      changed = true;
      if (surviving.length > 0) {
        const nextCount = Math.max(surviving.length, unit.member_count - (unit.members.length - surviving.length));
        nextUnits.push({
          ...unit,
          member_count: nextCount,
          members: surviving,
        });
      }
    }
    return changed ? { ...page, units: nextUnits } : page;
  });

  const sortedInsertions = [...acceptedUnits].sort((a, b) => compareSidebarUnits(a, b, sort));
  const pagesCopy = [...strippedPages];

  for (const unit of sortedInsertions) {
    const existed =
      hadUnitKey.has(typedUnitKey(unit)) ||
      sidebarUnitRows(unit).some((row) => hadSessionId.has(row.id));

    let targetPageIndex = -1;
    for (let i = 0; i < pagesCopy.length; i += 1) {
      const page = pagesCopy[i]!;
      const lastUnit = page.units.at(-1);
      if (lastUnit === undefined) {
        if (i === 0) {
          targetPageIndex = 0;
          break;
        }
        continue;
      }
      if (compareSidebarUnits(unit, lastUnit, sort) <= 0) {
        targetPageIndex = i;
        break;
      }
    }

    if (targetPageIndex === -1) {
      const lastPage = pagesCopy.at(-1)!;
      if (!lastPage.has_more || existed) {
        targetPageIndex = pagesCopy.length - 1;
      } else if (insertMissingAtHead) {
        targetPageIndex = 0;
      } else {
        continue;
      }
    }

    const targetPage = pagesCopy[targetPageIndex]!;
    const nextUnits = [...targetPage.units];
    let insertAt = nextUnits.findIndex((existing) => compareSidebarUnits(unit, existing, sort) < 0);
    if (insertAt === -1) insertAt = nextUnits.length;
    nextUnits.splice(insertAt, 0, unit);
    pagesCopy[targetPageIndex] = { ...targetPage, units: nextUnits };
  }

  return {
    ...old,
    pages: pagesCopy,
    unitRevisions: nextRevisions,
    tombstones: nextTombstones,
  };
}

/** Merge a fresh head page while deduplicating promoted units out of deeper pages and honoring revisions/tombstones. */
export function mergeSidebarFirstPage(
  old: SidebarUnitPagesData | undefined,
  first: SidebarUnitPage,
  sort: SidebarSessionsSort = 'updated_desc',
): SidebarUnitPagesData | undefined {
  if (old === undefined || old === null || !Array.isArray(old.pages) || old.pages.length === 0) {
    return {
      pages: [first],
      pageParams: [undefined],
      unitRevisions: Object.fromEntries(first.units.map((u) => [typedUnitKey(u), first.revision])),
      tombstones: {},
    };
  }
  const existingGen = old.pages[0]?.generation;
  if (first.generation !== undefined && existingGen !== undefined && first.generation !== existingGen) {
    if (first.generation < existingGen) return old;
    return {
      pages: [first],
      pageParams: [undefined],
      unitRevisions: Object.fromEntries(first.units.map((u) => [typedUnitKey(u), first.revision])),
      tombstones: {},
    };
  }
  const previousRows = collectPreviousRows(old);
  const existingHeadByKey = new Map<string, SidebarUnit>();
  for (const unit of old.pages[0]!.units) existingHeadByKey.set(typedUnitKey(unit), unit);
  const nextRevisions: Record<string, number> = { ...(old.unitRevisions ?? {}) };
  const nextTombstones: Record<string, number> = { ...(old.tombstones ?? {}) };

  const acceptedHeadUnits: SidebarUnit[] = [];
  const headUnitKeys = new Set<string>();
  const headSessionIds = new Set<string>();
  let splicedNewer = false;

  for (const rawUnit of first.units) {
    const key = typedUnitKey(rawUnit);
    const unitStale = isStaleForKey(nextRevisions, nextTombstones, key, first.revision);
    const memberStale = sidebarUnitRows(rawUnit).some((row) =>
      isStaleForKey(nextRevisions, nextTombstones, `s:${row.id}`, first.revision),
    );
    if (unitStale || memberStale) {
      const existingNewer = existingHeadByKey.get(key);
      if (existingNewer !== undefined && !headUnitKeys.has(key)) {
        acceptedHeadUnits.push(existingNewer);
        headUnitKeys.add(key);
        for (const row of sidebarUnitRows(existingNewer)) headSessionIds.add(row.id);
        splicedNewer = true;
      }
      continue;
    }
    const unit = retainUnitCursors(rawUnit, previousRows);
    acceptedHeadUnits.push(unit);
    headUnitKeys.add(key);
    recordRevision(nextRevisions, nextTombstones, key, first.revision, false);
    for (const row of sidebarUnitRows(unit)) {
      headSessionIds.add(row.id);
      recordRevision(nextRevisions, nextTombstones, `s:${row.id}`, first.revision, false);
    }
  }

  for (const existing of old.pages[0]!.units) {
    const key = typedUnitKey(existing);
    if (headUnitKeys.has(key)) continue;
    const rev = nextRevisions[key] ?? -1;
    const tomb = nextTombstones[key] ?? -1;
    if (rev > first.revision && tomb < rev) {
      acceptedHeadUnits.push(existing);
      headUnitKeys.add(key);
      for (const row of sidebarUnitRows(existing)) headSessionIds.add(row.id);
      splicedNewer = true;
    }
  }

  if (splicedNewer) {
    acceptedHeadUnits.sort((a, b) => compareSidebarUnits(a, b, sort));
  }

  const headIsStale = first.revision < old.pages[0]!.revision;
  const maxHeadRevision = Math.max(first.revision, old.pages[0]!.revision);
  const normalizedFirst: SidebarUnitPage = {
    ...first,
    revision: maxHeadRevision,
    has_more: headIsStale ? old.pages[0]!.has_more : first.has_more,
    next_cursor: headIsStale ? old.pages[0]!.next_cursor : first.next_cursor,
    units: acceptedHeadUnits,
  };
  if (old.pages.length === 1) {
    return {
      ...old,
      pages: [normalizedFirst],
      unitRevisions: nextRevisions,
      tombstones: nextTombstones,
    };
  }

  const tailPages = old.pages.slice(1).map((page) => {
    let changed = false;
    const nextUnits = page.units.filter((unit) => {
      const key = typedUnitKey(unit);
      if (headUnitKeys.has(key)) {
        changed = true;
        return false;
      }
      if (unit.kind === 'session' && headSessionIds.has(unit.row.id)) {
        changed = true;
        return false;
      }
      return true;
    });
    return changed ? { ...page, units: nextUnits } : page;
  });

  return {
    ...old,
    pages: [normalizedFirst, ...tailPages],
    unitRevisions: nextRevisions,
    tombstones: nextTombstones,
  };
}

/** Append a newly fetched tail page while filtering out stale duplicates/tombstones and preserving earlier page references. */
export function appendSidebarPage(
  old: SidebarUnitPagesData | undefined,
  nextPage: SidebarUnitPage,
  pageParam: unknown,
): SidebarUnitPagesData {
  if (old === undefined || old === null || !Array.isArray(old.pages) || old.pages.length === 0) {
    return {
      pages: [nextPage],
      pageParams: [pageParam],
      unitRevisions: Object.fromEntries(nextPage.units.map((u) => [typedUnitKey(u), nextPage.revision])),
      tombstones: {},
    };
  }
  const existingGen = old.pages[0]?.generation;
  if (nextPage.generation !== undefined && existingGen !== undefined && nextPage.generation !== existingGen) {
    return old;
  }
  const existingKeys = new Set<string>();
  const existingSessionIds = new Set<string>();
  for (const page of old.pages) {
    for (const unit of page.units) {
      existingKeys.add(typedUnitKey(unit));
      for (const row of sidebarUnitRows(unit)) existingSessionIds.add(row.id);
    }
  }
  const nextRevisions: Record<string, number> = { ...(old.unitRevisions ?? {}) };
  const nextTombstones: Record<string, number> = { ...(old.tombstones ?? {}) };
  const filteredUnits: SidebarUnit[] = [];
  let unitsChanged = false;
  for (const unit of nextPage.units) {
    const key = typedUnitKey(unit);
    if (existingKeys.has(key) || isStaleForKey(nextRevisions, nextTombstones, key, nextPage.revision)) {
      unitsChanged = true;
      continue;
    }
    if (unit.kind === 'session') {
      if (
        existingSessionIds.has(unit.row.id) ||
        isStaleForKey(nextRevisions, nextTombstones, `s:${unit.row.id}`, nextPage.revision)
      ) {
        unitsChanged = true;
        continue;
      }
      recordRevision(nextRevisions, nextTombstones, key, nextPage.revision, false);
      recordRevision(nextRevisions, nextTombstones, `s:${unit.row.id}`, nextPage.revision, false);
      filteredUnits.push(unit);
      continue;
    }
    const keptMembers = unit.members.filter(
      (member) =>
        !existingSessionIds.has(member.id) &&
        !isStaleForKey(nextRevisions, nextTombstones, `s:${member.id}`, nextPage.revision),
    );
    if (keptMembers.length === 0) {
      unitsChanged = true;
      continue;
    }
    recordRevision(nextRevisions, nextTombstones, key, nextPage.revision, false);
    for (const member of keptMembers) {
      recordRevision(nextRevisions, nextTombstones, `s:${member.id}`, nextPage.revision, false);
    }
    if (keptMembers.length === unit.members.length) {
      filteredUnits.push(unit);
    } else {
      unitsChanged = true;
      filteredUnits.push({
        ...unit,
        members: keptMembers,
        member_count: Math.max(keptMembers.length, unit.member_count - (unit.members.length - keptMembers.length)),
      });
    }
  }
  const finalPage: SidebarUnitPage = unitsChanged ? { ...nextPage, units: filteredUnits } : nextPage;
  return {
    pages: [...old.pages, finalPage],
    pageParams: [...old.pageParams, pageParam],
    unitRevisions: nextRevisions,
    tombstones: nextTombstones,
  };
}

/** Append paginated group members onto the target group unit without cloning untouched pages or units. */
export function appendSidebarGroupMembers(
  old: SidebarUnitPagesData | undefined,
  response: SidebarGroupMembersResponse,
): SidebarUnitPagesData | undefined {
  if (old === undefined || old === null || !Array.isArray(old.pages)) return old;
  const existingGen = old.pages[0]?.generation;
  if (response.generation !== undefined && existingGen !== undefined && response.generation !== existingGen) {
    return old;
  }
  const revisions = old.unitRevisions ?? {};
  const tombstones = old.tombstones ?? {};
  const groupKey = `g:${response.group_id}`;
  if (isStaleForKey(revisions, tombstones, groupKey, response.revision)) {
    return old;
  }
  let pagesChanged = false;
  const nextRevisions: Record<string, number> = { ...revisions };
  const nextTombstones: Record<string, number> = { ...tombstones };
  const nextPages = old.pages.map((page) => {
    let unitsChanged = false;
    const nextUnits = page.units.map((unit): SidebarUnit => {
      if (unit.kind !== 'group' || unit.id !== response.group_id) return unit;
      const byId = new Map<string, SidebarRow>();
      for (const member of unit.members) byId.set(member.id, member);
      for (const incoming of response.members) {
        if (isStaleForKey(revisions, tombstones, `s:${incoming.id}`, response.revision)) continue;
        const prev = byId.get(incoming.id);
        byId.set(incoming.id, retainRowCursors(incoming, prev));
        recordRevision(nextRevisions, nextTombstones, `s:${incoming.id}`, response.revision, false);
      }
      recordRevision(nextRevisions, nextTombstones, groupKey, response.revision, false);
      const nextMembers = [...byId.values()];
      const nextGroup: SidebarGroupUnit = {
        ...unit,
        has_pinned: unit.has_pinned || nextMembers.some((member) => member.pinned === true),
        member_count: Math.max(response.member_count, nextMembers.length),
        members: nextMembers,
        ...(response.has_more && response.next_cursor !== undefined
          ? { members_next_cursor: response.next_cursor }
          : { members_next_cursor: undefined }),
      };
      unitsChanged = true;
      return nextGroup;
    });
    if (!unitsChanged) return page;
    pagesChanged = true;
    return { ...page, units: nextUnits };
  });
  return pagesChanged
    ? { ...old, pages: nextPages, unitRevisions: nextRevisions, tombstones: nextTombstones }
    : old;
}
