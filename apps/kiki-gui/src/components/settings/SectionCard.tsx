import { createContext, useContext, useEffect } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';

/** Card id a settings-search hit asked to flash; null when idle. */
export const SettingsFlashContext = createContext<string | null>(null);

/**
 * How a card says it is on screen. A card that loads its own data (the
 * Experimental rows, a capability catalog) can mount long after the page's
 * first frame, so the page holds a deep-link request until the card that owns
 * that id announces itself instead of waiting out a deadline it would have to
 * guess. The notifier's identity changes with every request, so a card that was
 * already mounted is asked again too.
 */
export const SettingsCardMountContext = createContext<((id: string) => void) | null>(null);

export type PanelScope = 'app' | 'server' | 'workspace' | 'space' | 'readOnly';

/**
 * The scope the page header already announces. A panel writing to the same
 * target keeps its scope for assistive tech only; a panel that differs shows
 * one quiet tag. Null (a panel rendered outside the page) always shows it.
 */
export const SettingsPageScopeContext = createContext<PanelScope | null>(null);

export function scopeLabelKey(scope: PanelScope): I18nKey {
  return scope === 'app' ? 'st.scope.device'
    : scope === 'readOnly' ? 'st.scope.diagnostic'
    : scope === 'space' ? 'st.scope.space'
    : scope === 'workspace' ? 'st.scope.workspace'
    : 'st.scope.connectedServer';
}

/** Small muted "Saved on …" tag for a panel whose write target differs from its page. */
export function ScopeTag({ scope, hidden = false }: { scope: PanelScope; hidden?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      data-settings-panel-scope={scope}
      className={hidden ? 'sr-only' : 'shrink-0 text-[12px] text-ink-faint'}
    >
      {scope === 'readOnly' ? t('st.scope.diagnostic') : `${t('st.scope.appliesTo')} ${t(scopeLabelKey(scope))}`}
    </span>
  );
}

/**
 * When an instant-apply change is felt. "Now" is the default and is never
 * written down; only a delayed effect earns a note, so the note means
 * something every time it appears.
 */
export type SettingsEffect = 'newSessions' | 'restart' | 'desktop';

const EFFECT_KEY: Record<SettingsEffect, I18nKey> = {
  newSessions: 'st.effect.newSessions',
  restart: 'st.badge.restartRequired',
  desktop: 'st.badge.desktopOnly',
};

/** Card ids whose write target is this device even on a server-stored page. */
const DEVICE_CARD_IDS = new Set([
  'st-card-language', 'st-card-appearance', 'st-card-appearance-type', 'st-card-appearance-layout',
  'st-card-skin-files', 'st-card-composer', 'st-card-desktop',
  'st-card-subagent-open-mode', 'st-card-append-timing', 'st-card-conn-server',
  'st-card-conn-timeout', 'st-card-conn-owned', 'st-card-conn-disconnect', 'st-card-conn-ssh',
]);

export function SectionCard({
  id,
  title,
  children,
  badge,
  effect,
  aside,
  scope,
}: {
  id?: string;
  title: string;
  children?: React.ReactNode;
  /** Legacy spelling of `effect`; kept for panels owned by other slices. */
  badge?: 'restart' | 'desktop';
  /** Delayed or conditional effect of this card's changes (see SettingsEffect). */
  effect?: SettingsEffect;
  /** Target of the panel's write, not a union of every scope on the page. */
  scope?: PanelScope;
  /** Quiet note under the heading — the browser signpost for desktop-only
   * groups, so they cost one line instead of a page of disabled controls. */
  aside?: string;
}) {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);
  const pageScope = useContext(SettingsPageScopeContext);
  // Say "this card is here" on mount, and again whenever the page asks for a
  // card: the asker's identity changes with every request, so a card that was
  // already on screen is asked again instead of being missed.
  useEffect(() => { if (id !== undefined) onCardMount?.(id); }, [id, onCardMount]);
  const note = effect ?? badge;
  const target: PanelScope = scope ?? (id !== undefined && DEVICE_CARD_IDS.has(id) ? 'app' : 'server');
  const hasBody = children !== undefined && children !== null && children !== false;
  // Flat grouped rows: one hairline and the T1 display heading carry the
  // grouping. This is the only heading style inside the content pane; sub-
  // blocks use `SettingsGroup` (T3/500) and fields use T3/400 labels.
  return (
    <section
      id={id}
      data-settings-card={id}
      className={`scroll-mt-4 border-t border-hairline pt-6 first:border-t-0 first:pt-0 ${flashId !== null && flashId === id ? 'settings-card-flash' : ''}`}
    >
      <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 ${hasBody ? 'mb-3' : ''}`}>
        <h2 className="mr-auto font-display text-[18px] leading-6 text-ink">{title}</h2>
        <ScopeTag scope={target} hidden={pageScope === target} />
        {note !== undefined ? (
          <span data-settings-effect={note} className={`text-[12px] ${note === 'restart' ? 'font-medium text-amber-ink' : 'text-ink-faint'}`}>
            {t(EFFECT_KEY[note])}
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
