import { createContext, useContext } from 'react';

import { useI18n } from '../../i18n';

/** Card id a settings-search hit asked to flash; null when idle. */
export const SettingsFlashContext = createContext<string | null>(null);

type CardBadge = 'restart' | 'desktop';

export function SectionCard({
  id,
  title,
  children,
  badge,
  aside,
}: {
  id?: string;
  title: string;
  children?: React.ReactNode;
  badge?: CardBadge;
  /** Quiet note on the heading row — the browser signpost for desktop-only
   * groups, so they cost one line instead of a page of disabled controls. */
  aside?: string;
}) {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const badgeClass = badge === 'restart'
    ? 'border-amber-rule/60 bg-amber-card text-amber-ink'
    : 'border-hairline bg-paper text-ink-faint';
  // Flat grouped rows: a hairline rule and a quiet heading carry the grouping,
  // so the page scrolls in a fraction of the height bordered cards needed.
  return (
    <section
      id={id}
      className={`border-t border-hairline pt-3 first:border-t-0 first:pt-0 ${flashId !== null && flashId === id ? 'settings-card-flash' : ''}`}
    >
      <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${children !== undefined && children !== null && children !== false ? 'mb-2' : ''}`}>
        <h2 className="font-display text-[13px] font-semibold text-ink">{title}</h2>
        {badge !== undefined ? (
          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${badgeClass}`}>
            {badge === 'restart' ? t('st.badge.restartRequired') : t('st.badge.desktopOnly')}
          </span>
        ) : null}
        {aside !== undefined ? (
          <span className="text-[11px] text-ink-faint">{aside}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Collapsible group header for the capabilities section — a labeled layer
 * (title + card count + chevron + hairline rule) whose body folds with the
 * shared `.expand-collapse` grid-rows transition, mirroring the
 * /capabilities page's CapabilityGroup without nesting card chrome.
 */
export function SettingsGroup({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-settings-group={id} className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`st-group-body-${id}`}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <span
          aria-hidden
          className={`shrink-0 text-[11px] text-ink-faint transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          ▾
        </span>
        <span className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
          {title}
        </span>
        <span className="shrink-0 rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[10px] text-ink-faint tabular-nums">
          {count}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-hairline" />
      </button>
      <div
        id={`st-group-body-${id}`}
        className="expand-collapse grid"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="space-y-5 pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
