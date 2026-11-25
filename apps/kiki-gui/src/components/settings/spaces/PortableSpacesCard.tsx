import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type {
  PortableSpaceCenterSource,
  PortableSpaceEndpoint,
  PortableSpaceExportReceipt,
  PortableSpaceMode,
  PortableSpaceSourceRecord,
  PortableSpaceStoredSyncPolicy,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { copyTextToClipboard } from '../../../lib/clipboard';
import {
  buildColabCommand,
  endpointSubtitle,
  isPortableHostUnsupportedError,
  isSupportedPortableArchivePath,
  portableSpaceKeys,
  portableSpacesApi,
  usePortableCenterSources,
} from '../../../lib/portableSpaces';
import { MAIN_SPACE_ID, type SpaceListItem } from '../../../lib/spaces';
import type { PendingSubscribeIntent } from '../../../lib/subscribeIntent';
import { pushToast } from '../../../lib/toasts';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../../controls';
import { Dialog, DIALOG_SHEET_OVERLAY_CLASS } from '../../Dialog';
import { Icon } from '../../icons';
import { DetailRailGroup, DetailRailItem, DetailSplit, useDetailParam } from '../../overlays';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { LIST_ROW_HEIGHT, ListBody } from '../list';
import { ExportSpacePanel } from './ExportSpacePanel';
import { PortablePackDialog } from './PortablePackDialog';
import { PortableSpaceDetail, type PortableDetailTab } from './PortableSpaceDetail';
import { RemoveSubscriptionDialog } from './RemoveSubscriptionDialog';
import { SpaceRowMenu, type SpaceMenuItem } from './SpaceRowMenu';
import { SubscribeModal, type SubscribeModalMode, type SubscribeModalResult } from './SubscribeModal';

const UNFRAMED_RENAME_PANEL_CLASS =
  'anim-enter w-full max-w-[460px] rounded-xl bg-paper p-6 text-ink outline-none max-md:max-w-none max-md:rounded-b-none max-md:pb-[calc(1.5rem+var(--kiki-safe-bottom-inset))]';

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
  readonly initialSubscribeIntent?: PendingSubscribeIntent | null;
  readonly initialSubscribeUrl?: string | null;
  readonly onClearInitialSubscribe?: () => void;
}

function formatShortRelativeTime(iso: string | undefined, locale: string): string | null {
  if (iso === undefined) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return locale.startsWith('zh') ? '刚刚' : 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return locale.startsWith('zh') ? `${diffMin} 分钟前` : `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return locale.startsWith('zh') ? `${diffHr} 小时前` : `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return locale.startsWith('zh') ? `${diffDay} 天前` : `${diffDay}d ago`;
}

function effectivePolicy(source: PortableSpaceCenterSource): PortableSpaceStoredSyncPolicy {
  if (source.syncPolicy === 'auto' || source.syncPolicy === 'manual') return source.syncPolicy;
  return source.autoSync === false ? 'manual' : 'auto';
}

export function PortableSpacesCard({
  client,
  spaces,
  mainPath,
  externalExportRequest,
  onClearExternalExport,
  initialSubscribeIntent,
  initialSubscribeUrl,
  onClearInitialSubscribe,
}: PortableSpacesCardProps) {
  const host = useHost();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const detail = useDetailParam('portable');
  const sourcesQuery = usePortableCenterSources(client);

  const [exportPanel, setExportPanel] = useState<PortableExportRequest | null>(null);
  const [subscribeModal, setSubscribeModal] = useState<SubscribeModalMode | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PortableSpaceCenterSource | null>(null);
  const [renameTarget, setRenameTarget] = useState<PortableSpaceCenterSource | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [patchingId, setPatchingId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const [packDialog, setPackDialog] = useState<{ source: PortableSpaceSourceRecord; action: 'pack' | 'unpack' } | null>(null);
  const [menu, setMenu] = useState<{ source: PortableSpaceCenterSource; anchor: DOMRect; anchorElement: HTMLElement } | null>(null);
  const [detailTab, setDetailTab] = useState<PortableDetailTab>('contents');
  const [comparePreset, setComparePreset] = useState<{ mode: 'sync' | 'merge' | 'override'; right?: PortableSpaceEndpoint }>({
    mode: 'sync',
  });
  const [feedback, setFeedback] = useState<Feedback>(null);

  const sectionContainerRef = useRef<HTMLDivElement>(null);

  // Clear stale operation feedback whenever the local control client changes.
  useEffect(() => {
    setFeedback(null);
  }, [client]);

  useEffect(() => {
    if (externalExportRequest !== undefined && externalExportRequest !== null) {
      setExportPanel(externalExportRequest);
      onClearExternalExport?.();
    }
  }, [externalExportRequest, onClearExternalExport]);

  useEffect(() => {
    if (initialSubscribeIntent !== undefined && initialSubscribeIntent !== null) {
      setSubscribeModal({ kind: 'new', initialIntent: initialSubscribeIntent });
      onClearInitialSubscribe?.();
    } else if (initialSubscribeUrl !== undefined && initialSubscribeUrl !== null && initialSubscribeUrl.trim() !== '') {
      setSubscribeModal({
        kind: 'new',
        initialIntent: { id: `prop-url-${initialSubscribeUrl}`, url: initialSubscribeUrl.trim(), origin: 'query' },
      });
      onClearInitialSubscribe?.();
    }
  }, [initialSubscribeIntent, initialSubscribeUrl, onClearInitialSubscribe]);

  // Scoped native file drop onto the Portable Spaces section.
  useEffect(() => {
    if (host.onFileDrop === undefined || subscribeModal !== null) return undefined;
    return host.onFileDrop((drop) => {
      const container = sectionContainerRef.current;
      if (container === null) return;
      if (drop.position !== undefined) {
        const rect = container.getBoundingClientRect();
        const inside =
          drop.position.x >= rect.left
          && drop.position.x <= rect.right
          && drop.position.y >= rect.top
          && drop.position.y <= rect.bottom;
        if (!inside) return;
      }
      if (drop.paths.length !== 1 || !isSupportedPortableArchivePath(drop.paths[0] ?? '')) {
        setFeedback({ tone: 'error', text: t('st.portable.center.dropInvalid') });
        return;
      }
      setFeedback(null);
      setSubscribeModal({ kind: 'new', initialArchivePath: drop.paths[0]!, initialTab: 'archive' });
    });
  }, [host, subscribeModal, t]);

  const rawItems = sourcesQuery.data?.items ?? [];
  const orderRevision = sourcesQuery.data?.orderRevision ?? '0';
  const deviceRecipient = sourcesQuery.data?.deviceRecipient;

  // Preserve URL subscription priority order per target space; non-URL rows follow.
  const items = useMemo(() => {
    const urlRows = rawItems
      .filter((item) => item.endpoint.kind === 'url')
      .slice()
      .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
    const otherRows = rawItems.filter((item) => item.endpoint.kind !== 'url');
    return [...urlRows, ...otherRows];
  }, [rawItems]);

  const urlGroupsBySpace = useMemo(() => {
    const map = new Map<string, PortableSpaceCenterSource[]>();
    for (const item of items) {
      if (item.endpoint.kind !== 'url') continue;
      const spaceId = item.linkedSpaceId ?? MAIN_SPACE_ID;
      const list = map.get(spaceId) ?? [];
      list.push(item);
      map.set(spaceId, list);
    }
    return map;
  }, [items]);

  const enabledUrlSources = useMemo(
    () => items.filter((item) => item.endpoint.kind === 'url' && item.enabled),
    [items],
  );

  const selectedSource = detail.selected === null ? undefined : items.find((item) => item.id === detail.selected);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: portableSpaceKeys.all });
  }, [queryClient]);

  const openDetail = (
    source: PortableSpaceCenterSource,
    tab: PortableDetailTab,
    preset?: { mode: 'sync' | 'merge' | 'override'; right?: PortableSpaceEndpoint },
  ) => {
    setDetailTab(tab);
    if (preset !== undefined) setComparePreset(preset);
    detail.open(source.id);
  };

  const removeNonUrlSource = (source: PortableSpaceCenterSource) => {
    setFeedback(null);
    void portableSpacesApi(client)
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

  const syncSubscriptionNow = (source: PortableSpaceCenterSource) => {
    if (syncingId !== null) return;
    setSyncingId(source.id);
    setFeedback(null);
    void portableSpacesApi(client)
      .syncSubscription(source.id, { force: false, createBackup: true }, { view: 'center-v1' })
      .then((commit) => {
        refresh();
        if (commit.kind !== 'subscription') return;
        if (commit.status === 'error') {
          const text = t('st.portable.syncError', { error: commit.error ?? 'Unknown error' });
          setFeedback({ tone: 'error', text });
          pushToast({ tone: 'error', text });
        } else if (commit.status === 'not_modified') {
          const text = t('st.portable.syncNotModified', { name: source.label });
          setFeedback({ tone: 'info', text });
          pushToast({ tone: 'info', text });
        } else {
          const count = commit.appliedIds.length + commit.deletedIds.length;
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

  const patchMetadata = async (
    source: PortableSpaceCenterSource,
    patch: { readonly label?: string; readonly enabled?: boolean; readonly syncPolicy?: PortableSpaceStoredSyncPolicy },
  ) => {
    if (patchingId !== null) return;
    setPatchingId(source.id);
    setFeedback(null);
    try {
      await portableSpacesApi(client).patchSource(source.id, {
        expectedRevision: source.revision,
        ...patch,
      });
      refresh();
      if (patch.label !== undefined) {
        const text = t('st.portable.center.renameSaved', { name: patch.label });
        setFeedback({ tone: 'success', text });
        pushToast({ tone: 'success', text });
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setPatchingId(null);
    }
  };

  const reorderUrlSource = async (source: PortableSpaceCenterSource, targetIndex: number) => {
    if (reordering) return;
    const spaceId = source.linkedSpaceId ?? MAIN_SPACE_ID;
    const peers = urlGroupsBySpace.get(spaceId) ?? [];
    const currentIndex = peers.findIndex((entry) => entry.id === source.id);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= peers.length || currentIndex === targetIndex) return;

    const ordered = peers.map((entry) => entry.id);
    const [moved] = ordered.splice(currentIndex, 1);
    ordered.splice(targetIndex, 0, moved!);

    setReordering(true);
    setFeedback(null);
    try {
      await portableSpacesApi(client).reorderSources({
        spaceId,
        orderedIds: ordered,
        expectedOrderRevision: orderRevision,
      });
      refresh();
      pushToast({ tone: 'success', text: t('st.portable.center.priorityUpdated') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setReordering(false);
    }
  };

  /**
   * Bounded sequential read-only check across all enabled URL subscriptions.
   * Never bulk-applies manual sources or mutates live config.
   */
  const checkAllUpdates = async () => {
    if (checkingAll || enabledUrlSources.length < 2) return;
    setCheckingAll(true);
    setFeedback(null);
    let updated = 0;
    let current = 0;
    let failed = 0;
    const api = portableSpacesApi(client);
    for (const source of enabledUrlSources) {
      try {
        const manifest = await api.previewSource(source.id, {});
        const hasIncomingChange = manifest.items.some(
          (item) => item.selected && (item.status === 'will_write' || item.status === 'new_scope' || item.status === 'removed_impact'),
        );
        if (hasIncomingChange) updated += 1;
        else current += 1;
      } catch {
        failed += 1;
      }
    }
    setCheckingAll(false);
    refresh();
    const text = t('st.portable.center.checkAllDone', {
      total: enabledUrlSources.length,
      updated,
      current,
      failed,
    });
    setFeedback({ tone: failed > 0 ? 'error' : 'info', text });
    pushToast({ tone: failed > 0 ? 'error' : 'info', text });
  };

  const spaceNameOf = (spaceId: string | undefined): string => {
    if (spaceId === undefined || spaceId === MAIN_SPACE_ID) return t('st.spaces.main');
    return spaces.find((entry) => entry.id === spaceId)?.name ?? spaceId;
  };

  const scopeSummaryText = (source: PortableSpaceCenterSource): string => {
    const sel = source.selection;
    if (sel === undefined) return t('st.portable.center.scopeAll');
    const managedCount = source.managedIds?.length ?? 0;
    return t('st.portable.center.scopeSummary', { scopes: sel.enabledScopes.length, items: managedCount });
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

  const menuItems = (source: PortableSpaceCenterSource): SpaceMenuItem[] => {
    const isUrl = source.endpoint.kind === 'url';
    if (isUrl) {
      const policy = effectivePolicy(source);
      const spaceId = source.linkedSpaceId ?? MAIN_SPACE_ID;
      const peers = urlGroupsBySpace.get(spaceId) ?? [];
      const rankIndex = peers.findIndex((entry) => entry.id === source.id);
      const hasMultiplePeers = peers.length > 1;
      const passphraseBlocked = source.encryptionMode === 'passphrase';

      return [
        {
          key: 'edit-selection',
          label: t('st.portable.center.editSelection'),
          run: () => { setSubscribeModal({ kind: 'edit-selection', source }); },
        },
        {
          key: 'check-updates',
          label: t('st.portable.center.checkUpdates'),
          run: () => { setSubscribeModal({ kind: 'update-review', source }); },
        },
        {
          key: 'toggle-policy',
          label: policy === 'auto' ? t('st.portable.center.switchToManual') : t('st.portable.center.switchToAuto'),
          blockedReason: policy === 'manual' && passphraseBlocked
            ? t('st.portable.center.switchToAutoBlockedPassphrase')
            : undefined,
          run: () => {
            void patchMetadata(source, { syncPolicy: policy === 'auto' ? 'manual' : 'auto' });
          },
        },
        {
          key: 'rename',
          label: t('st.portable.center.rename'),
          run: () => {
            setRenameTarget(source);
            setRenameDraft(source.label);
          },
        },
        ...(hasMultiplePeers ? [
          {
            key: 'move-up',
            label: t('st.portable.center.moveUp'),
            separatorBefore: true,
            blockedReason: rankIndex <= 0 ? t('st.portable.center.moveUpBlocked') : undefined,
            run: () => { void reorderUrlSource(source, rankIndex - 1); },
          },
          {
            key: 'move-down',
            label: t('st.portable.center.moveDown'),
            blockedReason: rankIndex >= peers.length - 1 ? t('st.portable.center.moveDownBlocked') : undefined,
            run: () => { void reorderUrlSource(source, rankIndex + 1); },
          },
        ] : []),
        {
          key: 'compare',
          label: t('st.portable.compare'),
          separatorBefore: true,
          run: () => { openDetail(source, 'compare', { mode: 'merge' }); },
        },
        {
          key: 'fork',
          label: t('st.portable.forkMenu'),
          run: () => { setExportPanel({ intent: 'fork', source: source.endpoint, mode: 'full' }); },
        },
        {
          key: 'copy-colab',
          label: t('st.portable.copyColabMenu'),
          run: () => { copyColab(source); },
        },
        {
          key: 'unsubscribe',
          label: t('st.portable.center.unsubscribe'),
          danger: true,
          separatorBefore: true,
          run: () => { setRemoveTarget(source); },
        },
      ];
    }

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
        run: () => { removeNonUrlSource(source); },
      },
    ];
  };

  const renderUrlRow = (source: PortableSpaceCenterSource) => {
    const subtitle = endpointSubtitle(source.endpoint, source.gitBranch);
    const policy = effectivePolicy(source);
    const spaceId = source.linkedSpaceId ?? MAIN_SPACE_ID;
    const peers = urlGroupsBySpace.get(spaceId) ?? [];
    const rankIndex = peers.findIndex((entry) => entry.id === source.id);
    const showRank = peers.length > 1;
    const timeText = formatShortRelativeTime(source.lastSyncedAt ?? source.lastCheckedAt, locale);
    const timeLabel = timeText === null
      ? t('st.portable.center.neverSynced')
      : source.lastSyncedAt !== undefined
        ? t('st.portable.center.lastSynced', { time: timeText })
        : t('st.portable.center.lastChecked', { time: timeText });

    return (
      <div
        data-portable-source-row={source.id}
        data-portable-source-kind="url"
        data-portable-source-policy={policy}
        data-portable-source-enabled={source.enabled ? 'true' : 'false'}
        draggable={showRank && !reordering}
        onDragStart={() => { setDraggingId(source.id); }}
        onDragOver={(event) => {
          if (draggingId !== null && draggingId !== source.id) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const dragged = peers.find((entry) => entry.id === draggingId);
          setDraggingId(null);
          if (dragged !== undefined && rankIndex >= 0) {
            void reorderUrlSource(dragged, rankIndex);
          }
        }}
        onDragEnd={() => { setDraggingId(null); }}
        style={{ minHeight: LIST_ROW_HEIGHT.comfortable }}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
      >
        <div className="flex shrink-0 items-center gap-2">
          {showRank ? (
            <span
              data-portable-priority-rank={source.id}
              className="w-5 text-right font-mono text-[12px] leading-4 tabular-nums text-ink-faint"
              title={t('st.portable.center.moveUp')}
            >
              #{rankIndex + 1}
            </span>
          ) : (
            <Icon name="web" size={14} className="text-ink-faint" />
          )}
          <Toggle
            layout="bare"
            label={`${source.label} (${t(source.enabled ? 'st.portable.center.pause' : 'st.portable.center.resume')})`}
            checked={source.enabled}
            disabled={patchingId !== null}
            onChange={(enabled) => { void patchMetadata(source, { enabled }); }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              data-detail-trigger={source.id}
              onClick={() => { openDetail(source, 'contents'); }}
              title={source.label}
              className={`min-w-0 shrink truncate rounded text-left text-[13px] leading-5 font-normal transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center ${
                source.enabled ? 'text-ink' : 'text-ink-faint'
              }`}
            >
              {source.label}
            </button>
            <span className="shrink-0 text-[12px] leading-4 text-ink-soft" data-portable-policy-label={source.id}>
              {!source.enabled
                ? t('st.portable.center.paused')
                : policy === 'auto'
                  ? t('st.portable.center.policyAuto')
                  : t('st.portable.center.policyManual')}
            </span>
            <span className="shrink-0 text-[12px] leading-4 text-ink-faint" data-portable-scope-summary={source.id}>
              · {scopeSummaryText(source)}
            </span>
            {spaces.length > 1 ? (
              <span className="shrink-0 text-[12px] leading-4 text-ink-faint">
                · {spaceNameOf(source.linkedSpaceId)}
              </span>
            ) : null}
            {source.availableNewScopes.length > 0 ? (
              <span className="shrink-0 text-[12px] leading-4 font-normal text-amber-ink" data-portable-new-scopes={source.id}>
                · {t('st.portable.center.newScopesBadge', { count: source.availableNewScopes.length })}
              </span>
            ) : null}
            {source.needsReconcile ? (
              <span className="shrink-0 text-[12px] leading-4 font-normal text-amber-ink" data-portable-needs-reconcile={source.id}>
                · {t('st.portable.center.needsReconcile')}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[12px] leading-4 text-ink-faint">
            <span className="font-mono" title={subtitle}>{subtitle}</span>
            {' · '}
            <span>{timeLabel}</span>
          </p>
          {source.lastSyncError ? (
            <PortableSyncErrorLine
              sourceId={source.id}
              error={source.lastSyncError}
              label={t('st.portable.syncError', { error: source.lastSyncError })}
              copyLabel={t('cb.copy')}
              copiedLabel={t('cb.copied')}
            />
          ) : null}
        </div>

        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:ml-auto sm:w-auto">
          {!source.enabled ? (
            <button
              type="button"
              data-portable-resume={source.id}
              disabled={patchingId !== null}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { void patchMetadata(source, { enabled: true }); }}
            >
              {t('st.portable.center.resume')}
            </button>
          ) : policy === 'manual' || source.needsReconcile ? (
            <button
              type="button"
              data-portable-check-updates={source.id}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { setSubscribeModal({ kind: 'update-review', source }); }}
            >
              {t('st.portable.center.checkUpdates')}
            </button>
          ) : (
            <button
              type="button"
              data-portable-sync-now={source.id}
              disabled={syncingId !== null}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { syncSubscriptionNow(source); }}
            >
              {syncingId === source.id ? t('st.portable.syncing') : t('st.portable.syncNow')}
            </button>
          )}
          <button
            type="button"
            data-portable-menu={source.id}
            aria-haspopup="menu"
            aria-label={t('st.portable.menuAria', { name: source.label })}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
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

  const renderNonUrlRow = (source: PortableSpaceCenterSource) => {
    const subtitle = endpointSubtitle(source.endpoint, source.gitBranch);
    const iconName = source.endpoint.kind === 'git' ? 'branch' : source.format === 'age' ? 'lock' : 'folder';
    const isPlainSecret = source.secretMode === 'plain';
    return (
      <div
        data-portable-source-row={source.id}
        data-portable-source-kind={source.endpoint.kind}
        style={{ minHeight: LIST_ROW_HEIGHT.comfortable }}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:flex-nowrap"
      >
        <Icon name={iconName} size={14} className="text-ink-faint" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              data-detail-trigger={source.id}
              onClick={() => { openDetail(source, 'contents'); }}
              title={source.label}
              className="min-w-0 shrink truncate rounded text-left text-[13px] leading-5 font-normal text-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
            >
              {source.label}
            </button>
            <span data-portable-kind-badge={source.id} className="shrink-0 text-[12px] leading-4 text-ink-soft">
              {kindBadgeText(source)}
            </span>
            <span
              data-portable-secret-badge={source.id}
              className={`shrink-0 text-[12px] leading-4 ${isPlainSecret ? 'font-normal text-amber-ink' : 'text-ink-faint'}`}
            >
              · {secretBadgeText(source)}
            </span>
          </div>
          <p className="truncate font-mono text-[12px] leading-4 text-ink-faint" title={subtitle}>{subtitle}</p>
        </div>

        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:ml-auto sm:w-auto">
          <button
            type="button"
            data-portable-compare={source.id}
            className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
            onClick={() => { openDetail(source, 'compare', { mode: 'sync' }); }}
          >
            {t('st.portable.compare')}
          </button>
          <button
            type="button"
            data-portable-apply={source.id}
            className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
            onClick={() => {
              openDetail(source, 'compare', { mode: 'merge', right: { kind: 'live', spaceId: MAIN_SPACE_ID } });
            }}
          >
            {t('st.portable.apply')}
          </button>
          <button
            type="button"
            data-portable-menu={source.id}
            aria-haspopup="menu"
            aria-label={t('st.portable.menuAria', { name: source.label })}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
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

  const handleModalDone = (result: SubscribeModalResult) => {
    setSubscribeModal(null);
    refresh();
    let text: string;
    if (result.kind === 'linked') {
      text = t('st.portable.linkDone', { name: result.record.label });
    } else if (result.kind === 'patch') {
      text = t('st.portable.center.updateSaved', { name: result.result.source.label });
    } else if (result.commit.kind === 'once') {
      const count = result.commit.appliedIds.length + result.commit.deletedIds.length;
      text = t('st.portable.center.importOnceDone', { count });
    } else {
      const count = result.commit.appliedIds.length + result.commit.deletedIds.length;
      text = result.commit.status === 'not_modified'
        ? t('st.portable.syncNotModified', { name: result.commit.source.label })
        : t('st.portable.subscribeDone', { name: result.commit.source.label, count });
    }
    setFeedback({ tone: 'success', text });
    pushToast({ tone: 'success', text });
  };

  const listContent = (
    <div ref={sectionContainerRef} className="space-y-3" data-portable-sources-list>
      {sourcesQuery.isLoading ? <Hint>{t('st.portable.loading')}</Hint> : null}

      {sourcesQuery.isError ? (
        <div className="space-y-2" data-portable-sources-error>
          {isPortableHostUnsupportedError(sourcesQuery.error) ? (
            <p className="text-[13px] leading-5 text-ink-soft" data-portable-unsupported-host>
              {t('st.portable.center.unsupportedHost')}
            </p>
          ) : (
            <InlineError error={sourcesQuery.error} />
          )}
          <button
            type="button"
            data-portable-sources-retry
            className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
            onClick={() => { void sourcesQuery.refetch(); }}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <ListBody
          items={items}
          keyOf={(item) => item.id}
          density="comfortable"
          label={t('st.portable.title')}
          renderRow={(source) => (source.endpoint.kind === 'url' ? renderUrlRow(source) : renderNonUrlRow(source))}
        />
      ) : sourcesQuery.isSuccess ? (
        <p className="text-[13px] leading-5 text-ink-soft" data-portable-empty>
          {t('st.portable.center.emptyHint')}
        </p>
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
          {enabledUrlSources.length >= 2 ? (
            <button
              type="button"
              data-portable-check-all
              disabled={checkingAll}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { void checkAllUpdates(); }}
            >
              {checkingAll ? t('st.portable.center.checkingAll') : t('st.portable.center.checkAllUpdates')}
            </button>
          ) : null}
          <button
            type="button"
            data-portable-export-open
            className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
            onClick={() => { setExportPanel({ intent: 'export', source: { kind: 'live', spaceId: MAIN_SPACE_ID } }); }}
          >
            {t('st.portable.export')}
          </button>
          <button
            type="button"
            data-portable-subscribe-open
            data-portable-link-open
            className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
            onClick={() => { setSubscribeModal({ kind: 'new' }); }}
          >
            {t('st.portable.addOrImport')}
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

      {subscribeModal !== null ? (
        <SubscribeModal
          client={client}
          spaces={spaces}
          mode={subscribeModal}
          onClose={() => { setSubscribeModal(null); }}
          onDone={handleModalDone}
        />
      ) : null}

      {removeTarget !== null ? (
        <RemoveSubscriptionDialog
          open
          client={client}
          source={removeTarget}
          onCancel={() => { setRemoveTarget(null); }}
          onRemoved={(result, purged) => {
            const label = removeTarget.label;
            const id = removeTarget.id;
            setRemoveTarget(null);
            if (detail.selected === id) detail.close();
            refresh();
            const text = purged
              ? t('st.portable.center.removeDonePurge', {
                name: label,
                deleted: result.impact.deletedIds.length,
                preserved: result.impact.preservedLocalIds.length + result.impact.preservedDependencyIds.length,
              })
              : t('st.portable.center.removeDoneDetach', { name: label });
            setFeedback({ tone: 'success', text });
            pushToast({ tone: 'success', text });
          }}
        />
      ) : null}

      {renameTarget !== null ? (
        <Dialog
          stacked
          ariaLabel={t('st.portable.center.renameTitle')}
          overlayId="portable-rename-dialog"
          overlayClassName={DIALOG_SHEET_OVERLAY_CLASS}
          panelClassName={UNFRAMED_RENAME_PANEL_CLASS}
          dismissible={!renaming}
          onClose={() => { if (!renaming) setRenameTarget(null); }}
        >
          <form
            className="space-y-4"
            data-portable-rename-dialog={renameTarget.id}
            onSubmit={(event) => {
              event.preventDefault();
              const next = renameDraft.trim();
              if (!next || renaming) return;
              setRenaming(true);
              void patchMetadata(renameTarget, { label: next })
                .finally(() => {
                  setRenaming(false);
                  setRenameTarget(null);
                });
            }}
          >
            <h3 className="font-sans text-[18px] leading-[26px] font-bold text-ink">
              {t('st.portable.center.renameTitle')}
            </h3>
            <input
              data-autofocus
              data-portable-rename-input
              value={renameDraft}
              maxLength={120}
              onChange={(event) => { setRenameDraft(event.target.value); }}
              className={INPUT}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={renaming}
                className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
                onClick={() => { setRenameTarget(null); }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                data-portable-rename-submit
                disabled={renaming || renameDraft.trim() === ''}
                className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
              >
                {renaming ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {packDialog !== null ? (
        <PortablePackDialog
          client={client}
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

function PortableSyncErrorLine({
  sourceId,
  error,
  label,
  copyLabel,
  copiedLabel,
}: {
  readonly sourceId: string;
  readonly error: string;
  readonly label: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyTextToClipboard(error).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    }).catch(() => undefined);
  };

  return (
    <div className="mt-0.5 flex items-start gap-1.5" data-portable-sync-error={sourceId}>
      <button
        type="button"
        onClick={() => { setExpanded((value) => !value); }}
        aria-expanded={expanded}
        title={label}
        className={`min-w-0 flex-1 text-left text-[12px] leading-4 text-danger-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink ${
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
        }`}
      >
        {label}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? copiedLabel : copyLabel}
        title={copied ? copiedLabel : copyLabel}
        className="shrink-0 rounded px-1 text-[11px] leading-4 text-ink-soft hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
