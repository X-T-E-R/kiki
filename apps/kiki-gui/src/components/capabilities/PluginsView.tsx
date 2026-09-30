/**
 * Plugins — two views over one data layer (Codex plugin-page grammar).
 *
 * Market: the catalog (marketplace.json) in categories (Featured,
 * Productivity, …) as two-column cards, each category capped with "See N
 * more"; installed entries carry a light Installed tag. Advanced (catalog
 * address, add from source) folds at the bottom.
 *
 * Installed: every plugin on this server as a management list, whatever its
 * origin (official, catalog, a local folder, git, a ZIP). Detail is a
 * sub-view of both, so every surface shows the same state.
 */

import { useMemo, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { pluginUpdate, shelfOverflow, shelveCatalog, type CatalogShelfId, type PluginUpdateView } from '../../lib/pluginCatalog';
import { InlineError } from '../controls';
import { Icon, Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { AddSourceDialog, CatalogSourceField } from './AddSourceDialog';
import { CapabilityIcon } from './CapabilityIcon';
import { InstalledList } from './InstalledList';
import { InstallFlow, type InstallRequest } from './InstallFlow';
import { PluginCard } from './PluginCard';
import { PluginDetail } from './PluginDetail';
import { CapabilitySection, Disclosure, EmptyNote, QUIET_BUTTON, RowGrid, SearchField, Segmented, Tag } from './primitives';
import { useInstalledPlugins, usePluginGithubUpdates, usePluginMarketplace, usePluginRecommendations, type PluginSubject } from './usePlugins';

/** Two rows of two cards before a category folds into "See N more". */
const SHELF_ROWS = 4;

export type PluginsRoute =
  | { readonly view: 'market' }
  | { readonly view: 'installed' }
  | { readonly view: 'detail'; readonly id: string }
  | { readonly view: 'shelf'; readonly shelf: CatalogShelfId };

export function PluginsView({
  route,
  onRoute,
  workspaceRoot,
  onOpenPanel,
}: {
  readonly route: PluginsRoute;
  readonly onRoute: (next: PluginsRoute) => void;
  /** Root of the workspace in focus; the only task signal sent for suggestions. */
  readonly workspaceRoot?: string;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}) {
  const { t, tp, locale, time } = useI18n();
  const installedQuery = useInstalledPlugins();
  const marketQuery = usePluginMarketplace();
  const recommendQuery = usePluginRecommendations(workspaceRoot);
  const [query, setQuery] = useState('');
  const [install, setInstall] = useState<InstallRequest | null>(null);
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const installed = installedQuery.data?.plugins ?? [];
  const entries = marketQuery.data?.entries ?? [];
  const hasGithub = installed.some((plugin) => plugin.source === 'github');
  const githubQuery = usePluginGithubUpdates(hasGithub);
  // One answer per installed plugin: the catalog's newer version, else GitHub's.
  const updates = useMemo(() => {
    const map = new Map<string, PluginUpdateView>();
    for (const plugin of installed) {
      const update = pluginUpdate(plugin, entries.find((entry) => entry.id === plugin.id), githubQuery.data);
      if (update !== undefined) map.set(plugin.id, update);
    }
    return map;
  }, [installed, entries, githubQuery.data]);
  const subjectOf = (id: string): PluginSubject => ({
    id,
    installed: installed.find((plugin) => plugin.id === id),
    entry: entries.find((entry) => entry.id === id),
  });
  const startInstall = (entry: PluginMarketplaceEntry) => {
    setInstall({ source: entry.source, displayName: entry.displayName, icon: entry.icon, entry });
  };
  /** Every update goes through the same preview sheet; nothing installs here. */
  const startUpdate = (plugin: UpdateTarget, update: PluginUpdateView) => {
    const entry = entries.find((candidate) => candidate.id === plugin.id);
    setInstall({
      source: update.source,
      displayName: plugin.displayName,
      icon: plugin.icon ?? entry?.icon,
      entry,
      update: {
        fromVersion: plugin.version,
        enabled: plugin.enabled,
        ...(update.branch !== undefined && update.version !== undefined ? { branch: { name: update.branch, commit: update.version } } : {}),
      },
    });
  };
  const open = (id: string) => { onRoute({ view: 'detail', id }); };

  const sheets = (
    <>
      {adding ? <AddSourceDialog onClose={() => { setAdding(false); }} onPreview={(request) => { setAdding(false); setInstall(request); }} /> : null}
      {install !== null ? <InstallFlow request={install} onClose={() => { setInstall(null); }} /> : null}
    </>
  );

  if (route.view === 'detail') {
    return (
      <>
        <PluginDetail
          subject={subjectOf(route.id)}
          update={updates.get(route.id)}
          onBack={() => { onRoute({ view: 'market' }); }}
          onInstall={setInstall}
          onUpdate={startUpdate}
          onOpenPanel={onOpenPanel}
        />
        {sheets}
      </>
    );
  }

  const tab = route.view === 'installed' ? 'installed' : 'market';
  const filtering = query.trim() !== '';
  const relevant = new Set((recommendQuery.data?.entries ?? []).map((entry) => entry.id));
  const shelves = shelveCatalog(entries, query, relevant);
  const visibleShelves = route.view === 'shelf' ? shelves.filter((shelf) => shelf.id === route.shelf) : shelves;
  const attention = installed.filter((plugin) => plugin.state === 'error' || plugin.hasErrors || updates.has(plugin.id)).length;
  const updateCheck = hasGithub ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[12px] leading-[18px]" data-plugins-update-check={githubQuery.isFetching ? 'checking' : githubQuery.isError ? 'failed' : 'checked'}>
      {githubQuery.isFetching ? (
        <span className="flex items-center gap-2 text-ink-faint" role="status"><Spinner label={t('cap.updates.checking')} size={12} />{t('cap.updates.checking')}</span>
      ) : githubQuery.isError ? (
        <span className="text-danger" role="alert">{t('cap.updates.failed', { detail: errorText(locale, githubQuery.error) })}</span>
      ) : githubQuery.dataUpdatedAt > 0 ? (
        <span className="text-ink-faint">{t('cap.updates.checked', { time: time.relativeTime(new Date(githubQuery.dataUpdatedAt).toISOString()) })}</span>
      ) : null}
      {!githubQuery.isFetching ? (
        <button type="button" className={`${QUIET_BUTTON} -ml-2 min-h-7 text-[12px]`} onClick={() => { void githubQuery.refetch(); }} data-plugins-check-updates>
          {t('cap.updates.check')}
        </button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <div className="min-w-0 space-y-6" data-plugins-view={route.view}>
      <div className="flex flex-col gap-3 min-[720px]:flex-row min-[720px]:items-center">
        <Segmented
          value={tab}
          onChange={(next) => { onRoute(next === 'installed' ? { view: 'installed' } : { view: 'market' }); }}
          ariaLabel={t('cap.plugins.views')}
          dataAttribute="data-plugins-tab"
          options={[
            { value: 'market', label: t('cap.plugins.market') },
            { value: 'installed', label: installed.length > 0 ? `${t('cap.plugins.installed')} ${installed.length}` : t('cap.plugins.installed') },
          ]}
        />
        <div className="min-w-0 flex-1">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={tab === 'installed' ? t('cap.plugins.searchInstalled') : t('cap.plugins.search')}
            ariaLabel={tab === 'installed' ? t('cap.plugins.searchInstalled') : t('cap.plugins.search')}
          />
        </div>
      </div>

      {tab === 'installed' ? (
        <InstalledList
          plugins={installed}
          entries={entries}
          query={query}
          loading={installedQuery.isPending}
          error={installedQuery.isError ? installedQuery.error : undefined}
          updates={updates}
          updateCheck={updateCheck}
          onOpen={open}
          onUpdate={startUpdate}
          onAdd={() => { setAdding(true); }}
        />
      ) : (
        <>
          {route.view === 'shelf' ? (
            <button type="button" className={`${QUIET_BUTTON} -ml-2`} onClick={() => { onRoute({ view: 'market' }); }} data-plugins-shelf-back>
              <Icon name="arrowLeft" size={14} />
              {t('cap.plugins.allShelves')}
            </button>
          ) : attention > 0 && !filtering ? (
            <button type="button" className={`${QUIET_BUTTON} -ml-2 text-selected-ink hover:text-selected-ink`} onClick={() => { onRoute({ view: 'installed' }); }} data-plugins-attention>
              {tp('cap.plugins.attention', attention)}
              <Icon name="arrowRight" size={14} />
            </button>
          ) : null}
          {marketQuery.isPending ? (
            <p className="flex items-center gap-2 text-[13px] text-ink-faint" role="status"><Spinner label={t('cap.loading')} />{t('cap.plugins.loadingCatalog')}</p>
          ) : marketQuery.isError ? (
            <div className="space-y-2" data-plugins-catalog-error>
              <InlineError error={marketQuery.error} />
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void marketQuery.refetch(); }}>{t('common.retry')}</button>
            </div>
          ) : marketQuery.data?.configured === false ? (
            <EmptyNote title={t('cap.plugins.noCatalog')} body={t('cap.plugins.noCatalogBody')} />
          ) : (
            <div className="space-y-8">
              {visibleShelves.map((shelf) => (
                <CatalogShelfSection
                  key={shelf.id}
                  id={shelf.id}
                  entries={shelf.entries}
                  expanded={route.view === 'shelf' || filtering}
                  installed={installed}
                  relevant={relevant}
                  updates={updates}
                  onOpen={open}
                  onInstall={startInstall}
                  onUpdate={startUpdate}
                  onMore={() => { onRoute({ view: 'shelf', shelf: shelf.id }); }}
                />
              ))}
              {shelves.length === 0 ? (
                <EmptyNote title={filtering ? t('cap.plugins.noMatch', { query: query.trim() }) : t('cap.plugins.catalogEmpty')} />
              ) : null}
            </div>
          )}
          {route.view === 'market' ? (
            <div className="border-t border-hairline pt-3">
              <Disclosure label={t('cap.advanced')} open={advanced} onToggle={() => { setAdvanced((value) => !value); }} dataAttrs={{ 'data-plugins-advanced': '' }}>
                <div className="max-w-[560px] space-y-4 pb-1">
                  <CatalogSourceField />
                  <div className="space-y-1">
                    <button type="button" className={SECONDARY_BUTTON} onClick={() => { setAdding(true); }} data-plugins-add-source-home>
                      {t('cap.plugins.addFromSource')}
                    </button>
                    <p className="text-[12px] leading-4 text-ink-faint">{t('cap.add.pluginHint')}</p>
                  </div>
                </div>
              </Disclosure>
            </div>
          ) : null}
        </>
      )}
      {sheets}
    </div>
  );
}

/** What an update needs to know about the installed copy. */
type UpdateTarget = Pick<PluginSummary, 'id' | 'displayName' | 'icon' | 'version' | 'enabled'>;

const SHELF_TITLE = {
  featured: 'cap.shelf.featured',
  productivity: 'cap.shelf.productivity',
  coding: 'cap.shelf.coding',
  web: 'cap.shelf.web',
  data: 'cap.shelf.data',
  more: 'cap.shelf.more',
} as const;

function CatalogShelfSection({
  id,
  entries,
  expanded,
  installed,
  relevant,
  updates,
  onOpen,
  onInstall,
  onUpdate,
  onMore,
}: {
  readonly id: CatalogShelfId;
  readonly entries: readonly PluginMarketplaceEntry[];
  /** A single category page or a search: every entry, no overflow link. */
  readonly expanded: boolean;
  readonly installed: readonly PluginSummary[];
  readonly relevant: ReadonlySet<string>;
  readonly updates: ReadonlyMap<string, PluginUpdateView>;
  readonly onOpen: (id: string) => void;
  readonly onInstall: (entry: PluginMarketplaceEntry) => void;
  readonly onUpdate: (plugin: UpdateTarget, update: PluginUpdateView) => void;
  readonly onMore: () => void;
}) {
  const { t } = useI18n();
  const { shown, hidden } = expanded ? { shown: entries, hidden: [] as readonly PluginMarketplaceEntry[] } : shelfOverflow(entries, SHELF_ROWS);
  return (
    <CapabilitySection id={`plugins-shelf-${id}`} title={t(SHELF_TITLE[id])} count={expanded ? entries.length : undefined}>
      <RowGrid>
        {shown.map((entry) => {
          const plugin = installed.find((item) => item.id === entry.id);
          // The catalog can report an install the list has not caught up with yet.
          const update = updates.get(entry.id)
            ?? (entry.updateAvailable === true && entry.installed !== undefined ? { via: 'catalog' as const, source: entry.source, version: entry.version } : undefined);
          const target: UpdateTarget | undefined = plugin
            ?? (entry.installed !== undefined ? { id: entry.id, displayName: entry.displayName, icon: entry.icon, version: entry.installed.version, enabled: entry.installed.enabled } : undefined);
          return (
          <PluginCard
            key={entry.id}
            id={entry.id}
            name={entry.displayName}
            icon={entry.icon}
            line={entry.description ?? ''}
            entry={entry}
            installed={plugin}
            hasUpdate={update !== undefined}
            badge={relevant.has(entry.id) && id === 'featured' && entry.installed === undefined
              ? <Tag>{t('cap.plugins.relevant')}</Tag>
              : entry.tier === 'third-party' ? <Tag tone="warn">{t('cap.tier.thirdParty')}</Tag> : undefined}
            onOpen={() => { onOpen(entry.id); }}
            onInstall={() => { onInstall(entry); }}
            onUpdate={target !== undefined && update !== undefined ? () => { onUpdate(target, update); } : undefined}
          />
          );
        })}
      </RowGrid>
      {hidden.length > 0 ? (
        <button type="button" className={`${QUIET_BUTTON} mt-2 -ml-0.5`} data-plugins-shelf-more={id} onClick={onMore}>
          <span className="flex -space-x-1.5" aria-hidden>
            {hidden.slice(0, 3).map((entry) => (
              <span key={entry.id} className="rounded-[7px] ring-2 ring-paper"><CapabilityIcon icon={entry.icon} size="sm" /></span>
            ))}
          </span>
          {t('cap.plugins.seeMore', { count: hidden.length })}
        </button>
      ) : null}
    </CapabilitySection>
  );
}
