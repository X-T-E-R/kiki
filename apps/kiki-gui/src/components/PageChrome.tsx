/**
 * Chrome shared by the routed tool pages (task board, scheduled tasks):
 * a paper header with the serif page title and the mobile menu button, plus
 * the workspace scope hook. The scope rides the URL (`?workspace=<id>`) so the
 * inspector and the sidebar nav can deep-link a pre-filtered page; no param
 * means "All workspaces". The scope control itself lives in
 * `WorkspaceScopeControl.tsx`.
 */

import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { Workspace } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { Icon } from './icons';

export function PageHeader({
  title,
  onToggleSidebar,
  children,
}: {
  title: string;
  onToggleSidebar: () => void;
  /** Right-aligned controls (refresh, primary action). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-paper px-4 py-2 lg:px-6">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={t('sv.openMenuAria')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden"
      >
        <Icon name="menu" size={16} />
      </button>
      <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
        {title}
      </h1>
      {children}
    </header>
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
