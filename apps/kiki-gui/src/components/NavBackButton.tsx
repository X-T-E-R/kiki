import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useI18n } from '../i18n';
import { canGoBack, getBackEntry, getNavHistoryRevision, subscribeNavHistory, type NavHistoryEntry } from '../lib/navHistory';
import { useDirtyGuard } from './dirtyGuard';
import { Icon } from './icons';

interface NavStateContextValue {
  readonly canGoBack: boolean;
  readonly backEntry: NavHistoryEntry | null;
}

const NavStateContext = createContext<NavStateContextValue | null>(null);

function useNavState(): NavStateContextValue {
  const revision = useSyncExternalStore(subscribeNavHistory, getNavHistoryRevision, getNavHistoryRevision);
  return useMemo(() => ({ canGoBack: canGoBack(), backEntry: getBackEntry() }), [revision]);
}

export function NavHistoryBridge({ children }: { readonly children: ReactNode }) {
  const state = useNavState();
  return <NavStateContext.Provider value={state}>{children}</NavStateContext.Provider>;
}

interface NavBackButtonProps {
  /** Optional fallback label if none in history metadata */
  readonly fallbackLabel?: string;
  /** Optional custom class name */
  readonly className?: string;
}

/**
 * Quiet, accessible history return control. Cold/foreign history entries have
 * no fabricated predecessor. The store subscription also removes the control
 * immediately after POP to the first visit, without waiting for another route.
 */
export function NavBackButton({ fallbackLabel, className = '' }: NavBackButtonProps) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const dirtyGuard = useDirtyGuard();
  const observedState = useNavState();
  const navState = useContext(NavStateContext) ?? observedState;
  const backEntry = navState.backEntry;
  // Resolve built-in destinations in the current locale, including entries
  // recorded before a language change or recovered from sessionStorage.
  const backLabel = backEntry?.pathname.startsWith('/settings') ? t('st.title')
    : backEntry?.pathname === '/usage' ? t('usage.title')
      : backEntry?.pathname === '/board' ? t('nav.board')
        : backEntry?.pathname === '/cron' ? t('nav.cron')
          : backEntry?.pathname === '/memory' ? t('memory.title')
            : backEntry?.pathname === '/new' ? t('new.title')
              : backEntry?.label ?? fallbackLabel;
  const accessibleName = locale === 'zh'
    ? (backLabel ? `返回到 ${backLabel}` : '返回')
    : (backLabel ? `Back to ${backLabel}` : 'Back');

  const handleClick = useCallback(() => {
    if (!canGoBack()) return;
    if (dirtyGuard) dirtyGuard.navigate(-1);
    else void navigate(-1);
  }, [dirtyGuard, navigate]);

  if (!navState.canGoBack || !backEntry || !canGoBack()) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={accessibleName}
      title={accessibleName}
      className={`group flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11 ${className}`}
    >
      <Icon
        name="arrowLeft"
        size={14}
        className="text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] group-hover:text-ink"
      />
    </button>
  );
}
