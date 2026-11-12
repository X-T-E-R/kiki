/**
 * Chrome shared by the routed tool pages (task board, scheduled tasks):
 * a paper header with the serif page title and the mobile menu button, plus
 * the workspace scope hook. The scope rides the URL (`?workspace=<id>`) so the
 * inspector and the sidebar nav can deep-link a pre-filtered page; no param
 * means "All workspaces". The scope control itself lives in
 * `WorkspaceScopeControl.tsx`.
 *
 * A header holds the title and at most one action on a phone; the rest go
 * behind `PageMoreMenu` (a bottom sheet on touch, a small menu otherwise), so
 * the title is never squeezed to two characters by a row of buttons.
 */

import { useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { Workspace } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { usePhoneMode } from '../lib/layoutHooks';
import { useSpaceLocation } from '../lib/spaceLocation';
import { useSidebarContext } from './sidebarContext';
import { Icon } from './icons';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { NavBackButton } from './NavBackButton';

export const PAGE_WIDTH = {
  reading: 'max-w-[720px]',
  split: 'max-w-[1040px]',
  dashboard: 'max-w-[1120px]',
} as const;

export type PageWidth = keyof typeof PAGE_WIDTH;

export function PhoneRemoteSpaceLine({ className = '' }: { readonly className?: string }) {
  const phoneMode = usePhoneMode();
  const { t } = useI18n();
  const { inRemoteScope, spaceName } = useSpaceLocation();
  if (!phoneMode || !inRemoteScope) return null;
  const text = t('sidebar.space.inSpace', { space: spaceName });
  return (
    <span data-phone-space-line title={text} className={`block min-w-0 truncate text-[11px] leading-[14px] text-ink-faint ${className}`}>
      {text}
    </span>
  );
}

export function PageHeader({
  title,
  onToggleSidebar,
  width,
  children,
}: {
  title: string;
  onToggleSidebar: () => void;
  width?: PageWidth;
  /** Right-aligned controls (refresh, primary action). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { sidebarOpen } = useSidebarContext();
  const content = (
    <>
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={t('sv.openMenuAria')}
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden"
      >
        <Icon name="menu" size={16} />
      </button>
      <NavBackButton />
      <div className="min-w-0 flex-1">
        <h1 data-page-title className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          {title}
        </h1>
        <PhoneRemoteSpaceLine />
      </div>
      {children === undefined ? null : <div data-page-actions className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>}
    </>
  );
  // Below `md` the 44px menu button sets the row; the slim padding keeps the
  // bar at the 48px Settings and conversations use.
  if (width === undefined) {
    return (
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 bg-paper px-4 py-0.5 md:py-2 lg:px-6">
        {content}
      </header>
    );
  }
  return (
    <header className="flex min-h-12 shrink-0 items-center bg-paper px-4 py-0.5 md:py-2 lg:px-6">
      <div
        data-page-header-inner={width}
        className={`mx-auto flex w-full ${PAGE_WIDTH[width]} flex-wrap items-center gap-x-2 gap-y-2`}
      >
        {content}
      </div>
    </header>
  );
}

/**
 * The page header's `⋯`: the actions that left the header row. The entries
 * are the shared menu's (`MiniContextMenu`), which turns into an
 * `ActionSheet` on a coarse pointer, so a phone gets a bottom sheet with
 * thumb-sized rows and a desktop keeps a small menu under the button.
 * Renders nothing when there is nothing to put in it.
 */
export function PageMoreMenu({ entries, menuId }: {
  readonly entries: readonly MiniMenuEntry[];
  /** Hook attribute stem: the button gets `data-<menuId>`, the menu `data-<menuId>-menu`. */
  readonly menuId: string;
}) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  if (entries.length === 0) return null;
  const menuAttribute = `data-${menuId}-menu`;
  // The button carries the menu's own attribute, so a press on it while the
  // menu is open is "inside" and toggles it shut instead of closing and
  // reopening it in the same gesture.
  const buttonProps = { [`data-${menuId}`]: true, [menuAttribute]: true } as Record<string, boolean>;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        {...buttonProps}
        aria-label={t('transcript.moreActions')}
        title={t('transcript.moreActions')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={() => {
          if (anchor !== null) { setAnchor(null); return; }
          const rect = buttonRef.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <Icon name="more" size={16} />
      </button>
      {anchor !== null ? (
        <MiniContextMenu
          x={anchor.x}
          y={anchor.y}
          entries={entries}
          onClose={() => { setAnchor(null); }}
          ariaLabel={t('transcript.moreActions')}
          overlayId={`${menuId}-menu`}
          dataAttribute={menuAttribute}
        />
      ) : null}
    </>
  );
}

/** Reads the `?workspace=` scope, dropping ids that are not registered. */
export function useWorkspaceScope(workspaces: readonly Pick<Workspace, 'id'>[]): {
  readonly scope: string | undefined;
  readonly setScope: (next: string | undefined) => void;
} {
  const [params, setParams] = useSearchParams();
  const raw = params.get('workspace') ?? undefined;
  // Unknown ids (a workspace removed since the link was made) read as "all"
  // once the list has loaded; before that the id is trusted as-is.
  const scope = raw !== undefined && (workspaces.length === 0 || workspaces.some((entry) => entry.id === raw))
    ? raw
    : undefined;
  const setScope = (next: string | undefined) => {
    const updated = new URLSearchParams(params);
    if (next === undefined) updated.delete('workspace');
    else updated.set('workspace', next);
    setParams(updated, { replace: true });
  };
  return { scope, setScope };
}
