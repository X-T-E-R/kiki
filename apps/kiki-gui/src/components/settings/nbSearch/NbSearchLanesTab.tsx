import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { formatNbSearchOutput, nbSearchIssueCodes } from '@kiki/session-core/settings';
import { SectionCard } from '../SectionCard';
import { Hint } from '../../controls';
import { useI18n } from '../../../i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import { costLabelKey, latencyLabelKey, loadPinnedLanes, savePinnedLanes } from './types';
import { NbSearchIssues } from './NbSearchIssues';
import { INPUT } from '../../ui';

function AvailabilityBadge({ availability }: { availability: 'ready' | 'unavailable' }) {
  const { t } = useI18n();
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
        availability === 'ready'
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-danger/40 bg-danger/5 text-danger'
      }`}
    >
      {availability === 'ready'
        ? t('st.nbSearch.availabilityReady')
        : t('st.nbSearch.availabilityUnavailable')}
    </span>
  );
}

/** Human label for a latency/cost tier; unknown tiers fall back to the raw id. */
function useTierLabel(): (key: I18nKey | undefined, raw: string) => string {
  const { t } = useI18n();
  return (key, raw) => (key === undefined ? raw : t(key));
}

export function NbSearchLanesTab({
  capabilities,
  defaultSearchLane,
  onSelectLane,
  saving = false,
}: {
  capabilities: NbSearchCapabilities;
  defaultSearchLane: string;
  onSelectLane: (laneId: string) => void;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const tierLabel = useTierLabel();
  const [filterQuery, setFilterQuery] = useState('');
  const [pinnedLanes, setPinnedLanes] = useState<string[]>(loadPinnedLanes);

  const togglePin = (laneId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setPinnedLanes((prev) => {
      const next = prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId];
      savePinnedLanes(next);
      return next;
    });
  };

  const laneIds = useMemo(
    () => new Set(capabilities.search.lanes.map((lane) => lane.id)),
    [capabilities.search.lanes],
  );

  const filteredLanes = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return capabilities.search.lanes;
    return capabilities.search.lanes.filter(
      (lane) =>
        lane.id.toLowerCase().includes(q) ||
        lane.output.schema_id.toLowerCase().includes(q) ||
        lane.latency.toLowerCase().includes(q) ||
        lane.cost.toLowerCase().includes(q),
    );
  }, [capabilities.search.lanes, filterQuery]);

  // Categorize lanes into groups:
  // 1. Current default & pinned
  // 2. Available sync lanes
  // 3. Other lanes (async only or unavailable)
  const { pinnedAndDefault, syncLanes, otherLanes } = useMemo(() => {
    const pinnedSet = new Set(pinnedLanes);
    const pd: typeof filteredLanes = [];
    const sync: typeof filteredLanes = [];
    const other: typeof filteredLanes = [];

    for (const lane of filteredLanes) {
      const isDefault = lane.id === defaultSearchLane;
      const isPinned = pinnedSet.has(lane.id);
      if (isDefault || isPinned) {
        pd.push(lane);
      } else if (lane.availability === 'ready' && lane.execution_modes.includes('sync')) {
        sync.push(lane);
      } else {
        other.push(lane);
      }
    }
    return { pinnedAndDefault: pd, syncLanes: sync, otherLanes: other };
  }, [filteredLanes, pinnedLanes, defaultSearchLane]);

  const renderLaneItem = (lane: (typeof capabilities.search.lanes)[number]) => {
    const isSelected = defaultSearchLane === lane.id;
    const isPinned = pinnedLanes.includes(lane.id);
    const syncSupported = lane.execution_modes.includes('sync');

    return (
      <div
        key={lane.id}
        className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
          isSelected
            ? 'border-accent bg-accent-soft/20 shadow-xs'
            : 'border-hairline bg-paper hover:border-hairline-strong'
        }`}
      >
        <label className="flex items-start gap-3 min-w-0 flex-1 cursor-pointer">
          <input
            type="radio"
            name="nb-search-default-lane"
            className="mt-1"
            checked={isSelected}
            disabled={saving}
            onChange={() => {
              onSelectLane(lane.id);
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">{lane.id}</span>
              <AvailabilityBadge availability={lane.availability} />
              {isSelected ? (
                <span className="rounded bg-accent/15 border border-accent/30 px-1.5 py-0.5 text-[9.5px] font-semibold text-accent uppercase">
                  {t('st.nbSearch.lanes.currentDefaultBadge')}
                </span>
              ) : null}
              {isPinned ? (
                <span className="rounded bg-hairline/40 px-1.5 py-0.5 text-[9.5px] font-medium text-ink-soft">
                  {t('st.nbSearch.lanes.pinnedBadge')}
                </span>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-ink-faint">
              <span>{formatNbSearchOutput(lane.output)}</span>
              <span>·</span>
              <span>
                {tierLabel(latencyLabelKey(lane.latency), lane.latency)}
                {' · '}
                {tierLabel(costLabelKey(lane.cost), lane.cost)}
              </span>
            </div>

            <NbSearchIssues issues={nbSearchIssueCodes(lane.issues)} />
          </div>
        </label>

        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <span className="text-[10.5px] text-ink-faint">
            {syncSupported
              ? t('st.nbSearch.lanes.syncSupported')
              : t('st.nbSearch.lanes.asyncOnly')}
          </span>
          <button
            type="button"
            onClick={(event) => {
              togglePin(lane.id, event);
            }}
            className="text-ink-faint hover:text-ink text-[14px] px-1 py-0.5 rounded transition-colors"
            title={isPinned ? t('st.nbSearch.lanes.unpinLane') : t('st.nbSearch.lanes.pinLane')}
          >
            {isPinned ? '★' : '☆'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <SectionCard id="st-card-search-defaults" title={t('st.nbSearch.defaultsTitle')}>
      <div className="space-y-4">
        <Hint>{t('st.nbSearch.defaultsHint')}</Hint>

        {/* Filter input */}
        <div className="relative">
          <input
            type="search"
            value={filterQuery}
            onChange={(event) => {
              setFilterQuery(event.target.value);
            }}
            placeholder={t('st.nbSearch.lanes.filterPlaceholder')}
            className={`${INPUT} pl-2`}
          />
        </div>

        <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
          {/* No default option (fail closed) */}
          <label
            className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
              defaultSearchLane === ''
                ? 'border-accent bg-accent-soft/20 shadow-xs'
                : 'border-hairline bg-paper hover:border-hairline-strong'
            }`}
          >
            <input
              type="radio"
              name="nb-search-default-lane"
              className="mt-0.5"
              checked={defaultSearchLane === ''}
              onChange={() => {
                onSelectLane('');
              }}
            />
            <div className="min-w-0 flex-1">
              <span className="text-[12.5px] font-medium text-ink-soft">
                {t('st.nbSearch.noDefaultLane')}
              </span>
              <p className="mt-0.5 text-[11px] text-ink-faint">
                {t('st.nbSearch.lanes.noDefaultHint')}
              </p>
            </div>
          </label>

          {/* Group 1: Pinned & Default */}
          {pinnedAndDefault.length > 0 ? (
            <div className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint px-1">
                {t('st.nbSearch.lanes.pinnedOrCurrent')}
              </span>
              <div className="space-y-2">{pinnedAndDefault.map(renderLaneItem)}</div>
            </div>
          ) : null}

          {/* Group 2: Available Sync Lanes */}
          {syncLanes.length > 0 ? (
            <div className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint px-1">
                {t('st.nbSearch.lanes.syncLanes')}
              </span>
              <div className="space-y-2">{syncLanes.map(renderLaneItem)}</div>
            </div>
          ) : null}

          {/* Group 3: Other Lanes */}
          {otherLanes.length > 0 ? (
            <div className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint px-1">
                {t('st.nbSearch.lanes.otherLanes')}
              </span>
              <div className="space-y-2">{otherLanes.map(renderLaneItem)}</div>
            </div>
          ) : null}

          {/* Unknown lane selected in draft */}
          {defaultSearchLane !== '' && !laneIds.has(defaultSearchLane) ? (
            <label className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/5 p-3 cursor-pointer">
              <input
                type="radio"
                name="nb-search-default-lane"
                className="mt-1"
                checked
                onChange={() => {
                  onSelectLane('');
                }}
              />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[12.5px] font-medium text-danger">
                  {defaultSearchLane}
                </span>
                <NbSearchIssues issues={['LANE_NOT_REGISTERED']} />
              </div>
            </label>
          ) : null}

          {filteredLanes.length === 0 && filterQuery.trim() !== '' ? (
            <p className="text-center text-[12px] text-ink-faint py-4">
              {t('st.nbSearch.lanes.noMatches', { query: filterQuery })}
            </p>
          ) : null}
        </fieldset>
      </div>
    </SectionCard>
  );
}
