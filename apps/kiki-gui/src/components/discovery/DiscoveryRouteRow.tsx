/**
 * DiscoveryRouteRow — one discovery route as one quiet, whole-row action.
 *
 * The welcome's closing step and the /discover hub list the same catalog, so
 * they render the same row: the route's title, its purpose line, and a single
 * status at the end. Before anything is seen the status is the stop count;
 * once started it is `seen/total`; when every stop is behind you it says so;
 * and the route in progress reads "Continue exploring". The count lives in
 * that one place, so a route never states its length twice.
 *
 * No accent here on purpose: the rows are peer places to start, not one
 * recommended action. The route in progress is marked the way the rest of the
 * app marks "where you are" — the selected-ink wash — not with a primary.
 */

import type { DiscoveryRoute } from '@kiki/session-core/discovery';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';

export interface DiscoveryRouteRowProgress {
  readonly seen: number;
  readonly total: number;
  readonly viewed: boolean;
}

export function DiscoveryRouteRow({
  route,
  progress,
  current = false,
  disabled,
  autoFocus,
  onSelect,
  data,
}: {
  readonly route: DiscoveryRoute;
  readonly progress: DiscoveryRouteRowProgress;
  /** The route the person is in the middle of; its row resumes instead of restarting. */
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly onSelect: () => void;
  /** Surface-owned hooks (`data-onboarding-route`, `data-start-route`, …). */
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}) {
  const { t } = useI18n();
  const status = current
    ? t('discovery.continue')
    : progress.viewed
      ? t('discovery.seen')
      : progress.seen > 0
        ? `${progress.seen}/${progress.total}`
        : t('discovery.stops', { count: progress.total });

  return (
    <button
      type="button"
      {...data}
      data-discovery-route-row={route.id}
      data-autofocus={autoFocus === true ? true : undefined}
      aria-current={current ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`group flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:opacity-60 ${
        current ? 'bg-selected-ink/[0.07]' : 'hover:bg-ink/[0.04]'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink">{t(route.titleKey)}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">{t(route.summaryKey)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span
          data-discovery-route-status
          className={`text-[11px] tabular-nums ${current ? 'font-medium text-selected-ink' : 'text-ink-faint'}`}
        >
          {status}
        </span>
        <Icon
          name="arrowRight"
          size={14}
          className={`transition-colors group-hover:text-ink ${current ? 'text-selected-ink' : 'text-ink-faint'}`}
        />
      </span>
    </button>
  );
}
