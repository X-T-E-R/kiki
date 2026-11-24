import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type {
  PortableSpaceEndpoint,
  PortableSpaceExportReceipt,
  PortableSpaceMode,
  PortableSpaceSourceRecord,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { copyTextToClipboard } from '../../../lib/clipboard';
import {
  buildColabCommand,
  endpointSubtitle,
  portableSpaceKeys,
  portableSpacesApi,
  usePortableSources,
} from '../../../lib/portableSpaces';
import { MAIN_SPACE_ID, type SpaceListItem } from '../../../lib/spaces';
import { pushToast } from '../../../lib/toasts';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { DetailRailGroup, DetailRailItem, DetailSplit, useDetailParam } from '../../overlays';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { LIST_ROW_HEIGHT, ListBody } from '../list';
import { ExportSpacePanel } from './ExportSpacePanel';
import { LinkSourcePanel } from './LinkSourcePanel';
import { PortablePackDialog } from './PortablePackDialog';
import { PortableSpaceDetail, type PortableDetailTab } from './PortableSpaceDetail';
import { SpaceRowMenu, type SpaceMenuItem } from './SpaceRowMenu';

export interface PortableExportRequest {
  readonly intent: 'export' | 'fork';
  readonly source?: PortableSpaceEndpoint;
  readonly mode?: PortableSpaceMode;
}

export interface PortableSpacesCardProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly spaces: readonly SpaceListItem[];
  readonly mainPath: string;
  readonly externalExportRequest?: PortableExportRequest | null;
  readonly onClearExternalExport?: () => void;
  readonly initialSubscribeUrl?: string | null;
  readonly onClearInitialSubscribe?: () => void;
}

export function PortableSpacesCard({
  client,
  token,
  spaces,
  mainPath,
  externalExportRequest,
  onClearExternalExport,
  initialSubscribeUrl,
  onClearInitialSubscribe,
}: PortableSpacesCardProps) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const detail = useDetailParam('portable');
  const sourcesQuery = usePortableSources(client, token);

  const [exportPanel, setExportPanel] = useState<PortableExportRequest | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pendingSubscribeUrl, setPendingSubscribeUrl] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [packDialog, setPackDialog] = useState<{ source: PortableSpaceSourceRecord; action: 'pack' | 'unpack' } | null>(null);
  const [menu, setMenu] = useState<{ source: PortableSpaceSourceRecord; anchor: DOMRect; anchorElement: HTMLElement } | null>(null);
  const [detailTab, setDetailTab] = useState<PortableDetailTab>('contents');
  const [comparePreset, setComparePreset] = useState<{ mode: 'sync' | 'merge' | 'override'; right?: PortableSpaceEndpoint }>({
    mode: 'sync',
  });
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (externalExportRequest !== undefined && externalExportRequest !== null) {
      setExportPanel(externalExportRequest);
      onClearExternalExport?.();
    }
  }, [externalExportRequest, onClearExternalExport]);

  useEffect(() => {
    if (initialSubscribeUrl !== undefined && initialSubscribeUrl !== null && initialSubscribeUrl.trim() !== '') {
      setPendingSubscribeUrl(initialSubscribeUrl.trim());
      setLinkOpen(true);
      onClearInitialSubscribe?.();
    }
  }, [initialSubscribeUrl, onClearInitialSubscribe]);

  const items = sourcesQuery.data?.items ?? [];
  const deviceRecipient = sourcesQuery.data?.deviceRecipient;
  const selectedSource = detail.selected === null ? undefined : items.find((item) => item.id === detail.selected);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: portableSpaceKeys.all });
  }, [queryClient]);

  const openDetail = (source: PortableSpaceSourceRecord, tab: PortableDetailTab, preset?: { mode: 'sync' | 'merge' | 'override'; right?: PortableSpaceEndpoint }) => {
    setDetailTab(tab);
    if (preset !== undefined) setComparePreset(preset);
    detail.open(source.id);
  };

  const removeSource = (source: PortableSpaceSourceRecord) => {
    setFeedback(null);
    void portableSpacesApi(client, { token })
      .removeSource(source.id)
      .then(() => {
        if (detail.selected === source.id) detail.close();
        refresh();
        pushToast({ tone: 'success', text: t('st.portable.removeSourceDone', { name: source.label }) });
      })
      .catch((error: unknown) => {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      });
  };

  const copyColab = (source: PortableSpaceSourceRecord) => {
    const command = buildColabCommand({ source: source.endpoint });
    void copyTextToClipboard(command)
      .then(() => { pushToast({ tone: 'success', text: t('st.portable.colabCopied') }); })
      .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); });
  };

  const syncSubscriptionNow = (source: PortableSpaceSourceRecord) => {
    if (syncingId !== null) return;
    setSyncingId(source.id);
    setFeedback(null);
    void portableSpacesApi(client, { token })
      .syncSubscription(source.id, { force: false, createBackup: true })
      .then((result) => {
        refresh();
        if (result.status === 'error') {
          const text = t('st.portable.syncError', { error: result.error ?? 'Unknown error' });
          setFeedback({ tone: 'error', text });
          pushToast({ tone: 'error', text });
        } else if (result.status === 'not_modified') {
          const text = t('st.portable.syncNotModified', { name: source.label });
          setFeedback({ tone: 'info', text });
          pushToast({ tone: 'info', text });
        } else {
          const count = result.appliedIds.length + result.deletedIds.length;
          const text = t('st.portable.syncUpdated', { name: source.label, count });
          setFeedback({ tone: 'success', text });
          pushToast({ tone: 'success', text });
        }
      })
      .catch((error: unknown) => {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      })
      .finally(() => {
        setSyncingId(null);
      });
  };

  const kindBadgeText = (source: PortableSpaceSourceRecord): string => {
    if (source.endpoint.kind === 'url') return t('st.portable.badge.url');
    if (source.spaceMode === 'overlay') return t('st.portable.badge.overlay');
    if (source.endpoint.kind === 'git') return t('st.portable.badge.git');
    if (source.format === 'age') return '.kiki.age';
    if (source.format === 'tgz') return t('st.portable.badge.tgz');
    return t('st.portable.badge.dir');
  };

  const secretBadgeText = (source: PortableSpaceSourceRecord): string => {
    if (source.secretMode === 'none') return t('st.portable.badge.secretNone');
    if (source.secretMode === 'plain') return t('st.portable.badge.secretPlain');
    if (source.secretMode === 'sealed' || source.format === 'age' || (source.encryptionMode !== undefined && source.encryptionMode !== 'none')) {
      return t('st.portable.badge.secretEncrypted');
    }
    return t('st.portable.badge.secretNone');
  };

  const menuItems = (source: PortableSpaceSourceRecord): SpaceMenuItem[] => {
    const canPack = source.endpoint.kind === 'dir' && source.format === 'dir';
    const canUnpack = source.endpoint.kind === 'archive' && (source.format === 'age' || source.format === 'tgz');
    return [
      {
        key: 'fork',
        label: t('st.portable.forkMenu'),
        run: () => { setExportPanel({ intent: 'fork', source: source.endpoint, mode: 'full' }); },
      },
      ...(canPack ? [{
        key: 'pack',
        label: t('st.portable.packAction'),
        run: () => { setPackDialog({ source, action: 'pack' }); },
      }] : []),
      ...(canUnpack ? [{
        key: 'unpack',
        label: t('st.portable.unpackAction'),
        run: () => { setPackDialog({ source, action: 'unpack' }); },
      }] : []),
      {
        key: 'copy-colab',
        label: t('st.portable.copyColabMenu'),
        run: () => { copyColab(source); },
      },
      {
        key: 'remove',
        label: t('st.portable.removeSource'),
        danger: true,
        separatorBefore: true,
        run: () => { removeSource(source); },
      },
    ];
  };

  const renderRow = (source: PortableSpaceSourceRecord) => {
    const subtitle = endpointSubtitle(source.endpoint, source.gitBranch);
    const isUrl = source.endpoint.kind === 'url';
    const iconName = isUrl ? 'web' : source.endpoint.kind === 'git' ? 'branch' : source.format === 'age' ? 'lock' : 'folder';
    const isPlainSecret = source.secretMode === 'plain';
    return (
      <div
        data-portable-source-row={source.id}
        style={{ minHeight: LIST_ROW_HEIGHT.comfortable }}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:flex-nowrap"
      >
        <Icon name={iconName} size={14} className="text-ink-faint" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <button
              type="button"
              data-detail-trigger={source.id}
              onClick={() => { openDetail(source, 'contents'); }}
              title={source.label}
              className="min-w-0 shrink truncate rounded text-left text-[13px] font-medium text-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
            >
              {source.label}
            </button>
            <span
              data-portable-kind-badge={source.id}
              className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-px text-[11px] font-medium text-ink-soft"
            >
              {kindBadgeText(source)}
            </span>
            {isUrl && source.autoSync !== false ? (
              <span
                data-portable-autosync-badge={source.id}
                className="shrink-0 rounded bg-ink/[0.04] px-1.5 py-px text-[11px] text-ink-faint"
              >
                {t('st.portable.autoSyncBadge')}
              </span>
            ) : null}
            <span
              data-portable-secret-badge={source.id}
              className={`shrink-0 rounded px-1.5 py-px text-[11px] ${
                isPlainSecret ? 'bg-amber-card font-medium text-amber-ink' : 'bg-ink/[0.04] text-ink-faint'
              }`}
            >
              {secretBadgeText(source)}
            </span>
          </div>
          <p className="truncate font-mono text-[11.5px] text-ink-faint" title={subtitle}>{subtitle}</p>
          {isUrl && source.lastSyncError ? (
            <p className="truncate text-[11.5px] text-danger-ink" data-portable-sync-error={source.id}>
              {t('st.portable.syncError', { error: source.lastSyncError })}
            </p>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {isUrl ? (
            <button
              type="button"
              data-portable-sync-now={source.id}
              disabled={syncingId !== null}
              className={SECONDARY_BUTTON}
              onClick={() => { syncSubscriptionNow(source); }}
            >
              {syncingId === source.id ? t('st.portable.syncing') : t('st.portable.syncNow')}
            </button>
          ) : null}
          <button
            type="button"
            data-portable-compare={source.id}
            className={SECONDARY_BUTTON}
            onClick={() => { openDetail(source, 'compare', { mode: 'sync' }); }}
          >
            {t('st.portable.compare')}
          </button>
          {!isUrl ? (
            <button
              type="button"
              data-portable-apply={source.id}
              className={SECONDARY_BUTTON}
              onClick={() => {
                openDetail(source, 'compare', { mode: 'merge', right: { kind: 'live', spaceId: MAIN_SPACE_ID } });
              }}
            >
              {t('st.portable.apply')}
            </button>
          ) : null}
          <button
            type="button"
            data-portable-menu={source.id}
            aria-haspopup="menu"
            aria-label={t('st.portable.menuAria', { name: source.label })}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            onClick={(event) => {
              setMenu({ source, anchor: event.currentTarget.getBoundingClientRect(), anchorElement: event.currentTarget });
            }}
          >
            <Icon name="more" size={14} />
          </button>
        </div>
      </div>
    );
  };

  const handleExportDone = (receipt: PortableSpaceExportReceipt) => {
    const wasFork = exportPanel?.intent === 'fork';
    setExportPanel(null);
    refresh();
    const baseText = wasFork
      ? t('st.portable.forkDone', { path: receipt.destination })
      : t('st.portable.exportDone', { count: receipt.totalItems, path: receipt.destination });
    const excludedSuffix = receipt.excluded?.length
      ? ` (${receipt.excluded.map((entry) => `${entry.path}: ${entry.reason}`).join('; ')})`
      : '';
    const text = `${baseText}${excludedSuffix}`;
    setFeedback({ tone: 'success', text });
    pushToast({ tone: 'success', text });
  };

  const listContent = (
    <div className="space-y-3" data-portable-sources-list>
      {sourcesQuery.isLoading ? <Hint>{t('st.portable.loading')}</Hint> : null}
      {sourcesQuery.isError ? <InlineError error={sourcesQuery.error} /> : null}

      {items.length > 0 ? (
        <ListBody
          items={items}
          keyOf={(item) => item.id}
          density="comfortable"
          label={t('st.portable.title')}
          renderRow={renderRow}
        />
      ) : sourcesQuery.isSuccess ? (
        <p className="text-[13px] text-ink-soft" data-portable-empty>{t('st.portable.empty')}</p>
      ) : null}

      <FeedbackLine feedback={feedback} />
    </div>
  );

  const rail = (
    <DetailRailGroup label={t('st.portable.title')} count={items.length}>
      {items.map((item) => (
        <DetailRailItem
          key={item.id}
          itemKey={item.id}
          label={item.label}
          hint={kindBadgeText(item)}
          current={item.id === selectedSource?.id}
          onSelect={() => { openDetail(item, detailTab); }}
        />
      ))}
    </DetailRailGroup>
  );

  const detailPane = selectedSource === undefined ? null : (
    <PortableSpaceDetail
      key={selectedSource.id}
      client={client}
      token={token}
      source={selectedSource}
      spaces={spaces}
      portableSources={items}
      deviceRecipient={deviceRecipient}
      tab={detailTab}
      compareMode={comparePreset.mode}
      compareRightEndpoint={comparePreset.right}
      onTabChange={setDetailTab}
      onClose={detail.close}
      onFork={(source) => { setExportPanel({ intent: 'fork', source: source.endpoint, mode: 'full' }); }}
      onPackUnpack={(source, action) => { setPackDialog({ source, action }); }}
      onMutated={refresh}
    />
  );

  return (
    <SectionCard
      id="st-card-portable-spaces"
      title={t('st.portable.title')}
      scope="server"
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-portable-export-open
            className={PRIMARY_BUTTON}
            onClick={() => { setExportPanel({ intent: 'export', source: { kind: 'live', spaceId: MAIN_SPACE_ID } }); }}
          >
            {t('st.portable.export')}
          </button>
          <button
            type="button"
            data-portable-link-open
            className={SECONDARY_BUTTON}
            onClick={() => { setLinkOpen(true); }}
          >
            {t('st.portable.link')}
          </button>
        </div>
      )}
    >
      <DetailSplit
        selected={selectedSource?.id ?? null}
        label={t('st.portable.title')}
        data={{ 'data-portable-split': '' }}
        list={listContent}
        rail={rail}
        detail={detailPane}
      />

      {menu !== null ? (
        <SpaceRowMenu
          anchor={menu.anchor}
          anchorElement={menu.anchorElement}
          items={menuItems(menu.source)}
          onClose={() => { setMenu(null); }}
          ariaLabel={t('st.portable.menuAria', { name: menu.source.label })}
        />
      ) : null}

      {exportPanel !== null ? (
        <ExportSpacePanel
          client={client}
          token={token}
          spaces={spaces}
          portableSources={items}
          deviceRecipient={deviceRecipient}
          mainPath={mainPath}
          intent={exportPanel.intent}
          initialSource={exportPanel.source}
          initialMode={exportPanel.mode}
          onClose={() => { setExportPanel(null); }}
          onDone={handleExportDone}
        />
      ) : null}

      {linkOpen ? (
        <LinkSourcePanel
          client={client}
          token={token}
          initialKind={pendingSubscribeUrl !== null ? 'url' : undefined}
          initialTarget={pendingSubscribeUrl ?? undefined}
          onClose={() => {
            setLinkOpen(false);
            setPendingSubscribeUrl(null);
          }}
          onDone={(record, syncResult) => {
            setLinkOpen(false);
            setPendingSubscribeUrl(null);
            refresh();
            const text = syncResult !== undefined
              ? t('st.portable.subscribeDone', { name: record.label, count: syncResult.appliedIds.length + syncResult.deletedIds.length })
              : t('st.portable.linkDone', { name: record.label });
            setFeedback({ tone: 'success', text });
            pushToast({ tone: 'success', text });
          }}
        />
      ) : null}

      {packDialog !== null ? (
        <PortablePackDialog
          client={client}
          token={token}
          source={packDialog.source}
          action={packDialog.action}
          deviceRecipient={deviceRecipient}
          onClose={() => { setPackDialog(null); }}
          onDone={(receipt) => {
            const wasPack = packDialog.action === 'pack';
            setPackDialog(null);
            refresh();
            const text = t(wasPack ? 'st.portable.packDone' : 'st.portable.unpackDone', { path: receipt.destination });
            setFeedback({ tone: 'success', text });
            pushToast({ tone: 'success', text });
          }}
        />
      ) : null}
    </SectionCard>
  );
}
