import { createContext, useContext } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';

/** Card id a settings-search hit asked to flash; null when idle. */
export const SettingsFlashContext = createContext<string | null>(null);

export type PanelScope = 'app' | 'server' | 'workspace' | 'readOnly';

/**
 * The scope the page header already announces. A panel writing to the same
 * target keeps its scope for assistive tech only; a panel that differs shows
 * one quiet tag. Null (a panel rendered outside the page) always shows it.
 */
export const SettingsPageScopeContext = createContext<PanelScope | null>(null);

export function scopeLabelKey(scope: PanelScope): I18nKey {
  return scope === 'app' ? 'st.scope.device'
    : scope === 'readOnly' ? 'st.scope.diagnostic'
    : scope === 'workspace' ? 'st.scope.workspace'
    : 'st.scope.connectedServer';
}

/** Small muted "Applies to: …" tag, shared by the page header and differing panels. */
export function ScopeTag({ scope, hidden = false, page = false }: { scope: PanelScope; hidden?: boolean; page?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      {...(page ? { 'data-settings-page-scope': scope } : { 'data-settings-panel-scope': scope })}
      className={hidden ? 'sr-only' : 'shrink-0 text-[12px] text-ink-faint'}
    >
      {t('st.scope.appliesTo')} {t(scopeLabelKey(scope))}
    </span>
  );
}

type CardBadge = 'restart' | 'desktop';

export function SectionCard({
  id,
  title,
  children,
  badge,
  aside,
  scope,
}: {
  id?: string;
  title: string;
  children?: React.ReactNode;
  badge?: CardBadge;
  /** Target of the panel's write, not a union of every scope on the page. */
  scope?: PanelScope;
  /** Quiet note on the heading row — the browser signpost for desktop-only
   * groups, so they cost one line instead of a page of disabled controls. */
  aside?: string;
}) {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const pageScope = useContext(SettingsPageScopeContext);
  const badgeClass = badge === 'restart' ? 'text-amber-ink' : 'text-ink-faint';
  const target: PanelScope = scope ?? (id !== undefined && [
    'st-card-language', 'st-card-appearance', 'st-card-appearance-type', 'st-card-appearance-layout',
    'st-card-skin-files', 'st-card-composer', 'st-card-desktop',
    'st-card-subagent-open-mode', 'st-card-append-timing', 'st-card-conn-server',
    'st-card-conn-timeout', 'st-card-conn-owned', 'st-card-conn-disconnect',
  ].includes(id) ? 'app' : 'server');
  const hasBody = children !== undefined && children !== null && children !== false;
  // Flat grouped rows: one hairline and the T1 display heading carry the
  // grouping. This is the only heading style inside the content pane; sub-
  // blocks use `SettingsGroup` (T3/500) and fields use T3/400 labels.
  return (
    <section
      id={id}
      className={`scroll-mt-4 border-t border-hairline pt-6 first:border-t-0 first:pt-0 ${flashId !== null && flashId === id ? 'settings-card-flash' : ''}`}
    >
      <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 ${hasBody ? 'mb-3' : ''}`}>
        <h2 className="mr-auto font-display text-[18px] leading-6 text-ink">{title}</h2>
        <ScopeTag scope={target} hidden={pageScope === target} />
        {badge !== undefined ? (
          <span className={`text-[12px] font-medium ${badgeClass}`}>
            {badge === 'restart' ? t('st.badge.restartRequired') : t('st.badge.desktopOnly')}
          </span>
        ) : null}
        {aside !== undefined ? (
          <span className="basis-full text-[12px] text-ink-faint">{aside}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}
