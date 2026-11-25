/**
 * DiscoveryRouteRow — one discovery route as one quiet, whole-row action.
 *
 * Lists a registered route's title, purpose line, truthful per-station progress
 * dots, and one clear status at the end. Visited, skipped, completed, and
 * resumable states stay distinct and never collapse into one another.
 *
 * No accent here on purpose: the topic rows are peer places to start, distinct
 * from the primary overview tour above them. The route in progress takes the
 * app's selected-ink cue ("where you are").
 */

import type { DiscoveryRoute } from '@kiki/session-core/discovery';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';

export type DiscoveryStationMarkerState = 'resumable' | 'tried' | 'seen' | 'skipped' | 'unvisited';

export interface DiscoveryRouteRowProgress {
  readonly seen: number;
  readonly total: number;
  readonly viewed: boolean;
  readonly skipped?: number;
  readonly tried?: number;
}

function fallbackStationStates(
  progress: DiscoveryRouteRowProgress,
  current: boolean,
): readonly DiscoveryStationMarkerState[] {
  const skippedCount = progress.skipped ?? 0;
  return Array.from({ length: progress.total }, (_, index) => {
    if (index < progress.seen) return 'seen';
    if (current && index === progress.seen) return 'resumable';
    if (index < progress.seen + skippedCount) return 'skipped';
    return 'unvisited';
  });
}

function stationPipClass(state: DiscoveryStationMarkerState): string {
  if (state === 'resumable') return 'h-2 w-2 rounded-full bg-selected-ink ring-2 ring-selected-ink/25';
  if (state === 'tried' || state === 'seen') return 'h-2 w-2 rounded-full bg-ink/80';
  if (state === 'skipped') return 'h-2 w-2 rounded-full border border-dashed border-ink-faint bg-transparent';
  return 'h-2 w-2 rounded-full border border-hairline-strong bg-transparent';
}

export function DiscoveryRouteRow({
  route,
  progress,
  stationStates,
  current = false,
  finished = false,
  disabled,
  autoFocus,
  onSelect,
  data,
}: {
  readonly route: DiscoveryRoute;
  readonly progress: DiscoveryRouteRowProgress;
  /** Per-station checkpoint states in registered station order. */
  readonly stationStates?: readonly DiscoveryStationMarkerState[];
  /** The route the person is in the middle of; its row resumes instead of restarting. */
  readonly current?: boolean;
  /** True when the user reached the end of this route (distinct from every stop being seen). */
  readonly finished?: boolean;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly onSelect: () => void;
  /** Surface-owned hooks (`data-onboarding-route`, `data-start-route`, …). */
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}) {
  const { t } = useI18n();
  const skipped = progress.skipped ?? 0;
  const status = current
    ? t('discovery.continue')
    : finished
      ? skipped > 0
        ? `${t('discovery.finished')} · ${t('discovery.hub.overviewSkipped', { count: skipped })}`
        : t('discovery.finished')
      : progress.viewed
        ? t('discovery.seen')
        : progress.seen > 0
          ? skipped > 0
            ? `${progress.seen}/${progress.total} · ${t('discovery.hub.overviewSkipped', { count: skipped })}`
            : `${progress.seen}/${progress.total}`
          : skipped > 0
            ? `${t('discovery.stops', { count: progress.total })} · ${t('discovery.skipped')}`
            : t('discovery.stops', { count: progress.total });
  const pips = stationStates ?? fallbackStationStates(progress, current);

  return (
    <button
      type="button"
      {...data}
      data-discovery-route-row={route.id}
      data-autofocus={autoFocus === true ? true : undefined}
      aria-current={current ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`group flex w-full items-center gap-4 px-2.5 py-3.5 text-left transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-[52px] ${
        current ? 'bg-selected-ink/[0.06]' : 'hover:bg-ink/[0.03]'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-normal leading-5 text-ink">{t(route.titleKey)}</span>
        <span className="mt-0.5 block text-[12px] leading-4 text-ink-soft">{t(route.summaryKey)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span aria-hidden className="hidden items-center gap-1.5 sm:inline-flex" data-discovery-route-pips>
          {pips.map((state, index) => (
            <span key={route.stations[index] ?? index} className={stationPipClass(state)} />
          ))}
        </span>
        <span
          data-discovery-route-status
          className={`text-[12px] leading-4 tabular-nums ${current ? 'font-normal text-selected-ink' : finished || progress.viewed ? 'text-ink-soft' : 'text-ink-faint'}`}
        >
          {status}
        </span>
        <Icon
          name="arrowRight"
          size={14}
          className={`shrink-0 transition-transform duration-[var(--kiki-motion-quick)] group-hover:translate-x-0.5 group-hover:text-ink motion-reduce:transform-none ${
            current ? 'text-selected-ink' : 'text-ink-faint'
          }`}
        />
      </span>
    </button>
  );
}
