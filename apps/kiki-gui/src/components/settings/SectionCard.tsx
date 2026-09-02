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
