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

import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { useImportHistoryEnabled } from '../../lib/importHistory';
import { localizeEntry, pluginUpdate, shelveCatalog, type CatalogShelfId, type PluginUpdateView } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { Icon, Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { AddSourceDialog, CatalogSourceField } from './AddSourceDialog';
import { ImportHistoryView } from './ImportHistoryView';
import { MediaSourcesView } from '../media/MediaSourcesView';
import { InstalledList } from './InstalledList';
import { InstallFlow, type InstallRequest } from './InstallFlow';
import { PluginCard } from './PluginCard';
import { PluginDetail } from './PluginDetail';
import { CapabilitySection, Disclosure, EmptyNote, QUIET_BUTTON, RowGrid, SearchField, Segmented, Tag } from './primitives';
import { useInstalledPlugins, usePluginGithubUpdates, usePluginMarketplace, usePluginRecommendations, type PluginSubject } from './usePlugins';



export type PluginsRoute =
  | { readonly view: 'market' }
  | { readonly view: 'installed' }
  | { readonly view: 'detail'; readonly id: string }
  /** History import: the session-source importers, and the archives they wrote. */
  | { readonly view: 'import'; readonly sourceId?: string; readonly sourcePluginId?: string }
  /** The media surface, reached through the media plugin's own entry. */
  | { readonly view: 'media' };

export function PluginsView({
  route,
  onRoute,
  workspaceRoot,
  onOpenPanel,
  onOpenSession,
  sessionId,
  onOpenSettings,
}: {
  readonly route: PluginsRoute;
  readonly onRoute: (next: PluginsRoute) => void;
  /** Root of the workspace in focus; the only task signal sent for suggestions. */
  readonly workspaceRoot?: string;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
  /**
   * A plugin's configuration lives on its own settings page, which this view
   * links to rather than embedding. Unset where that page is unreachable, so
   * a build without the settings route shows no dead control.
   */
  readonly onOpenSettings?: (pluginId: string) => void;
  /** Continue a finished native import on the normal session route. */
  readonly onOpenSession?: (sessionId: string) => void;
  /** Session whose media jobs this view lists; without one, no job list. */
  readonly sessionId?: string;
}) {
  const { t, tp, locale, time } = useI18n();
  const { client, scopeId } = useConnection();
  // The entry exists only where the server offers the import routes, so a build
  // without them shows no dead control.
  const importAvailable = useImportHistoryEnabled(client, scopeId).enabled === true;
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
    // The catalog's own digest travels with the request: a published archive
    // is only installable when the installer can verify it.
    setInstall({ source: entry.source, sha256: entry.sha256, displayName: entry.displayName, icon: entry.icon, entry });
  };
  /** Every update goes through the same preview sheet; nothing installs here. */
  const startUpdate = (plugin: UpdateTarget, update: PluginUpdateView) => {
    const entry = entries.find((candidate) => candidate.id === plugin.id);
    setInstall({
      source: update.source,
      sha256: update.sha256,
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

  if (route.view === 'import') {
    return (
      <div data-plugins-view="import">
        <ImportHistoryView
          initialSourceId={route.sourceId}
          initialSourcePluginId={route.sourcePluginId}
          onOpenPlugin={open}
          onOpenSession={onOpenSession}
          onBack={() => { onRoute({ view: 'installed' }); }}
        />
        {sheets}
      </div>
    );
  }

  if (route.view === 'media') {
    return (
      <div data-plugins-view="media">
        <MediaSourcesView
          sessionId={sessionId}
          onBack={() => { onRoute({ view: 'installed' }); }}
          // The media source's provider is a plugin, and a plugin's settings
          // live on their own settings page. The button the media surface owns
          // is unchanged; this is the one place its destination is decided, so
          // it goes through the same helper as every other entry to a plugin's
          // settings.
          onOpenPlugin={onOpenSettings}
        />
        {sheets}
      </div>
    );
  }

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
          onOpenImport={importAvailable
            ? (source) => { onRoute({ view: 'import', sourceId: source.sourceId, sourcePluginId: source.pluginId }); }
            : undefined}
          onOpenMedia={() => { onRoute({ view: 'media' }); }}
          onOpenSettings={onOpenSettings}
        />
        {sheets}
      </>
    );
  }

  const tab = route.view === 'installed' ? 'installed' : 'market';
  const filtering = query.trim() !== '';
  const relevant = new Set((recommendQuery.data?.entries ?? []).map((entry) => entry.id));
  const shelves = shelveCatalog(entries, query, relevant);
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
          {tab === 'market' ? (
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={t('cap.plugins.search')}
              ariaLabel={t('cap.plugins.search')}
            />
          ) : null}
        </div>
        {/* No import button here on purpose. Bringing an old conversation in
            is a way of working with sessions and it ships with Kiki, so it is
            offered from Settings → Sessions (and beside the new-session
            starters) rather than as a control on the plugin market, where it
            would read as a plugin to install. `?view=import` still resolves, so
            an old link and a source plugin's "import from here" both land on
            the same built-in surface. */}
      </div>

      {tab === 'installed' ? (
        <InstalledList
          plugins={installed}
          entries={entries}
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
          {attention > 0 && !filtering ? (
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
              {shelves.map((shelf) => (
                <CatalogShelfSection
                  key={shelf.group ?? shelf.id}
                  id={shelf.id}
                  group={shelf.group}
                  entries={shelf.entries}
                  installed={installed}
                  updates={updates}
                  onOpen={open}
                  onInstall={startInstall}
                  onUpdate={startUpdate}
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
  recommended: 'cap.shelf.recommended',
  official: 'cap.shelf.official',
  community: 'cap.shelf.community',
  more: 'cap.shelf.more',
} as const;

/**
 * A catalog-declared sub-group is a machine key, so it is never printed raw.
 * A group the UI has a title for uses that title; any other group is titled by
 * its own entries, so a new group in the catalog still reads as a heading
 * rather than as a leaked field value.
 */
const GROUP_TITLE: Readonly<Record<string, I18nKey>> = {
  media: 'cap.shelf.media',
};

function groupHeading(group: string, entries: readonly PluginMarketplaceEntry[], t: (key: I18nKey) => string): string {
  const known = GROUP_TITLE[group];
  if (known !== undefined) return t(known);
  const lead = entries.find((entry) => entry.group === group);
  return lead === undefined ? group : lead.displayName;
}

/**
 * One catalog block. Every entry in a shelf is listed: the catalog is short
 * enough to read, and hiding an official package behind a "see more" is how a
 * user concludes it does not exist. A catalog-declared sub-group gets its own
 * block so a package family reads together.
 */
function CatalogShelfSection({
  id,
  group,
  entries,
  installed,
  updates,
  onOpen,
  onInstall,
  onUpdate,
}: {
  readonly id: CatalogShelfId;
  readonly group?: string;
  readonly entries: readonly PluginMarketplaceEntry[];
  readonly installed: readonly PluginSummary[];
  readonly updates: ReadonlyMap<string, PluginUpdateView>;
  readonly onOpen: (id: string) => void;
  readonly onInstall: (entry: PluginMarketplaceEntry) => void;
  readonly onUpdate: (plugin: UpdateTarget, update: PluginUpdateView) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <CapabilitySection
      id={group === undefined ? `plugins-shelf-${id}` : `plugins-shelf-${id}-${group}`}
      title={group === undefined ? t(SHELF_TITLE[id]) : groupHeading(group, entries, t)}
      count={entries.length}
    >
      <RowGrid>
        {entries.map((entry) => {
          const plugin = installed.find((item) => item.id === entry.id);
          // The catalog can report an install the list has not caught up with yet.
          const update = updates.get(entry.id)
            ?? (entry.updateAvailable === true && entry.installed !== undefined
              ? { via: 'catalog' as const, source: entry.source, version: entry.version, sha256: entry.sha256 }
              : undefined);
          const text = localizeEntry(entry, locale);
          const target: UpdateTarget | undefined = plugin
            ?? (entry.installed !== undefined ? { id: entry.id, displayName: text.displayName, icon: entry.icon, version: entry.installed.version, enabled: entry.installed.enabled } : undefined);
          return (
            <PluginCard
              key={entry.id}
              id={entry.id}
              name={text.displayName}
              icon={entry.icon}
              line={text.description ?? ''}
              entry={entry}
              installed={plugin}
              hasUpdate={update !== undefined}
              badge={id === 'recommended' && entry.installed === undefined
                ? <Tag>{t('cap.plugins.relevant')}</Tag>
                : entry.tier === 'third-party' ? <Tag tone="warn">{t('cap.tier.thirdParty')}</Tag> : undefined}
              onOpen={() => { onOpen(entry.id); }}
              onInstall={entry.installable === false ? undefined : () => { onInstall(entry); }}
              onUpdate={target !== undefined && update !== undefined ? () => { onUpdate(target, update); } : undefined}
            />
          );
        })}
      </RowGrid>
    </CapabilitySection>
  );
}
