import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import { type UsageRangePreset } from '../../lib/usageV2';
import { Toggle } from '../controls';
import { Icon } from '../icons';
import { ActionSheet } from '../overlays/ActionSheet';
import { AnchoredPopover } from '../overlays/AnchoredPopover';

function useNarrowViewport(maxWidthPx = 639): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${maxWidthPx}px)`).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(max-width: ${maxWidthPx}px)`);
    const update = () => { setNarrow(mq.matches); };
    update();
    mq.addEventListener?.('change', update);
    return () => { mq.removeEventListener?.('change', update); };
  }, [maxWidthPx]);
  return narrow;
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function nextLocalDayStart(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function monthKeyOf(year: number, monthIndex: number): number {
  return year * 12 + monthIndex;
}

function fromMonthKey(key: number): { readonly year: number; readonly monthIndex: number } {
  const year = Math.floor(key / 12);
  const monthIndex = ((key % 12) + 12) % 12;
  return { year, monthIndex };
}

function buildCalendarCells(year: number, monthIndex: number): readonly (number | null)[] {
  const firstDay = new Date(year, monthIndex, 1);
  // Monday-first grid: Mon=0 .. Sun=6
  const leadBlanks = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<number | null> = [];
  for (let i = 0; i < leadBlanks; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(year, monthIndex, day).getTime());
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatYmd(dayStartMs: number): string {
  const d = new Date(dayStartMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatCompactDateRange(
  startAt: number | undefined,
  endAt: number | undefined,
  locale: string,
): string | undefined {
  if (startAt === undefined || endAt === undefined || endAt <= startAt) return undefined;
  const inclusiveEndMs = startOfLocalDay(endAt - 1);
  const start = new Date(startAt);
  const end = new Date(inclusiveEndMs);
  const sameDay = start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const fmt = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
  if (sameDay) return fmt.format(start);
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

export function CalendarIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? 'h-3.5 w-3.5'}
    >
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.8" />
      <path d="M5.5 2.2v2.4M10.5 2.2v2.4M2.5 6.8h11" />
    </svg>
  );
}

export function UsageCalendarPopover({
  id,
  open,
  phone,
  anchorRef,
  range,
  startAt,
  endAt,
  comparing,
  compareAvailable,
  onSelectPreset,
  onSelectCustomRange,
  onCompareChange,
  onClose,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly phone: boolean;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly range: UsageRangePreset;
  readonly startAt: number | undefined;
  readonly endAt: number | undefined;
  readonly comparing: boolean;
  readonly compareAvailable: boolean;
  readonly onSelectPreset: (preset: UsageRangePreset) => void;
  readonly onSelectCustomRange: (startAt: number, endAt: number) => void;
  readonly onCompareChange: (next: boolean) => void;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const todayStart = useMemo(() => startOfLocalDay(Date.now()), []);
  const todayDate = useMemo(() => new Date(todayStart), [todayStart]);

  // Right-hand month defaults to the end of the active custom range, or current month.
  const initialEndMonthKey = useMemo(() => {
    const refDate = endAt !== undefined ? new Date(endAt - 1) : todayDate;
    return monthKeyOf(refDate.getFullYear(), refDate.getMonth());
  }, [endAt, todayDate]);

  const [rightMonthKey, setRightMonthKey] = useState(initialEndMonthKey);
  const [draftStart, setDraftStart] = useState<number | null>(null);
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const narrowViewport = useNarrowViewport(639);
  const singleMonth = phone || narrowViewport;

  useEffect(() => {
    if (open) {
      setRightMonthKey(initialEndMonthKey);
      setDraftStart(null);
      setHoverDay(null);
    }
  }, [open, initialEndMonthKey]);

  const committedStart = startAt !== undefined ? startOfLocalDay(startAt) : undefined;
  const committedEnd = endAt !== undefined ? startOfLocalDay(endAt - 1) : undefined;

  const previewRange = useMemo((): { readonly lo: number; readonly hi: number } | undefined => {
    if (draftStart !== null) {
      const peer = hoverDay ?? draftStart;
      return { lo: Math.min(draftStart, peer), hi: Math.max(draftStart, peer) };
    }
    if (range === 'custom' && committedStart !== undefined && committedEnd !== undefined) {
      return { lo: committedStart, hi: committedEnd };
    }
    return undefined;
  }, [committedEnd, committedStart, draftStart, hoverDay, range]);

  const weekdays = locale === 'zh'
    ? ['一', '二', '三', '四', '五', '六', '日']
    : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  const formatMonthTitle = (year: number, monthIndex: number) =>
    new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'long',
    }).format(new Date(year, monthIndex, 1));

  const handleDayClick = (dayMs: number) => {
    if (draftStart === null) {
      setDraftStart(dayMs);
      setHoverDay(dayMs);
      return;
    }
    const lo = Math.min(draftStart, dayMs);
    const hi = Math.max(draftStart, dayMs);
    setDraftStart(null);
    setHoverDay(null);
    onSelectCustomRange(lo, nextLocalDayStart(hi));
    onClose();
  };

  const monthKeys = singleMonth ? [rightMonthKey] : [rightMonthKey - 1, rightMonthKey];
  const rollingPresets: readonly ('last_24_hours' | 'last_7_days' | 'last_30_days' | 'all')[] = [
    'last_24_hours',
    'last_7_days',
    'last_30_days',
    'all',
  ];
  const calendarPresets: readonly ('today' | 'this_week' | 'this_month')[] = [
    'today',
    'this_week',
    'this_month',
  ];

  const renderPresetButton = (preset: Exclude<UsageRangePreset, 'custom'>) => {
    const active = range === preset && draftStart === null;
    return (
      <button
        key={preset}
        type="button"
        data-calendar-preset={preset}
        aria-pressed={active}
        onClick={() => {
          setDraftStart(null);
          setHoverDay(null);
          onSelectPreset(preset);
          onClose();
        }}
        className={`inline-flex h-7 items-center rounded-md px-2.5 text-[12px] transition-colors pointer-coarse:min-h-10 ${
          active
            ? 'bg-selected font-medium text-selected-ink'
            : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
        }`}
      >
        {t(`usage.range.${preset}`)}
      </button>
    );
  };

  const body = (
    <div className="space-y-3 p-1" data-usage-custom-range>
      <div className="space-y-1.5 border-b border-hairline pb-2.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 min-w-14 font-sans tracking-normal text-[11px] font-medium text-[var(--kiki-chart-muted)]">
            {t('usage.range.rollingGroup')}
          </span>
          {rollingPresets.map(renderPresetButton)}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 min-w-14 font-sans tracking-normal text-[11px] font-medium text-[var(--kiki-chart-muted)]">
            {t('usage.range.calendarGroup')}
          </span>
          {calendarPresets.map(renderPresetButton)}
        </div>
      </div>

      <div className={`grid gap-5 ${singleMonth ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
        {monthKeys.map((mKey, idx) => {
          const { year, monthIndex } = fromMonthKey(mKey);
          const cells = buildCalendarCells(year, monthIndex);
          const showPrev = idx === 0;
          const showNext = idx === monthKeys.length - 1;
          const canAdvance = rightMonthKey < monthKeyOf(todayDate.getFullYear(), todayDate.getMonth());

          return (
            <div key={mKey} className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-0.5">
                {showPrev ? (
                  <button
                    type="button"
                    data-calendar-nav="prev"
                    aria-label={t('usage.calendar.prevMonth')}
                    onClick={() => { setRightMonthKey((k) => k - 1); }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
                  >
                    <Icon name="arrowLeft" size={14} />
                  </button>
                ) : <span className="h-7 w-7" />}

                <span className="font-sans tracking-normal text-[12.5px] font-semibold text-ink">
                  {formatMonthTitle(year, monthIndex)}
                </span>

                {showNext ? (
                  <button
                    type="button"
                    data-calendar-nav="next"
                    aria-label={t('usage.calendar.nextMonth')}
                    disabled={!canAdvance}
                    onClick={() => { setRightMonthKey((k) => k + 1); }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30"
                  >
                    <Icon name="arrowRight" size={14} />
                  </button>
                ) : <span className="h-7 w-7" />}
              </div>

              <div className="grid grid-cols-7 text-center font-sans tracking-normal text-[10.5px] font-medium text-[var(--kiki-chart-muted)]">
                {weekdays.map((wd) => (
                  <span key={wd} className="py-1">{wd}</span>
                ))}
              </div>

              <div
                className="grid grid-cols-7 gap-y-0.5 text-center text-[12px] tabular-nums"
                onMouseLeave={() => { if (draftStart !== null) setHoverDay(null); }}
              >
                {cells.map((dayMs, cellIdx) => {
                  if (dayMs === null) {
                    return <span key={`empty-${cellIdx}`} className="h-8" />;
                  }
                  const dayNum = new Date(dayMs).getDate();
                  const ymd = formatYmd(dayMs);
                  const isFuture = dayMs > todayStart;
                  const isToday = dayMs === todayStart;
                  const isStart = previewRange !== undefined && dayMs === previewRange.lo;
                  const isEnd = previewRange !== undefined && dayMs === previewRange.hi;
                  const inSpan = previewRange !== undefined && dayMs > previewRange.lo && dayMs < previewRange.hi;

                  return (
                    <button
                      key={ymd}
                      type="button"
                      disabled={isFuture}
                      data-calendar-day={ymd}
                      aria-pressed={isStart || isEnd}
                      onMouseEnter={() => { if (draftStart !== null && !isFuture) setHoverDay(dayMs); }}
                      onClick={() => { handleDayClick(dayMs); }}
                      className={`relative flex h-8 w-full items-center justify-center transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:text-ink-faint/35 ${
                        isStart && isEnd
                          ? 'rounded-md bg-ink font-semibold text-paper'
                          : isStart
                            ? 'rounded-l-md bg-ink font-semibold text-paper'
                            : isEnd
                              ? 'rounded-r-md bg-ink font-semibold text-paper'
                              : inSpan
                                ? 'bg-selected text-ink'
                                : 'rounded-md text-ink hover:bg-ink/[0.06]'
                      }`}
                    >
                      <span>{dayNum}</span>
                      {isToday && !isStart && !isEnd ? (
                        <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-accent" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-2.5 text-[12px]">
        <span
          className={previewRange !== undefined ? 'font-mono text-[11.5px] text-ink-faint tabular-nums' : 'text-[11.5px] text-ink-faint'}
          data-calendar-readout
        >
          {previewRange !== undefined
            ? `${formatYmd(previewRange.lo)} → ${formatYmd(previewRange.hi)}`
            : t(`usage.range.${range}`)}
        </span>

        <span
          data-usage-compare-wrap
          title={compareAvailable ? undefined : t('usage.compare.unavailable')}
          className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft"
        >
          <Toggle
            layout="bare"
            label={t('usage.compare.enable')}
            checked={comparing}
            disabled={!compareAvailable}
            onChange={onCompareChange}
            dataAttr="data-usage-compare"
          />
          <span className={!compareAvailable ? 'text-ink-faint' : undefined}>
            {t('usage.compare.enable')}
          </span>
        </span>
      </div>
    </div>
  );

  if (phone) {
    if (!open) return null;
    return (
      <ActionSheet
        id={id}
        role="dialog"
        ariaLabel={t('usage.axis.range')}
        overlayId={id}
        onClose={() => {
          setDraftStart(null);
          setHoverDay(null);
          onClose();
        }}
        dataAttribute="data-usage-calendar-popover"
        returnFocusRef={anchorRef as React.RefObject<HTMLButtonElement | null>}
        sheetClassName="flex flex-col p-3"
      >
        {body}
      </ActionSheet>
    );
  }

  return (
    <AnchoredPopover
      id={id}
      open={open}
      onClose={() => {
        setDraftStart(null);
        setHoverDay(null);
        onClose();
      }}
      anchorRef={anchorRef}
      label={t('usage.axis.range')}
      widthClassName={singleMonth ? 'w-[18.5rem] max-w-[calc(100vw-2rem)]' : 'w-[32.5rem] max-w-[calc(100vw-2rem)]'}
      data={{ 'data-usage-calendar-popover': '' }}
    >
      {body}
    </AnchoredPopover>
  );
}
