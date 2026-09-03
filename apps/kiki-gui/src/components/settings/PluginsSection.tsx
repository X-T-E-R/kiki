import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { errorText } from '@kiki/session-core/i18n';
import type {
  PluginInfo,
  PluginMarketplaceEntry,
  PluginSummary,
} from '../../lib/client';
import { marketplaceUrlPatch } from '@kiki/session-core/settings';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, DANGER_GHOST_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { useSavedTick } from './useSavedTick';

const BADGE_CLASS =
  'shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px text-[9px] font-medium tracking-wide text-ink-faint uppercase';

type AddTab = 'path' | 'zip' | 'marketplace';

const ADD_TAB_KEYS = {
  path: 'st.plugins.tab.path',
  zip: 'st.plugins.tab.zip',
  marketplace: 'st.plugins.tab.marketplace',
} as const;

function contributionSummary(
  plugin: PluginSummary,
  t: ReturnType<typeof useI18n>['t'],
  tp: ReturnType<typeof useI18n>['tp'],
): string {
  const parts: string[] = [];
  if (plugin.skillCount > 0) parts.push(tp('st.plugins.contrib.skills', plugin.skillCount));
  if (plugin.mcpServerCount > 0) parts.push(tp('st.plugins.contrib.mcp', plugin.mcpServerCount));
  if (plugin.hookCount > 0) parts.push(tp('st.plugins.contrib.hooks', plugin.hookCount));
  if (plugin.commandCount > 0) parts.push(tp('st.plugins.contrib.commands', plugin.commandCount));
  return parts.length === 0 ? t('st.plugins.contrib.none') : parts.join(' · ');
}

function uninstallConsequences(
  plugin: PluginSummary,
  t: ReturnType<typeof useI18n>['t'],
  tp: ReturnType<typeof useI18n>['tp'],
  queryClient: QueryClient,
): readonly string[] {
  const info = queryClient.getQueryData<PluginInfo>(['plugin', plugin.id]);
  const mcpNames = info?.mcpServers.map((server) => server.name) ?? [];
  return [contributionSummary(plugin, t, tp), ...mcpNames];
}

function BusyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="anim-enter flex items-center gap-2 text-[11px] leading-relaxed text-ink-faint">
      <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      {children}
    </p>
  );
}

function QueryRetry({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <InlineError error={error} />
      <button type="button" className={SECONDARY_BUTTON} data-plugins-retry onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}

function PluginDetails({ pluginId }: { pluginId: string }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const infoQuery = useQuery({
    queryKey: ['plugin', pluginId],
    queryFn: () => client.getPlugin(pluginId),
    staleTime: 15_000,
  });
  const info = infoQuery.data;

  if (infoQuery.isPending) return <BusyHint>{t('st.plugins.manifestLoading')}</BusyHint>;
  if (infoQuery.isError) return <QueryRetry error={infoQuery.error} onRetry={() => { void infoQuery.refetch(); }} />;
  if (info === undefined) return null;

  return (
    <div className="mt-2 space-y-2 border-t border-hairline pt-2" data-plugin-details={pluginId}>
      <PluginManifestBlock info={info} />
    </div>
  );
}

function PluginManifestBlock({ info }: { info: PluginInfo }) {
  const { t } = useI18n();
  const mcp = info.mcpServers;
  const diagnostics = info.diagnostics;
  const manifestText = info.manifest === undefined ? undefined : JSON.stringify(info.manifest, null, 2);

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[11px] font-medium text-ink-soft">{t('st.plugins.mcpServers')}</p>
        {mcp.length === 0 ? (
          <Hint>{t('st.plugins.mcpEmpty')}</Hint>
        ) : (
          <ul className="mt-1 space-y-1">
            {mcp.map((server) => (
              <li
                key={server.name}
                className="flex items-center gap-2 rounded-md border border-hairline bg-panel px-2 py-1"
                data-plugin-mcp={server.name}
              >
                <span className="min-w-0 truncate font-mono text-[11px] text-ink">{server.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{server.transport}</span>
                <span className={BADGE_CLASS}>
                  {server.enabled ? t('st.plugins.mcpOn') : t('st.plugins.mcpOff')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {diagnostics.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium text-ink-soft">{t('st.plugins.diagnostics')}</p>
          <ul className="mt-1 space-y-1">
            {diagnostics.map((item, index) => (
              <li
                key={`${item.severity}-${index}`}
                className={`rounded-md border px-2 py-1 text-[11px] ${
                  item.severity === 'error'
                    ? 'border-danger/40 bg-danger/5 text-danger'
                    : 'border-hairline bg-panel text-ink-soft'
                }`}
              >
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {manifestText !== undefined ? (
        <pre className="max-h-48 overflow-auto rounded-md border border-hairline bg-panel px-2 py-1.5 font-mono text-[10px] leading-snug text-ink-soft">
          {manifestText}
        </pre>
      ) : null}
    </div>
  );
}

function PluginRow({
  plugin,
  busyId,
  onToggle,
  onUninstall,
}: {
  plugin: PluginSummary;
  busyId: string | null;
  onToggle: (plugin: PluginSummary, enabled: boolean) => void;
  onUninstall: (plugin: PluginSummary) => void;
}) {
  const { t, tp } = useI18n();
  const [open, setOpen] = useState(false);
  const broken = plugin.state === 'error' || plugin.hasErrors;
  const busy = busyId === plugin.id;

  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2" data-plugin-row={plugin.id}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 truncate text-[13px] font-medium text-ink">{plugin.displayName}</p>
        {plugin.version !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">v{plugin.version}</span>
        ) : null}
        {broken ? (
          <span className="shrink-0 rounded-full border border-danger/40 bg-danger/10 px-1.5 py-px text-[9px] font-medium tracking-wide text-danger uppercase">
            {t('st.plugins.error')}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{contributionSummary(plugin, t, tp)}</p>
      {plugin.originalSource !== undefined ? (
        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={plugin.originalSource}>
          {plugin.originalSource}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Toggle
          label={t('st.plugins.enabled')}
          checked={plugin.enabled}
          disabled={busy}
          onChange={(checked) => { onToggle(plugin, checked); }}
        />
        <button
          type="button"
          className={SECONDARY_BUTTON}
          data-plugin-details-toggle={plugin.id}
          onClick={() => { setOpen((current) => !current); }}
        >
          {open ? t('st.plugins.hideDetails') : t('st.plugins.details')}
        </button>
        <button
          type="button"
          className={DANGER_GHOST_BUTTON}
          disabled={busy}
          data-plugin-uninstall={plugin.id}
          onClick={() => { onUninstall(plugin); }}
        >
          {t('st.plugins.uninstall')}
        </button>
      </div>
      {open ? <PluginDetails pluginId={plugin.id} /> : null}
    </div>
  );
}

function InstalledPluginsCard() {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PluginSummary | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const pluginsQuery = useQuery({
    queryKey: ['plugins'],
    queryFn: () => client.listPlugins(),
    staleTime: 15_000,
  });
  const plugins = pluginsQuery.data?.plugins ?? [];

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['plugins'] }),
      queryClient.invalidateQueries({ queryKey: ['plugin-marketplace'] }),
      queryClient.invalidateQueries({ queryKey: ['plugin'] }),
    ]);
  };

  const toggle = async (plugin: PluginSummary, enabled: boolean) => {
    setBusyId(plugin.id);
    setFeedback(null);
    try {
      await client.setPluginEnabled(plugin.id, enabled);
      await invalidate();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (plugin: PluginSummary) => {
    setBusyId(plugin.id);
    setFeedback(null);
    try {
      await client.removePlugin(plugin.id);
      await invalidate();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SectionCard id="st-card-plugins" title={t('st.plugins.title')}>
      <div className="space-y-2">
        <Hint>{t('st.plugins.hint')}</Hint>
        {pluginsQuery.isPending ? (
          <BusyHint>{t('st.plugins.loading')}</BusyHint>
        ) : pluginsQuery.isError ? (
          <QueryRetry error={pluginsQuery.error} onRetry={() => { void pluginsQuery.refetch(); }} />
        ) : plugins.length === 0 ? (
          <Hint>{t('st.plugins.empty')}</Hint>
        ) : (
          plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              busyId={busyId}
              onToggle={(target, enabled) => { void toggle(target, enabled); }}
              onUninstall={setRemoving}
            />
          ))
        )}
        <FeedbackLine feedback={feedback} />
      </div>
      {removing !== null ? (
        <ConfirmDialog
          open
          overlayId="confirm-plugin-uninstall"
          title={t('st.plugins.uninstallTitle', { name: removing.displayName })}
          body={t('st.plugins.uninstallBody')}
          consequences={uninstallConsequences(removing, t, tp, queryClient)}
          confirmLabel={t('st.plugins.uninstall')}
          tone="danger"
          onCancel={() => { setRemoving(null); }}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void uninstall(target);
          }}
        />
      ) : null}
    </SectionCard>
  );
}

function marketplaceActionKind(
  entry: PluginMarketplaceEntry,
): 'install' | 'installed' | 'update' {
  if (entry.installed === undefined) return 'install';
  return entry.updateAvailable === true ? 'update' : 'installed';
}

function MarketplaceAction({
  entry,
  installingId,
  onInstall,
}: {
  entry: PluginMarketplaceEntry;
  installingId: string | null;
  onInstall: (entry: PluginMarketplaceEntry) => void;
}) {
  const { t } = useI18n();
  const kind = marketplaceActionKind(entry);
  const installing = installingId === entry.id;
  const label = installing
    ? t('st.plugins.installing')
    : kind === 'update'
      ? t('st.plugins.updateAvailable')
      : kind === 'installed'
        ? t('st.plugins.alreadyInstalled')
        : t('st.plugins.installFromMarket');
  const idle = kind === 'installed';
  return (
    <button
      type="button"
      className={`${PRIMARY_BUTTON} mt-2`}
      data-marketplace-action={entry.id}
      data-marketplace-kind={kind}
      disabled={idle || installingId !== null}
      onClick={() => { onInstall(entry); }}
    >
      {label}
    </button>
  );
}

function MarketplaceTab() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [urlDraft, setUrlDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const marketplaceQuery = useQuery({
    queryKey: ['plugin-marketplace'],
    queryFn: () => client.listPluginMarketplace(),
    staleTime: 30_000,
  });

  useEffect(() => {
    setUrlDraft(configQuery.data?.plugins?.marketplaceUrl ?? '');
  }, [configQuery.data]);

  const saveSource = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(marketplaceUrlPatch(urlDraft));
      queryClient.setQueryData(['config'], echoed);
      setUrlDraft(echoed.plugins?.marketplaceUrl ?? '');
      await queryClient.invalidateQueries({ queryKey: ['plugin-marketplace'] });
      ping();
      setFeedback({ tone: 'success', text: t('st.plugins.sourceSaved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const installEntry = async (entry: PluginMarketplaceEntry) => {
    setInstallingId(entry.id);
    setFeedback({ tone: 'info', text: t('st.plugins.installing') });
    try {
      const installed = await client.installPlugin(entry.source);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['plugins'] }),
        queryClient.invalidateQueries({ queryKey: ['plugin-marketplace'] }),
      ]);
      setFeedback({ tone: 'success', text: t('st.plugins.installOk', { name: installed.displayName }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setInstallingId(null);
    }
  };

  const catalog = marketplaceQuery.data;
  const configured = catalog?.configured === true;

  return (
    <div className="space-y-3" data-plugin-add-tab="marketplace">
      <Hint>{t('st.plugins.sourceHint')}</Hint>
      <label className="block text-[11px] font-medium text-ink-soft">
        {t('st.plugins.sourceLabel')}
        <input
          className={`${INPUT} mt-1 font-mono`}
          value={urlDraft}
          placeholder={t('st.plugins.sourcePlaceholder')}
          onChange={(event) => { setUrlDraft(event.target.value); }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => { void saveSource(); }}>
          {saving ? t('common.saving') : t('st.plugins.sourceSave')}
        </button>
        {saved ? <span className="text-[11px] font-medium text-success">{t('st.savedTick')}</span> : null}
      </div>
      {marketplaceQuery.isPending ? (
        <BusyHint>{t('st.plugins.marketplaceLoading')}</BusyHint>
      ) : marketplaceQuery.isError ? (
        <QueryRetry error={marketplaceQuery.error} onRetry={() => { void marketplaceQuery.refetch(); }} />
      ) : !configured ? (
        <div
          className="rounded-lg border border-dashed border-hairline bg-panel px-3 py-4 text-center"
          data-marketplace-empty
        >
          <p className="text-[12px] text-ink-soft">{t('st.plugins.sourceCatalogHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {catalog.source !== undefined ? (
            <p className="truncate font-mono text-[10px] text-ink-faint" title={catalog.source}>
              {t('st.plugins.marketplaceSource', { source: catalog.source })}
            </p>
          ) : null}
          {catalog.entries.length === 0 ? (
            <Hint>{t('st.plugins.marketplaceEmpty')}</Hint>
          ) : (
            catalog.entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-hairline bg-paper px-3 py-2"
                data-marketplace-row={entry.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-[13px] font-medium text-ink">{entry.displayName}</p>
                  {entry.version !== undefined ? (
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">v{entry.version}</span>
                  ) : null}
                  <span className={BADGE_CLASS}>{entry.tier}</span>
                  {entry.updateAvailable === true ? (
                    <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px text-[9px] font-medium tracking-wide text-accent uppercase">
                      {t('st.plugins.updateAvailable')}
                    </span>
                  ) : null}
                </div>
                {entry.description !== undefined ? (
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{entry.description}</p>
                ) : null}
                <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={entry.source}>
                  {entry.source}
                </p>
                <MarketplaceAction
                  entry={entry}
                  installingId={installingId}
                  onInstall={installEntry}
                />
              </div>
            ))
          )}
        </div>
      )}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function SourceInstallTab({ kind }: { kind: 'path' | 'zip' }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const host = useHost();
  const [source, setSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const canPick = kind === 'path' && host.pickDirectory !== undefined;

  const pick = async () => {
    setSelecting(true);
    setFeedback(null);
    try {
      const selected = await host.pickDirectory?.();
      if (selected !== undefined && selected !== null) setSource(selected);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSelecting(false);
    }
  };

  const install = async () => {
    const trimmed = source.trim();
    if (trimmed.length === 0) return;
    setInstalling(true);
    setFeedback({ tone: 'info', text: t('st.plugins.installing') });
    try {
      const installed = await client.installPlugin(trimmed);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['plugins'] }),
        queryClient.invalidateQueries({ queryKey: ['plugin-marketplace'] }),
      ]);
      setSource('');
      setFeedback({ tone: 'success', text: t('st.plugins.installOk', { name: installed.displayName }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-3" data-plugin-add-tab={kind}>
      <label className="block text-[11px] font-medium text-ink-soft">
        {kind === 'path' ? t('st.plugins.pathLabel') : t('st.plugins.zipLabel')}
        <input
          className={`${INPUT} mt-1 font-mono`}
          value={source}
          placeholder={kind === 'path' ? t('st.plugins.pathPlaceholder') : t('st.plugins.zipPlaceholder')}
          onChange={(event) => { setSource(event.target.value); }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {canPick ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={selecting || installing} onClick={() => { void pick(); }}>
            {t('st.plugins.pickPath')}
          </button>
        ) : null}
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={installing || source.trim().length === 0}
          onClick={() => { void install(); }}
        >
          {installing ? t('st.plugins.installing') : t('st.plugins.install')}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function AddPluginCard() {
  const { t } = useI18n();
  const [tab, setTab] = useState<AddTab>('path');
  const tabs: readonly AddTab[] = ['path', 'zip', 'marketplace'];

  return (
    <SectionCard id="st-card-plugins-add" title={t('st.plugins.addTitle')}>
      <div className="space-y-3">
        <Hint>{t('st.plugins.addHint')}</Hint>
        <div role="tablist" aria-label={t('st.plugins.addTitle')} className="flex gap-1 border-b border-hairline">
          {tabs.map((candidate) => {
            const active = candidate === tab;
            return (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={active}
                data-plugin-add-tab-button={candidate}
                onClick={() => { setTab(candidate); }}
                className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${
                  active
                    ? 'border-accent font-medium text-ink'
                    : 'border-transparent text-ink-soft hover:text-ink'
                }`}
              >
                {t(ADD_TAB_KEYS[candidate])}
              </button>
            );
          })}
        </div>
        {tab === 'marketplace' ? <MarketplaceTab /> : <SourceInstallTab kind={tab} />}
      </div>
    </SectionCard>
  );
}

/**
 * Plugins leaf (redesign §12 batch 5): installed plugins with enable / disable /
 * uninstall / manifest inspection, plus an add card for local path, zip URL, and
 * a user-configured marketplace (empty source is a how-to, not an error).
 */
export function PluginsSection() {
  return (
    <div className="space-y-4">
      <InstalledPluginsCard />
      <AddPluginCard />
    </div>
  );
}
