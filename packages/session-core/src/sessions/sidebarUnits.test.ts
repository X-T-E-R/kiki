import { describe, expect, it } from 'vitest';
import type { ResolveSidebarUnitsResponse, Session, SidebarGroupMembersResponse, SidebarRow, SidebarSessionsPage, SidebarUnit } from '@kiki/protocol';
import {
  mergeSessionActivity,
  mergeSessionWorkChanged,
  pinMetadataPatch,
  type SessionListData,
} from './sessionList';
import {
  appendSidebarGroupMembers,
  appendSidebarPage,
  applySidebarUnitReplacements,
  dedupeSidebarUnits,
  hasSidebarGroupsCapability,
  mergeSidebarFirstPage,
  patchSidebarUnitWorkChanged,
  typedUnitKey,
  withPinnedSidebarUnits,
  type SidebarUnitPagesData,
} from './sidebarUnits';

function makeRow(id: string, overrides: Partial<SidebarRow> = {}): SidebarRow {
  const ts = overrides.own_updated_at ?? '2026-11-24T10:00:00.000Z';
  return {
    id,
    workspace_id: 'ws_1',
    title: `Session ${id}`,
    created_at: '2026-11-24T09:00:00.000Z',
    updated_at: ts,
    own_updated_at: ts,
    busy: false,
    last_seq: 1,
    ...overrides,
  };
}

function makeSessionUnit(id: string, sortAt: number, overrides: Partial<SidebarRow> = {}): SidebarUnit {
  const iso = new Date(sortAt).toISOString();
  return {
    kind: 'session',
    id,
    sort_at: sortAt,
    row: makeRow(id, { updated_at: iso, own_updated_at: iso, ...overrides }),
  };
}

function makeGroupUnit(
  id: string,
  sortAt: number,
  members: SidebarRow[],
  extra: Partial<Extract<SidebarUnit, { kind: 'group' }>> = {},
): SidebarUnit {
  return {
    kind: 'group',
    id,
    title: members[0]?.title ?? id,
    sort_at: sortAt,
    has_pinned: extra.has_pinned ?? members.some((m) => m.pinned === true),
    member_count: extra.member_count ?? members.length,
    members,
    ...extra,
  };
}

describe('sidebarUnits cache & structural sharing', () => {
  it('checks meta capability cleanly', () => {
    expect(hasSidebarGroupsCapability({ capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true, thread_communication: true, transcript: true, sidebar_groups: true } })).toBe(true);
    expect(hasSidebarGroupsCapability({ capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true, thread_communication: true, transcript: true } })).toBe(false);
    expect(hasSidebarGroupsCapability(undefined)).toBe(false);
  });

  it('strips reserved group keys in pinMetadataPatch', () => {
    const session = {
      id: 's1',
      metadata: {
        cwd: '/repo',
        'kiki.group_id': 'grp_abc',
        'kiki.group_detached': true,
        'kiki.group_gen': 2,
        'kiki.group_origin': { homeId: 'h1', hostId: 'host1' },
        custom_note: 'keep',
      },
    } as unknown as Session;
    const pinned = pinMetadataPatch(session, true);
    expect(pinned['kiki.pinned']).toBe(true);
    expect(pinned['custom_note']).toBe('keep');
    expect(pinned['kiki.group_id']).toBeUndefined();
    expect(pinned['kiki.group_detached']).toBeUndefined();
    expect(pinned['kiki.group_gen']).toBeUndefined();
    expect(pinned['kiki.group_origin']).toBeUndefined();
  });

  it('preserves object identity on untouched pages and rows for workChanged ticks', () => {
    const unit1 = makeSessionUnit('s1', 3000);
    const unit2 = makeGroupUnit('grp_a', 2000, [makeRow('s2'), makeRow('s3')]);
    const unit3 = makeSessionUnit('s4', 1000);
    const data: SidebarUnitPagesData = {
      pages: [
        { revision: 1, units: [unit1, unit2], has_more: true, next_cursor: 'cur_1' },
        { revision: 1, units: [unit3], has_more: false },
      ],
      pageParams: [undefined, 'cur_1'],
    };

    const noop = patchSidebarUnitWorkChanged(data, {
      sessionId: 'unknown',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'none',
    });
    expect(noop).toBe(data);

    const updated = patchSidebarUnitWorkChanged(data, {
      sessionId: 's2',
      busy: true,
      executing: true,
      main_turn_active: true,
      pending_interaction: 'none',
      attention_cursor: { epoch: 'ep_1', seq: 5 },
    });
    expect(updated).not.toBe(data);
    expect(updated!.pages[1]).toBe(data.pages[1]);
    expect(updated!.pages[0]!.units[0]).toBe(unit1);
    const updatedGroup = updated!.pages[0]!.units[1] as Extract<SidebarUnit, { kind: 'group' }>;
    expect(updatedGroup.members[0]!.busy).toBe(true);
    expect(updatedGroup.members[0]!.attention_cursor).toEqual({ epoch: 'ep_1', seq: 5 });
    expect(updatedGroup.members[1]).toBe((unit2 as Extract<SidebarUnit, { kind: 'group' }>).members[1]);
    expect(updated!.pages[0]!.next_cursor).toBe('cur_1');

    const idempotent = patchSidebarUnitWorkChanged(updated, {
      sessionId: 's2',
      busy: true,
      executing: true,
      main_turn_active: true,
      pending_interaction: 'none',
      attention_cursor: { epoch: 'ep_1', seq: 4 },
    });
    expect(idempotent).toBe(updated);
  });

  it('promotes a page-2 group once while page 3 is in flight, ignores stale tail, and keeps cursors', () => {
    const p0: SidebarSessionsPage = {
      revision: 10,
      units: [makeSessionUnit('s_top', 5000), makeSessionUnit('s_mid', 4000)],
      has_more: true,
      next_cursor: 'cursor_p1',
    };
    const p1: SidebarSessionsPage = {
      revision: 10,
      units: [
        makeGroupUnit('grp_p2', 3000, [makeRow('g_open', { group_id: 'grp_p2' }), makeRow('g_child', { group_id: 'grp_p2' })]),
        makeSessionUnit('s_old', 2000),
      ],
      has_more: true,
      next_cursor: 'cursor_p2',
    };
    const state: SidebarUnitPagesData = {
      pages: [p0, p1],
      pageParams: [undefined, 'cursor_p1'],
    };

    const promotion: ResolveSidebarUnitsResponse = {
      revision: 15,
      units: [
        makeGroupUnit('grp_p2', 6000, [
          makeRow('g_child', { group_id: 'grp_p2', own_updated_at: new Date(6000).toISOString(), updated_at: new Date(6000).toISOString() }),
          makeRow('g_open', { group_id: 'grp_p2' }),
        ]),
      ],
      missing_session_ids: [],
      missing_group_ids: [],
    };
    const promoted = applySidebarUnitReplacements(state, promotion)!;
    const flat = dedupeSidebarUnits(promoted);
    expect(flat.map(typedUnitKey)).toEqual(['g:grp_p2', 's:s_top', 's:s_mid', 's:s_old']);
    expect(promoted.pages[0]!.units.map(typedUnitKey)).toEqual(['g:grp_p2', 's:s_top', 's:s_mid']);
    expect(promoted.pages[1]!.units.map(typedUnitKey)).toEqual(['s:s_old']);
    expect(promoted.pages[0]!.next_cursor).toBe('cursor_p1');
    expect(promoted.pages[1]!.next_cursor).toBe('cursor_p2');

    const staleTail: SidebarSessionsPage = {
      revision: 11,
      units: [
        makeGroupUnit('grp_p2', 3000, [makeRow('g_open', { group_id: 'grp_p2' })]),
        makeSessionUnit('s_older', 1000),
      ],
      has_more: false,
    };
    const withTail = appendSidebarPage(promoted, staleTail, 'cursor_p2');
    expect(withTail.pages[0]).toBe(promoted.pages[0]);
    expect(withTail.pages[1]).toBe(promoted.pages[1]);
    expect(withTail.pages[2]!.units.map(typedUnitKey)).toEqual(['s:s_older']);

    const staleHead: SidebarSessionsPage = {
      revision: 12,
      units: [makeGroupUnit('grp_p2', 3000, [makeRow('g_open', { group_id: 'grp_p2' })]), makeSessionUnit('s_top', 5000)],
      has_more: true,
      next_cursor: 'cursor_p1',
    };
    const afterStaleHead = mergeSidebarFirstPage(withTail, staleHead)!;
    const keptPromoted = afterStaleHead.pages[0]!.units.find((u) => typedUnitKey(u) === 'g:grp_p2');
    expect(keptPromoted?.sort_at).toBe(6000);
  });

  it('appends paginated group members without cloning untouched pages/units', () => {
    const p0: SidebarSessionsPage = {
      revision: 1,
      units: [
        makeSessionUnit('s1', 5000),
        makeGroupUnit('grp_big', 4000, [makeRow('m1'), makeRow('m2')], {
          member_count: 52,
          members_next_cursor: 'mcur_1',
        }),
      ],
      has_more: true,
      next_cursor: 'cur_1',
    };
    const p1: SidebarSessionsPage = {
      revision: 1,
      units: [makeSessionUnit('s2', 3000)],
      has_more: false,
    };
    const state: SidebarUnitPagesData = { pages: [p0, p1], pageParams: [undefined, 'cur_1'] };
    const resp: SidebarGroupMembersResponse = {
      revision: 2,
      group_id: 'grp_big',
      member_count: 52,
      members: [makeRow('m2'), makeRow('m3')],
      has_more: false,
    };
    const next = appendSidebarGroupMembers(state, resp)!;
    expect(next.pages[1]).toBe(p1);
    expect(next.pages[0]!.units[0]).toBe(p0.units[0]);
    const group = next.pages[0]!.units[1] as Extract<SidebarUnit, { kind: 'group' }>;
    expect(group.members.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(group.members_next_cursor).toBeUndefined();
  });

  it('deduplicates pinned units beyond page 1 and keeps structural sharing in legacy SessionListData helpers', () => {
    const list: SidebarUnitPagesData = {
      pages: [{ revision: 1, units: [makeSessionUnit('s1', 5000)], has_more: true, next_cursor: 'c1' }],
      pageParams: [undefined],
    };
    const pinned: SidebarUnitPagesData = {
      pages: [{
        revision: 1,
        units: [
          makeGroupUnit('grp_pin', 1000, [makeRow('old_pin', { pinned: true }), makeRow('old_sib')]),
          makeSessionUnit('s1', 5000, { pinned: true }),
        ],
        has_more: false,
      }],
      pageParams: [undefined],
    };
    const merged = withPinnedSidebarUnits(list, pinned);
    expect(merged.map(typedUnitKey)).toEqual(['s:s1', 'g:grp_pin']);

    const flatData: SessionListData = {
      pages: [
        { items: [{ id: 'a', busy: false, updated_at: '2026-11-24T10:00:00.000Z', last_seq: 1 } as Session], has_more: true },
        { items: [{ id: 'b', busy: false, updated_at: '2026-11-24T09:00:00.000Z', last_seq: 1 } as Session], has_more: false },
      ],
      pageParams: [undefined, 'a'],
    };
    const unchangedWork = mergeSessionWorkChanged(flatData, {
      sessionId: 'missing',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'none',
    });
    expect(unchangedWork).toBe(flatData);
    const updatedActivity = mergeSessionActivity(flatData, {
      id: 'a',
      busy: true,
      updated_at: '2026-11-24T10:01:00.000Z',
      last_seq: 2,
    } as Session)!;
    expect(updatedActivity.pages[1]).toBe(flatData.pages[1]);
  });

  it('prevents stale rev-11 head/member replies from erasing rev-12 replacements or resurrecting detached members, and preserves 51-member tail pins', () => {
    const base: SidebarUnitPagesData = {
      pages: [{
        revision: 10,
        generation: 1,
        units: [
          makeGroupUnit('grp_a', 5000, [makeRow('m1'), makeRow('m2')], { member_count: 3, members_next_cursor: 'mc1' }),
          makeSessionUnit('s_old', 4000),
        ],
        has_more: false,
      }],
      pageParams: [undefined],
      unitRevisions: { 'g:grp_a': 10, 's:m1': 10, 's:m2': 10, 's:s_old': 10 },
      tombstones: {},
    };
    const rev12 = applySidebarUnitReplacements(base, {
      revision: 12,
      generation: 1,
      units: [
        makeSessionUnit('m3', 6000),
        makeGroupUnit('grp_a', 5000, [makeRow('m1'), makeRow('m2')], { member_count: 2 }),
      ],
      missing_session_ids: [],
      missing_group_ids: [],
    })!;
    expect(rev12.pages[0]!.units.map(typedUnitKey)).toContain('s:m3');

    const staleHead: SidebarSessionsPage = {
      revision: 11,
      generation: 1,
      units: [
        makeGroupUnit('grp_a', 5000, [makeRow('m1'), makeRow('m2')], { member_count: 3, members_next_cursor: 'mc1' }),
        makeSessionUnit('s_old', 4000),
      ],
      has_more: false,
    };
    const afterStaleHead = mergeSidebarFirstPage(rev12, staleHead)!;
    expect(afterStaleHead.pages[0]!.units.map(typedUnitKey)).toContain('s:m3');
    const keptGroup = afterStaleHead.pages[0]!.units.find((u) => u.kind === 'group' && u.id === 'grp_a') as Extract<SidebarUnit, { kind: 'group' }>;
    expect(keptGroup.member_count).toBe(2);

    const afterStaleMembers = appendSidebarGroupMembers(afterStaleHead, {
      revision: 11,
      generation: 1,
      group_id: 'grp_a',
      member_count: 3,
      members: [makeRow('m3')],
      has_more: false,
    })!;
    const groupAfterMembers = afterStaleMembers.pages[0]!.units.find((u) => u.kind === 'group' && u.id === 'grp_a') as Extract<SidebarUnit, { kind: 'group' }>;
    expect(groupAfterMembers.members.map((m) => m.id)).not.toContain('m3');

    const afterRetiredGenResolve = applySidebarUnitReplacements(afterStaleHead, {
      revision: 99,
      generation: 0,
      units: [],
      missing_session_ids: ['m3'],
      missing_group_ids: ['grp_a'],
    })!;
    expect(afterRetiredGenResolve).toBe(afterStaleHead);

    const afterStaleTail = appendSidebarPage(
      afterStaleHead,
      {
        revision: 11,
        generation: 1,
        units: [makeGroupUnit('grp_b', 2000, [makeRow('m3'), makeRow('m4')])],
        has_more: false,
      },
      'c_tail',
    );
    const tailGroup = afterStaleTail.pages[1]!.units[0] as Extract<SidebarUnit, { kind: 'group' }>;
    expect(tailGroup.members.map((m) => m.id)).toEqual(['m4']);

    const pinned51List: SidebarUnitPagesData = {
      pages: [{ revision: 1, units: [makeSessionUnit('top', 9000)], has_more: true, next_cursor: 'c1' }],
      pageParams: [undefined],
    };
    const pinned51Query: SidebarUnitPagesData = {
      pages: [{
        revision: 1,
        units: [
          makeGroupUnit('grp_51', 1000, [makeRow('recent_1'), makeRow('recent_2')], {
            has_pinned: true,
            member_count: 51,
            members_next_cursor: 'mc_50',
          }),
        ],
        has_more: false,
      }],
      pageParams: [undefined],
    };
    expect(withPinnedSidebarUnits(pinned51List, pinned51Query).map(typedUnitKey)).toEqual(['s:top', 'g:grp_51']);
  });
});
