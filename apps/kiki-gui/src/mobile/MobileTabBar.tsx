import { useRef } from 'react';
import { Mic } from 'lucide-react';

import { Icon, type IconName } from '../components/icons';
import { useI18n } from '../i18n';
import { MOBILE_ASSISTANT_PATH, MOBILE_CHATS_PATH, MOBILE_SPACES_PATH } from './mobileShellRoute';

export type MobileRootTab = 'assistant' | 'chats' | 'spaces';

interface MobileTabBarProps {
  readonly activeTab: MobileRootTab;
  readonly hidden: boolean;
  readonly needsYouCount: number;
  readonly unreadCount: number;
  readonly onSelectTab: (path: string) => void;
  readonly onQuickCapture: () => void;
  readonly onVoiceCapture: () => void;
}

const TAB_ITEMS: readonly {
  readonly id: MobileRootTab;
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: 'mobile.tab.assistant' | 'mobile.tab.chats' | 'mobile.tab.spaces';
}[] = [
  { id: 'assistant', path: MOBILE_ASSISTANT_PATH, icon: 'profileMain', labelKey: 'mobile.tab.assistant' },
  { id: 'chats', path: MOBILE_CHATS_PATH, icon: 'ask', labelKey: 'mobile.tab.chats' },
  { id: 'spaces', path: MOBILE_SPACES_PATH, icon: 'web', labelKey: 'mobile.tab.spaces' },
];

export function MobileTabBar({
  activeTab,
  hidden,
  needsYouCount,
  unreadCount,
  onSelectTab,
  onQuickCapture,
  onVoiceCapture,
}: MobileTabBarProps) {
  const { t } = useI18n();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <nav
      aria-label={t('mobile.tab.nav')}
      data-mobile-tabbar
      aria-hidden={hidden}
      className={`kiki-mobile-tabbar-dock ${hidden ? 'translate-y-24 opacity-0' : 'translate-y-0 opacity-100'}`}
    >
      <div className="flex w-full max-w-[420px] items-center justify-center gap-3">
        <div className="kiki-mobile-glass-pill pointer-events-auto grid h-14 flex-1 grid-cols-3 items-center rounded-full p-1">
          {TAB_ITEMS.map((item) => {
            const active = activeTab === item.id;
            const showCount = item.id === 'assistant' && needsYouCount > 0;
            const showQuietDot = item.id === 'assistant' && needsYouCount === 0 && unreadCount > 0;
            return (
              <button
                key={item.id}
                type="button"
                data-mobile-tab={item.id}
                aria-current={active ? 'page' : undefined}
                tabIndex={hidden ? -1 : 0}
                onClick={() => { onSelectTab(item.path); }}
                className={`relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${
                  active ? 'bg-ink/[0.08] text-ink' : 'text-ink-faint hover:text-ink-soft'
                }`}
              >
                <span className="relative inline-flex items-center justify-center">
                  <Icon
                    name={item.icon}
                    size={16}
                    className={active ? 'h-[18px] w-[18px] text-ink' : 'h-[18px] w-[18px] text-ink-faint'}
                  />
                  {showCount ? (
                    <span
                      data-mobile-tab-badge={needsYouCount}
                      className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-sans text-[10px] font-normal leading-none tabular-nums text-primary-foreground"
                    >
                      {needsYouCount > 99 ? '99+' : needsYouCount}
                    </span>
                  ) : showQuietDot ? (
                    <span
                      data-mobile-tab-dot
                      aria-hidden="true"
                      className="absolute -top-0.5 -right-1.5 h-[6px] w-[6px] rounded-full bg-ink-soft/75"
                    />
                  ) : null}
                </span>
                <span className={`text-[10.5px] leading-none font-normal ${active ? 'text-ink' : ''}`}>
                  {t(item.labelKey)}
                </span>
              </button>
            );
          })}
        </div>

        {activeTab === 'assistant' ? null : (
        <button
          type="button"
          data-mobile-quick-trigger
          aria-label={t('mobile.tab.quick')}
          tabIndex={hidden ? -1 : 0}
          onPointerDown={() => {
            longPressedRef.current = false;
            clearLongPress();
            longPressTimerRef.current = setTimeout(() => {
              longPressedRef.current = true;
              onVoiceCapture();
            }, 450);
          }}
          onPointerUp={() => { clearLongPress(); }}
          onPointerLeave={() => { clearLongPress(); }}
          onPointerCancel={() => { clearLongPress(); }}
          onClick={() => {
            if (longPressedRef.current) {
              longPressedRef.current = false;
              return;
            }
            onQuickCapture();
          }}
          className="pointer-events-auto flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-ink text-paper shadow-[0_6px_20px_-6px_rgb(var(--kiki-shadow-ink)/0.45)] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
        >
          <Mic className="h-5 w-5" strokeWidth={1.85} aria-hidden="true" />
        </button>
        )}
      </div>
    </nav>
  );
}
