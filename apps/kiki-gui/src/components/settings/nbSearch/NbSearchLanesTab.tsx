import { useCallback, useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import {
  formatNbSearchOutput,
  nbSearchExecutionKind,
  nbSearchIssueCodes,
  resolveEffectiveDefaultLane,
  setNbSearchLane,
  setNbSearchPreset,
  type NbSearchDraft,
} from '@kiki/session-core/settings';
import { SectionCard } from '../SectionCard';
import { Hint } from '../../controls';
import { useI18n } from '../../../i18n';
import { costLabelKey, latencyLabelKey, loadPinnedLanes, savePinnedLanes } from './types';
import { NbSearchIssues } from './NbSearchIssues';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { Icon } from '../../icons';
import { NbSearchLaneEditor } from './NbSearchLaneEditor';
import { NbSearchPresetEditor } from './NbSearchPresetEditor';
import {
  nbSearchInstanceProviderId,
  nbSearchLaneIdentity,
  nbSearchPresetIdentity,
  nbSearchProviderLabel,
  nbSearchSourceBadgeKey,
  nbSearchUsageWord,
  type NbSearchAdvancedBinding,
  type NbSearchLaneIdentity,
} from './advancedSupport';

interface LaneRow {
  readonly id: string;
}

/** One line of the default-method list: name in the reading font, id below it. */
function laneTitle(
  t: ReturnType<typeof useI18n>['t'],
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft | undefined,
  row: LaneRow,
): string {
  if (draft === undefined) return row.id;
  const identity = nbSearchLaneIdentity(capabilities, draft, row.id);
  if (identity.profile === undefined) return row.id;
  const providerId = nbSearchInstanceProviderId(capabilities, draft, identity.profile.provider_instance_id);
  return `${nbSearchProviderLabel(t, providerId ?? identity.profile.provider_instance_id)} · ${identity.profile.operation_id}`;
}

function firstUnusedLane(capabilities: NbSearchCapabilities, draft: NbSearchDraft): string {
  return capabilities.search.lanes.find((lane) => draft.advanced?.lanes[lane.id] === undefined)?.id
    ?? capabilities.search.lanes[0]?.id
    ?? '';
}

export function NbSearchLanesTab({
  capabilities,
  defaultSearchLane,
  onSelectLane,
  saving = false,
  advanced,
}: {
  capabilities: NbSearchCapabilities;
  defaultSearchLane: string;
  onSelectLane: (laneId: string) => void;
  saving?: boolean;
  /** Present once the page hands its draft over; enables in-row editing. */
  advanced?: NbSearchAdvancedBinding;
}) {
  const { t, tp } = useI18n();
  const [filterQuery, setFilterQuery] = useState('');
  const [pinnedLanes, setPinnedLanes] = useState<string[]>(loadPinnedLanes);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const draft = advanced?.draft;
  const selectedLane = draft === undefined ? defaultSearchLane : draft.defaultSearchLane;

  const togglePin = (laneId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setPinnedLanes((prev) => {
      const next = prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId];
      savePinnedLanes(next);
      return next;
    });
  };

  const selectLane = (laneId: string) => {
    if (advanced === undefined) {
      onSelectLane(laneId);
      return;
    }
    advanced.onChange({ ...advanced.draft, defaultSearchLane: laneId });
  };

  // Every method the effective catalog serves plus any this page has drafted: a
  // method added a moment ago has no catalog entry yet, and hiding it would look
  // like the click did nothing.
  const rows = useMemo<LaneRow[]>(() => {
    const byId = new Map<string, LaneRow>(
      capabilities.search.lanes.map((lane) => [lane.id, { id: lane.id }]),
    );
    for (const [id, lane] of Object.entries(draft?.advanced?.lanes ?? {})) {
      if (lane === null || byId.has(id)) continue;
      byId.set(id, { id });
    }
    return [...byId.values()];
  }, [capabilities.search.lanes, draft]);

  /** Drafted here, not yet in the catalog the server reports. */
  const isPending = useCallback(
    (laneId: string) => !capabilities.search.lanes.some((lane) => lane.id === laneId),
    [capabilities.search.lanes],
  );

  const inherited = useMemo(
    () => resolveEffectiveDefaultLane(capabilities, selectedLane),
    [capabilities, selectedLane],
  );

  const filtered = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    if (query === '') return rows;
    return rows.filter((row) => {
      const lane = capabilities.search.lanes.find((candidate) => candidate.id === row.id);
      const haystack = [
        row.id,
        lane?.output.schema_id ?? '',
        lane?.latency ?? '',
        lane?.cost ?? '',
        draft === undefined ? '' : laneTitle(t, capabilities, draft, row),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, filterQuery, capabilities, draft, t]);

  const { pending, pinnedAndDefault, syncLanes, otherLanes } = useMemo(() => {
    const pinnedSet = new Set(pinnedLanes);
    const pendingRows: LaneRow[] = [];
    const pinnedRows: LaneRow[] = [];
    const sync: LaneRow[] = [];
    const other: LaneRow[] = [];
    for (const row of filtered) {
      const lane = capabilities.search.lanes.find((candidate) => candidate.id === row.id);
      if (isPending(row.id)) pendingRows.push(row);
      else if (row.id === inherited.laneId || pinnedSet.has(row.id)) pinnedRows.push(row);
      else if (lane?.availability === 'ready' && nbSearchExecutionKind(lane.execution_modes) === 'sync') sync.push(row);
      else other.push(row);
    }
    return { pending: pendingRows, pinnedAndDefault: pinnedRows, syncLanes: sync, otherLanes: other };
  }, [filtered, pinnedLanes, inherited.laneId, capabilities.search.lanes, isPending]);

  const renderRow = (row: LaneRow) => {
    const lane = capabilities.search.lanes.find((candidate) => candidate.id === row.id);
    const isSelected = selectedLane === row.id;
    const isEffective = inherited.laneId === row.id;
    const isPinned = pinnedLanes.includes(row.id);
    const expanded = openRow === `lane:${row.id}`;
    const identity: NbSearchLaneIdentity = draft === undefined
      ? { profile: undefined, source: 'source' }
      : nbSearchLaneIdentity(capabilities, draft, row.id);
    const execution = lane === undefined ? 'none' : nbSearchExecutionKind(lane.execution_modes);
    const usable = lane !== undefined && lane.availability === 'ready' && execution === 'sync';
    // A wall of red under every unconfigured method drowns the one that is
    // failing here. The reason stays one click away: the selected row, a
    // pinned row, an expanded row, or any active filter.
    const showIssues = expanded || isEffective || isPinned || filterQuery.trim() !== '';

    return (
      <li key={row.id} data-nb-search-lane-row={row.id} data-nb-search-lane-origin={identity.source}>
        <div className={`flex items-start gap-1 py-2 pl-3 pr-1 ${isSelected ? 'bg-panel' : ''}`}>
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name="nb-search-default-lane"
              className="mt-1 shrink-0"
              checked={isSelected}
              disabled={saving}
              onChange={() => {
                selectLane(row.id);
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="min-w-0 break-words text-[13px] text-ink">
                  {draft === undefined ? row.id : laneTitle(t, capabilities, draft, row)}
                </span>
                <span
                  className={`shrink-0 text-[12px] ${usable ? 'text-ink-soft' : 'text-ink-faint'}`}
                  data-nb-search-lane-execution={lane === undefined ? 'pending' : execution}
                >
                  {lane === undefined
                    ? t('st.nbSearch.custom.lane.pending')
                    : t(nbSearchUsageWord(lane.availability, execution))}
                </span>
                {isSelected ? (
                  <span className="text-[11px] text-ink-soft">{t('st.nbSearch.lanes.currentDefaultBadge')}</span>
                ) : isEffective ? (
                  <span className="text-[11px] text-ink-soft" data-nb-search-lane-inherited-badge>
                    {t('st.nbSearch.lanes.inheritedBadge')}
                  </span>
                ) : null}
                {isPinned ? (
                  <span className="text-[11px] text-ink-faint">{t('st.nbSearch.lanes.pinnedBadge')}</span>
                ) : null}
                {advanced === undefined ? null : (
                  <span className="text-[11px] text-ink-faint" data-nb-search-lane-source-badge={identity.source}>
                    {t(nbSearchSourceBadgeKey(identity.source))}
                  </span>
                )}
                {identity.source === 'override' ? (
                  <span className="text-[11px] text-ink-soft" data-nb-search-lane-overridden>
                    {t('st.nbSearch.custom.lane.badgeOverridden')}
                  </span>
                ) : null}
              </span>
              {/* Diagnostics line: the stable id first, then the instance the
                  method really runs on, then its output and cost tier. */}
              <span className="mt-0.5 block break-all font-mono text-[11px] text-ink-faint">
                {[row.id, identity.profile?.provider_instance_id].filter(Boolean).join(' · ')}
                {lane === undefined ? '' : ` · ${formatNbSearchOutput(lane.output)}`}
                {lane === undefined ? '' : ` · ${t(latencyLabelKey(lane.latency)!)} · ${t(costLabelKey(lane.cost)!)}`}
              </span>
              {showIssues && lane !== undefined ? <NbSearchIssues issues={nbSearchIssueCodes(lane.issues)} /> : null}
            </span>
          </label>
          <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
            {advanced !== undefined ? (
              <button
                type="button"
                aria-expanded={expanded}
                data-nb-search-lane-edit={row.id}
                aria-label={expanded ? t('st.nbSearch.custom.close') : t('st.nbSearch.custom.lane.edit')}
                title={expanded ? t('st.nbSearch.custom.close') : t('st.nbSearch.custom.lane.edit')}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${expanded ? 'text-ink' : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'}`}
                onClick={() => {
                  setOpenRow(expanded ? null : `lane:${row.id}`);
                }}
              >
                <Icon name={expanded ? 'collapse' : 'edit'} size={14} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={(event) => {
                togglePin(row.id, event);
              }}
              aria-pressed={isPinned}
              aria-label={isPinned ? t('st.nbSearch.lanes.unpinLane') : t('st.nbSearch.lanes.pinLane')}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${isPinned ? 'text-ink' : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'}`}
              title={isPinned ? t('st.nbSearch.lanes.unpinLane') : t('st.nbSearch.lanes.pinLane')}
            >
              <Icon name="pin" size={14} />
            </button>
          </div>
        </div>
        {expanded && advanced !== undefined ? (
          <div className="pb-3 pl-6 pr-2">
            <NbSearchLaneEditor
              binding={advanced}
              laneId={row.id}
              saving={saving}
              onRename={(next) => {
                setOpenRow(`lane:${next}`);
              }}
              onClose={() => {
                setOpenRow(null);
              }}
            />
          </div>
        ) : null}
      </li>
    );
  };

  const groups: readonly { key: string; title: string; rows: readonly LaneRow[] }[] = [
    { key: 'pending', title: t('st.nbSearch.custom.lane.groupPending'), rows: pending },
    { key: 'current', title: t('st.nbSearch.lanes.pinnedOrCurrent'), rows: pinnedAndDefault },
    { key: 'sync', title: t('st.nbSearch.lanes.syncLanes'), rows: syncLanes },
    { key: 'other', title: t('st.nbSearch.lanes.otherLanes'), rows: otherLanes },
  ].filter((group) => group.rows.length > 0);

  const presetRows = useMemo(() => {
    const byName = new Map<string, { id: string; lanes: readonly string[] }>();
    for (const preset of capabilities.search.presets) {
      byName.set(preset.name, { id: preset.name, lanes: preset.lanes });
    }
    for (const [name, preset] of Object.entries(draft?.advanced?.presets ?? {})) {
      if (preset === null) continue;
      byName.set(name, { id: name, lanes: preset.lanes });
    }
    return [...byName.values()];
  }, [capabilities.search.presets, draft]);

  const addPreset = () => {
    if (draft === undefined || advanced === undefined) return;
    const base = 'preset';
    let id = base;
    for (let suffix = 2; draft.advanced?.presets[id] !== undefined; suffix += 1) id = `${base}-${suffix}`;
    const lane = capabilities.search.lanes.find((candidate) => candidate.output.channel === 'results')?.id;
    if (lane === undefined) return;
    advanced.onChange(setNbSearchPreset(draft, id, { lanes: [lane] }));
    setOpenRow(`preset:${id}`);
  };

  const addLane = () => {
    if (draft === undefined || advanced === undefined) return;
    const base = 'custom.search';
    let id = base;
    for (let suffix = 2; draft.advanced?.lanes[id] !== undefined; suffix += 1) id = `${base}-${suffix}`;
    const lane = firstUnusedLane(capabilities, draft);
    const identity = nbSearchLaneIdentity(capabilities, draft, lane);
    advanced.onChange(setNbSearchLane(draft, id, identity.profile ?? {
      provider_instance_id: '',
      operation_id: '',
      latency: 'medium',
      cost: 'cheap',
    }));
    setOpenRow(`lane:${id}`);
  };

  return (
    <SectionCard id="st-card-search-defaults" title={t('st.nbSearch.defaultsTitle')}>
      <div className="space-y-4">
        <Hint>{t('st.nbSearch.defaultsHint')}</Hint>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filterQuery}
            onChange={(event) => {
              setFilterQuery(event.target.value);
            }}
            placeholder={t('st.nbSearch.lanes.filterPlaceholder')}
            aria-label={t('st.nbSearch.lanes.filterPlaceholder')}
            className={`${INPUT} min-w-0 flex-1`}
          />
          {advanced === undefined ? null : (
            <button
              type="button"
              className={`${SECONDARY_BUTTON} shrink-0 inline-flex items-center gap-1`}
              disabled={saving}
              data-nb-search-lane-add
              onClick={addLane}
            >
              <Icon name="plus" size={12} />
              {t('st.nbSearch.custom.lane.add')}
            </button>
          )}
        </div>

        <fieldset disabled={saving} className="disabled:opacity-60">
          {/* No Kiki override. This is "keep using whatever the engine
              provides", not "search is off" — the old copy claimed fail-closed
              while an inherited default was in fact serving every search. */}
          <label
            className={`flex items-start gap-2.5 py-2 pl-3 pr-2 cursor-pointer ${selectedLane === '' ? 'bg-panel' : ''}`}
            data-nb-search-lane-inherit
          >
            <input
              type="radio"
              name="nb-search-default-lane"
              className="mt-0.5 shrink-0"
              checked={selectedLane === ''}
              onChange={() => {
                selectLane('');
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="text-[13px] text-ink-soft">{t('st.nbSearch.lanes.inheritDefault')}</span>
              <span className="mt-0.5 block text-[12px] text-ink-faint" data-nb-search-lane-inherited>
                {inherited.laneId === undefined
                  ? t('st.nbSearch.inheritDefaultNone')
                  : inherited.inherited
                    ? t('st.nbSearch.inheritDefault', { lane: inherited.laneId })
                    : t('st.nbSearch.customDefault', { lane: inherited.laneId })}
              </span>
            </span>
          </label>

          {groups.map((group) => (
            <div key={group.key} className="mt-3 space-y-1">
              <p className="text-[12px] font-medium text-ink-soft">{group.title}</p>
              <ul className="divide-y divide-hairline">{group.rows.map(renderRow)}</ul>
            </div>
          ))}

          {filtered.length === 0 && filterQuery.trim() !== '' ? (
            <p className="py-4 text-center text-[12px] text-ink-faint">
              {t('st.nbSearch.lanes.noMatches', { query: filterQuery })}
            </p>
          ) : null}
        </fieldset>

        {presetRows.length > 0 || advanced !== undefined ? (
          <div className="space-y-2 border-t border-hairline pt-5" data-nb-search-presets>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">{t('st.nbSearch.custom.preset.group')}</p>
                <Hint>{t('st.nbSearch.custom.preset.groupHint')}</Hint>
              </div>
              {advanced === undefined ? null : (
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} shrink-0 inline-flex items-center gap-1`}
                  disabled={saving}
                  data-nb-search-preset-add
                  onClick={addPreset}
                >
                  <Icon name="plus" size={12} />
                  {t('st.nbSearch.custom.preset.add')}
                </button>
              )}
            </div>

            {presetRows.length === 0 ? (
              <p className="text-[12px] text-ink-faint">{t('st.nbSearch.custom.preset.empty')}</p>
            ) : (
              <ul className="divide-y divide-hairline" data-nb-search-preset-rows>
                {presetRows.map((preset) => {
                  const expanded = openRow === `preset:${preset.id}`;
                  const source = draft === undefined
                    ? 'source' as const
                    : nbSearchPresetIdentity(capabilities, draft, preset.id).source;
                  return (
                    <li key={preset.id} data-nb-search-preset-row={preset.id} data-nb-search-preset-origin={source}>
                      <div className={`flex items-start gap-1 py-2 pl-3 pr-1 ${expanded ? 'bg-panel' : ''}`}>
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                          aria-expanded={expanded}
                          data-nb-search-preset-open={preset.id}
                          disabled={advanced === undefined}
                          onClick={() => {
                            setOpenRow(expanded ? null : `preset:${preset.id}`);
                          }}
                        >
                          <span className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="min-w-0 break-words text-[13px] text-ink">{preset.id}</span>
                            <span className="shrink-0 text-[12px] text-ink-faint" data-nb-search-preset-source-badge={source}>
                              {t(nbSearchSourceBadgeKey(source))}
                            </span>
                            {source === 'override' ? (
                              <span className="text-[11px] text-ink-soft" data-nb-search-preset-overridden>
                                {t('st.nbSearch.custom.lane.badgeOverridden')}
                              </span>
                            ) : null}
                          </span>
                          <span className="block max-w-full truncate font-mono text-[11px] text-ink-faint">
                            {preset.lanes.join(' → ')}
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                          <span className="text-[12px] text-ink-faint">
                            {tp('st.nbSearch.custom.preset.laneCount', preset.lanes.length)}
                          </span>
                          {advanced === undefined ? null : (
                            <button
                              type="button"
                              aria-label={t('st.nbSearch.custom.preset.edit')}
                              title={t('st.nbSearch.custom.preset.edit')}
                              data-nb-search-preset-edit={preset.id}
                              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${expanded ? 'text-ink' : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'}`}
                              onClick={() => {
                                setOpenRow(expanded ? null : `preset:${preset.id}`);
                              }}
                            >
                              <Icon name={expanded ? 'collapse' : 'edit'} size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      {expanded && advanced !== undefined ? (
                        <div className="pb-3 pl-6 pr-2">
                          <NbSearchPresetEditor
                            binding={advanced}
                            presetId={preset.id}
                            saving={saving}
                            onRename={(next) => {
                              setOpenRow(`preset:${next}`);
                            }}
                            onClose={() => {
                              setOpenRow(null);
                            }}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
