import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { readDesktopPrefs } from '@kiki/session-core/settings';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { clampOverlayPosition } from '../lib/overlayPosition';
import {
  MAIN_SPACE_ID,
  currentSpace,
  currentSpaceId,
  enterSpace,
  launchWindowMode,
  otherSpacesPending,
  spaceRunState,
  spaceStatus,
  useSpaceStatuses,
  useSpaces,
  type SpaceListItem,
} from '../lib/spaces';
import { pushToast } from '../lib/toasts';
import { registerOverlay } from '../lib/uiBusy';
import { useConnection } from '../state/connection';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { SpaceDot } from './settings/spaces/SpaceDot';
import { Wordmark } from './Wordmark';

const MENU_WIDTH = 296;

/**
 * §6.4 / §9.4: the sidebar wordmark is the one space entry. It is always a
 * menu button, so a single-home user can discover "New space…" without an
 * extra row; the quiet chevron stays visible because touch has no hover.
 * Inside a space the wordmark is followed by the space's color and name. The
 * count is the other spaces' approvals and questions (this space's own are
 * already in Activity). Ctrl+Alt+1…9 opens the Nth space once there are two.
 */
export function SpaceSwitcher() {
  const { client } = useConnection();
  const host = useHost();
  const navigate = useGuardedNavigate();
  const { t, tp } = useI18n();
  const spaces = useSpaces(client);
  const statuses = useSpaceStatuses(host);
  const [open, setOpen] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mode = launchWindowMode(readDesktopPrefs().windowMode);
  const here = currentSpace();
  const items = spaces.data ?? [];
  const others = items.filter((item) => item.id !== MAIN_SPACE_ID);
  // An old server (or no REST) still gets the menu: main space, new, manage.
  const mainItem = items.find((item) => item.id === MAIN_SPACE_ID) ?? ({ id: MAIN_SPACE_ID, name: MAIN_SPACE_ID } as SpaceListItem);
  const ordered = [mainItem, ...others];
  const multi = ordered.length > 1;
  // Windows mode: each space window carries its own taskbar badge, and the
  // desktop cannot read other processes' counts (§9.4).
  const pending = mode === 'switch' ? otherSpacesPending(statuses.data) : 0;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);
  const currentName = here === null ? t('st.spaces.main') : (here.name ?? items.find((item) => item.id === here.homeId)?.name ?? here.homeId);

  const enter = (space: SpaceListItem) => {
    setOpen(false);
    if (space.id === currentSpaceId()) return;
    if (host.kind !== 'tauri') {
      pushToast({ tone: 'info', text: t('st.spaces.desktopOnly') });
      return;
    }
    setEntering(space.id);
    void enterSpace(host, space.id, mode)
      .catch(() => { pushToast({ tone: 'error', text: t('st.spaces.switchFailed', { name: label(space) }) }); })
      .finally(() => { setEntering(null); });
  };
  const enterRef = useRef(enter);
  enterRef.current = enter;

  // Window-level shortcut, never a global hotkey: Ctrl+Alt+1…9 → Nth space.
  useEffect(() => {
    if (!multi) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit === undefined) return;
      const target = ordered[Number(digit) - 1];
      if (target === undefined) return;
      event.preventDefault();
      enterRef.current(target);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [multi, ordered]);

  const title = pending > 0 ? `${t('sidebar.space.switcherAria')} · ${tp('sidebar.space.otherPending', pending)}` : t('sidebar.space.switcherAria');
  const enteringName = entering === null ? null : label(items.find((item) => item.id === entering) ?? { id: entering, name: entering } as SpaceListItem);
  const shownName = enteringName !== null ? t('sidebar.space.starting', { name: enteringName }) : here === null ? null : currentName;

  return (
    <>
      <button ref={triggerRef} type="button" data-space-switcher={currentSpaceId()} aria-haspopup="menu" aria-expanded={open}
        aria-label={`kiki · ${currentName} · ${title}`} title={title}
        onClick={() => { setOpen((value) => !value); }}
        className="group -ml-2 flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-ink transition-colors hover:bg-ink/[0.04] aria-expanded:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <span aria-hidden className="shrink-0"><Wordmark /></span>
        {shownName !== null ? (
          <>
            {/* The space's dot doubles as the separator from the wordmark. */}
            {here !== null ? <SpaceDot color={here.color} className="ml-1" /> : null}
            <span data-space-switcher-name title={shownName} className="min-w-0 truncate text-[13px] font-medium">{shownName}</span>
          </>
        ) : null}
        {pending > 0 ? (
          <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] text-on-accent">{pending}</span>
        ) : null}
        <Icon name="chevron" size={12} className="shrink-0 rotate-90 text-ink-faint transition-transform group-hover:text-ink-soft group-aria-expanded:-rotate-90" />
      </button>
      {open ? (
        <SpaceMenu anchor={triggerRef.current} onClose={() => { setOpen(false); }}>
          <p className="px-2.5 pt-2 pb-1 text-[12px] font-medium text-ink-faint">{t('sidebar.space.menuTitle')}</p>
          {multi ? null : <p data-space-single-hint className="px-2.5 pb-2 text-[12px] leading-[1.45] text-ink-soft">{t('sidebar.space.singleHint')}</p>}
          {ordered.map((space, index) => {
            const run = spaceRunState(space.id, statuses.data);
            const count = spaceStatus(space.id, statuses.data)?.pendingCount ?? 0;
            const current = run === 'current';
            return (
              <button key={space.id} type="button" role="menuitem" data-space-switch-item={space.id} data-space-state={run}
                aria-current={current ? 'true' : undefined}
                onClick={() => { enter(space); }}
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
                <SpaceDot color={space.id === MAIN_SPACE_ID ? 'var(--color-ink-faint)' : space.color} />
                <span className={`min-w-0 flex-1 truncate ${current ? 'font-medium' : ''}`}>{label(space)}</span>
                {current ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-ink-soft"><Icon name="check" size={12} />{t('st.spaces.current')}</span>
                ) : mode === 'switch' ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${run === 'hot' ? 'bg-success' : 'border border-ink-faint/70'}`} />
                    {t(run === 'hot' ? 'st.spaces.running' : 'st.spaces.notStarted')}
                  </span>
                ) : (
                  <span className="shrink-0 text-[11.5px] text-ink-faint">{t('sidebar.space.openWindow')}</span>
                )}
                {count > 0 && !current && mode === 'switch' ? (
                  <span className="shrink-0 rounded-full bg-attention-soft px-1.5 text-[11px] font-medium tabular-nums text-attention" aria-label={tp('st.spaces.pending', count)}>{count}</span>
                ) : null}
                {index < 9 && multi ? <kbd className="hidden shrink-0 font-mono text-[10.5px] text-ink-faint md:inline">⌃⌥{index + 1}</kbd> : null}
              </button>
            );
          })}
          <div className="mx-1 my-1 border-t border-hairline" />
          {here === null ? (
            <button type="button" role="menuitem" data-space-new-entry
              onClick={() => { setOpen(false); navigate('/settings/spaces?new=1'); }}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
              <Icon name="plus" size={14} className="shrink-0 text-ink-soft" />
              {t('sidebar.space.new')}
            </button>
          ) : null}
          <button type="button" role="menuitem" data-space-manage
            onClick={() => { setOpen(false); navigate('/settings/spaces'); }}
            className="flex h-9 w-full items-center rounded-md px-2.5 text-left text-[13px] text-ink-soft outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:bg-paper">
            {t('sidebar.space.manage')}
          </button>
        </SpaceMenu>
      ) : null}
    </>
  );
}

function SpaceMenu({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    setHeight(ref.current?.offsetHeight ?? 0);
    ref.current?.querySelector<HTMLButtonElement>('[aria-current="true"], button')?.focus();
  }, []);
  useEffect(() => {
    const unregister = registerOverlay('space-switcher-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); anchor?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length]?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (ref.current?.contains(event.target) === true || anchor?.contains(event.target) === true) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor]);
  const rect = anchor?.getBoundingClientRect();
  const position = clampOverlayPosition(rect?.left ?? 8, (rect?.bottom ?? 0) + 4, { width: MENU_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight });
  return createPortal(
    <div ref={ref} role="menu" aria-label={t('sidebar.space.menuTitle')} data-space-switcher-menu
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
      className="anim-enter fixed z-50 max-h-[min(72vh,480px)] overflow-y-auto rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
      {children}
    </div>,
    document.body,
  );
}
