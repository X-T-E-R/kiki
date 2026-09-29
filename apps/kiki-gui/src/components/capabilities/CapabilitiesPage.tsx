/**
 * /capabilities — the one place to see and manage what the agent can do.
 *
 * Four tabs, one per kind of capability: Plugins (marketplace home), Skills,
 * MCP servers, and Tools (read-only, everything callable). Plugins come first
 * because a plugin bundles the others: installing one adds tools, skills,
 * panels, commands or skins, and its detail says which.
 *
 * State rides the URL (`?tab=`, `?plugin=`, `?view=`, `?workspace=`) so
 * settings, the MCP list and skill rows can deep-link to a plugin, and Back
 * walks detail → home. The settings Skills / MCP / Plugins leaves render the
 * same views (`CapabilityTabBody`), so there is one implementation of each.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';

import { useI18n } from '../../i18n';
import { pickWorkspace } from '../../lib/capabilities';
import { isCatalogShelf } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { Dialog } from '../Dialog';
import { Icon } from '../icons';
import { MediaPreviewProvider } from '../mediaPreview';
import { PageHeader } from '../PageChrome';
import { SearchableSelect } from '../SearchableSelect';
import { AddSourceDialog } from './AddSourceDialog';
import { CapabilityGlyph } from './CapabilityIcon';
import { InstallFlow, type InstallRequest } from './InstallFlow';
import { McpView } from './McpView';
import { PluginPanelHost } from './PluginPanelHost';
import { PluginsView, type PluginsRoute } from './PluginsView';
import { IconButton } from './primitives';
import { SkillsView } from './SkillsView';
import { ToolsView } from './ToolsView';
import { usePluginPanels } from './usePlugins';

export type CapabilityTab = 'plugins' | 'skills' | 'mcp' | 'tools';
const TABS: readonly CapabilityTab[] = ['plugins', 'skills', 'mcp', 'tools'];

function isTab(value: string | null): value is CapabilityTab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

/** Read the plugins sub-route from URL params. */
export function pluginsRouteFrom(params: URLSearchParams): PluginsRoute {
  const plugin = params.get('plugin');
  if (plugin !== null && plugin !== '') return { view: 'detail', id: plugin };
  const view = params.get('view');
  // `manage` is the retired name of the Installed view; old links still land.
  if (view === 'installed' || view === 'manage') return { view: 'installed' };
  const shelf = params.get('shelf');
  if (view === 'shelf' && isCatalogShelf(shelf)) return { view: 'shelf', shelf };
  return { view: 'market' };
}

export function applyPluginsRoute(params: URLSearchParams, route: PluginsRoute): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('plugin');
  next.delete('view');
  next.delete('shelf');
  if (route.view === 'detail') next.set('plugin', route.id);
  if (route.view === 'installed') next.set('view', 'installed');
  if (route.view === 'shelf') { next.set('view', 'shelf'); next.set('shelf', route.shelf); }
  return next;
}

/** Workspace choice shared by Skills and MCP; `?workspace=` wins. */
export function useCapabilityWorkspace() {
  const { client } = useConnection();
  const [params] = useSearchParams();
  const requested = params.get('workspace') ?? undefined;
  const [workspaceId, setWorkspaceId] = useState('');
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const sorted = useMemo(() => sortWorkspacesByRecency(workspacesQuery.data?.items ?? []), [workspacesQuery.data]);
  useEffect(() => {
    if (workspaceId !== '' && sorted.some((workspace) => workspace.id === workspaceId)) return;
    const picked = pickWorkspace(sorted, requested);
    if (picked !== undefined) setWorkspaceId(picked.id);
  }, [workspaceId, sorted, requested]);
  const workspace = sorted.find((candidate) => candidate.id === workspaceId);
  return { workspaces: sorted, workspace, workspaceId, setWorkspaceId, query: workspacesQuery };
}

export function WorkspacePicker({
  workspaces,
  value,
  onChange,
  id,
}: {
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly root: string }[];
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly id: string;
}) {
  const { t } = useI18n();
  if (workspaces.length <= 1) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[12px] text-ink-faint">{t('cap.workspace')}</span>
      <SearchableSelect
        id={id}
        options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, hint: workspace.root, title: workspace.name }))}
        value={value}
        onChange={onChange}
        ariaLabel={t('cap.workspace')}
      />
    </div>
  );
}

export function CapabilitiesPage({ onToggleSidebar }: { readonly onToggleSidebar: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab: CapabilityTab = isTab(params.get('tab')) ? params.get('tab') as CapabilityTab : 'plugins';
  const route = pluginsRouteFrom(params);
  const { workspaces, workspace, workspaceId, setWorkspaceId } = useCapabilityWorkspace();
  const [addMenu, setAddMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [install, setInstall] = useState<InstallRequest | null>(null);
  const panel = params.get('panel');
  const [panelPluginId, panelId] = panel?.split(':') ?? [];
  const sessionId = params.get('session') ?? readLastSessionId();

  const setTab = (next: CapabilityTab) => {
    const updated = applyPluginsRoute(params, { view: 'market' });
    if (next === 'plugins') updated.delete('tab');
    else updated.set('tab', next);
    setParams(updated);
  };
  const setRoute = (next: PluginsRoute) => {
    const updated = applyPluginsRoute(params, next);
    updated.delete('tab');
    setParams(updated);
  };
  const openPanel = (pluginId: string, id: string) => {
    const updated = new URLSearchParams(params);
    updated.set('panel', `${pluginId}:${id}`);
    setParams(updated);
  };
  const closePanel = () => {
    const updated = new URLSearchParams(params);
    updated.delete('panel');
    setParams(updated);
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['plugins'] });
    void queryClient.invalidateQueries({ queryKey: ['plugin-marketplace'] });
    void queryClient.invalidateQueries({ queryKey: ['workspace-skills'] });
    void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    void queryClient.invalidateQueries({ queryKey: ['mcp-managed-servers'] });
    void queryClient.invalidateQueries({ queryKey: ['tools'] });
  };

  const addControl = (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={addMenu}
        data-capabilities-add
        onClick={() => { setAddMenu((open) => !open); }}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-ink/[0.06] px-3 text-[13px] font-medium text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.1] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:min-h-11"
      >
        {t('cap.page.add')}
        <Icon name="chevron" size={12} className="rotate-90" />
      </button>
      {addMenu ? (
        <AddMenu
          onClose={() => { setAddMenu(false); }}
          onPick={(kind) => {
            setAddMenu(false);
            if (kind === 'plugin') setAdding(true);
            if (kind === 'mcp') { setTab('mcp'); requestAnimationFrame(() => { document.querySelector<HTMLButtonElement>('[data-mcp-add]')?.click(); }); }
            if (kind === 'skill') setTab('skills');
          }}
        />
      ) : null}
    </div>
  );

  return (
    <MediaPreviewProvider>
      <div className="flex h-full min-h-0 flex-col bg-paper" data-capabilities-page={tab}>
        <PageHeader title={t('cap.page.title')} onToggleSidebar={onToggleSidebar}>
          <IconButton glyph={<CapabilityGlyph kind="refresh" />} label={t('cap.page.refresh')} onClick={refresh} dataAttrs={{ 'data-capabilities-refresh': '' }} />
          {addControl}
        </PageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-4 min-[720px]:px-8 min-[720px]:pt-8">
            {/* One row of chrome: which kind of capability, and (for Skills and
                MCP) which workspace. Every view below starts at its own
                switch + search. */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
              <nav aria-label={t('cap.page.tabs')} className="-mb-3 flex min-w-0 items-end gap-5 overflow-x-auto [scrollbar-width:none]" data-capabilities-tab={tab}>
                {TABS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-current={value === tab ? 'page' : undefined}
                    data-segment={value}
                    onClick={() => { setTab(value); }}
                    className={`-mb-px shrink-0 border-b-2 pb-2.5 text-[14px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-11 ${
                      value === tab ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                    }`}
                  >
                    {t(`cap.tab.${value}`)}
                  </button>
                ))}
              </nav>
              {(tab === 'skills' || tab === 'mcp') ? (
                <WorkspacePicker id="capabilities-workspace" workspaces={workspaces} value={workspaceId} onChange={setWorkspaceId} />
              ) : null}
            </div>
            <CapabilityTabBody
              tab={tab}
              route={route}
              onRoute={setRoute}
              workspaceId={workspaceId}
              workspaceRoot={workspace?.root}
              onOpenPanel={openPanel}
              onOpenPlugin={(id) => { setRoute({ view: 'detail', id }); }}
            />
          </div>
        </div>
      </div>
      {adding ? (
        <AddSourceDialog onClose={() => { setAdding(false); }} onPreview={(request) => { setAdding(false); setInstall(request); }} />
      ) : null}
      {install !== null ? <InstallFlow request={install} onClose={() => { setInstall(null); }} /> : null}
      {panelPluginId !== undefined && panelId !== undefined ? (
        <PanelSheet pluginId={panelPluginId} panelId={panelId} sessionId={sessionId} onClose={closePanel} />
      ) : null}
    </MediaPreviewProvider>
  );
}

function readLastSessionId(): string | undefined {
  try {
    return localStorage.getItem('kiki.lastSessionId') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The tab bodies, shared verbatim by the page and the settings leaves. */
export function CapabilityTabBody({
  tab,
  route,
  onRoute,
  workspaceId,
  workspaceRoot,
  onOpenPanel,
  onOpenPlugin,
}: {
  readonly tab: CapabilityTab;
  readonly route: PluginsRoute;
  readonly onRoute: (next: PluginsRoute) => void;
  readonly workspaceId: string;
  readonly workspaceRoot?: string;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  if (tab === 'plugins') return <PluginsView route={route} onRoute={onRoute} workspaceRoot={workspaceRoot} onOpenPanel={onOpenPanel} />;
  if (tab === 'skills') return <SkillsView workspaceId={workspaceId} onOpenPlugin={onOpenPlugin} />;
  if (tab === 'mcp') return <McpView cwd={workspaceRoot ?? ''} />;
  return <ToolsView />;
}

function AddMenu({ onClose, onPick }: { readonly onClose: () => void; readonly onPick: (kind: 'plugin' | 'mcp' | 'skill') => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-capabilities-add-menu],[data-capabilities-add]') === null) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  const items: readonly { kind: 'plugin' | 'mcp' | 'skill'; label: string; hint: string }[] = [
    { kind: 'plugin', label: t('cap.add.plugin'), hint: t('cap.add.pluginHint') },
    { kind: 'mcp', label: t('cap.add.mcp'), hint: t('cap.add.mcpHint') },
  ];
  return (
    <div
      role="menu"
      data-capabilities-add-menu
      className="anim-enter absolute right-0 top-full z-30 mt-1 w-64 rounded-xl border border-hairline bg-panel p-1 shadow-[0_12px_32px_-12px_rgb(var(--kiki-shadow-ink)/0.35)]"
    >
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          role="menuitem"
          data-capabilities-add-item={item.kind}
          onClick={() => { onPick(item.kind); }}
          className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="text-[13px] text-ink">{item.label}</span>
          <span className="text-[12px] leading-4 text-ink-faint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

function PanelSheet({ pluginId, panelId, sessionId, onClose }: {
  readonly pluginId: string;
  readonly panelId: string;
  readonly sessionId?: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const panels = usePluginPanels();
  const label = panels.data?.panels.find((entry) => entry.pluginId === pluginId && entry.id === panelId)?.label ?? panelId;
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={label}
      overlayId="plugin-panel"
      overlayClassName="fixed inset-0 z-50 flex items-stretch justify-end bg-shell/20"
      panelClassName="anim-enter flex h-full w-full max-w-[720px] flex-col border-l border-hairline bg-paper shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
      overlayData={{ 'data-plugin-panel-sheet': `${pluginId}:${panelId}` }}
    >
      <div className="flex min-h-12 items-center gap-2 border-b border-hairline px-4">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{label}</p>
        <span className="text-[12px] text-ink-faint">{sessionId === undefined ? t('cap.panel.noSession') : t('cap.panel.session')}</span>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1">
        <PluginPanelHost pluginId={pluginId} panelId={panelId} label={label} sessionId={sessionId} />
      </div>
    </Dialog>
  );
}
