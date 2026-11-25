import { useState } from 'react';

import type { RemoteConnection } from '@kiki/protocol';

import { Icon } from '../components/icons';
import { ActionSheet } from '../components/overlays/ActionSheet';
import { useI18n } from '../i18n';
import { isEmbeddedAndroidHost } from '../lib/appShell';
import {
  endpointNetworkKind,
  remoteSpaceKey,
  remoteSummaryView,
  spacePlatformLabel,
} from '../lib/remoteConnections';
import { ALL_SPACE_SCOPE, type MultiSpaceHealth } from '../lib/useMultiSpaceSessions';

interface MobileSpaceSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly activeScope: string;
  readonly onSelectScope: (scope: string) => void;
  readonly localSpaceKey: string;
  readonly localSpaceName: string;
  readonly localWaitingCount: number;
  readonly localRunningCount: number;
  readonly healthBySpace: ReadonlyMap<string, MultiSpaceHealth>;
  readonly remoteConnections: readonly RemoteConnection[];
  readonly totalOnlineCount: number;
  readonly totalWaitingCount: number;
  readonly onPairNew: () => void;
  readonly onRetryRemotes: () => Promise<void>;
  readonly onOpenWorkbench: () => void;
}

function networkTagFor(endpoint: string): 'LAN' | 'VPN' | 'HTTPS' | null {
  const kind = endpointNetworkKind(endpoint);
  if (kind === 'lan') return 'LAN';
  if (kind === 'tailscale') return 'VPN';
  if (kind === 'https') return 'HTTPS';
  return null;
}

export function MobileSpaceSheet({
  open,
  onClose,
  activeScope,
  onSelectScope,
  localSpaceKey,
  localSpaceName,
  localWaitingCount,
  localRunningCount,
  healthBySpace,
  remoteConnections,
  totalOnlineCount,
  totalWaitingCount,
  onPairNew,
  onRetryRemotes,
  onOpenWorkbench,
}: MobileSpaceSheetProps) {
  const { t } = useI18n();
  const [expandedFailureId, setExpandedFailureId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  if (!open) return null;

  const embeddedPhone = isEmbeddedAndroidHost();
  const localTitle = embeddedPhone ? t('mobile.space.localPhone') : localSpaceName;
  const localScopeToken = `local:${localSpaceKey}`;
  const isAllSelected = activeScope === ALL_SPACE_SCOPE;
  const isLocalSelected = activeScope === localScopeToken || activeScope === localSpaceKey;

  const choose = (scope: string) => {
    onSelectScope(scope);
    onClose();
  };

  return (
    <ActionSheet
      role="dialog"
      ariaLabel={t('mobile.space.switchTitle')}
      overlayId="mobile-space-sheet"
      dataAttribute="data-mobile-space-sheet"
      onClose={onClose}
      sheetClassName="kiki-space-switch-sheet rounded-t-[24px]!"
    >
      <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
      <div className="flex h-11 items-center px-4 pb-1">
        <h2 className="text-[16px] font-bold text-ink">{t('mobile.space.switchTitle')}</h2>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div className="overflow-hidden rounded-2xl border border-hairline/80 bg-paper">
          <button
            type="button"
            data-space-option="all"
            onClick={() => { choose(ALL_SPACE_SCOPE); }}
            className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink/[0.03]"
          >
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink">
              <Icon name="web" size={16} />
              {totalWaitingCount > 0 ? (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-normal tabular-nums text-primary-foreground">
                  {totalWaitingCount}
                </span>
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-normal text-ink">{t('mobile.space.all')}</span>
              <span className="block truncate text-[12px] text-ink-faint">
                {totalWaitingCount > 0
                  ? t('mobile.space.allSummary', { online: totalOnlineCount, waiting: totalWaitingCount })
                  : t('mobile.space.allSummaryClear', { online: totalOnlineCount })}
              </span>
            </span>
            {isAllSelected ? <Icon name="check" size={16} className="text-ink" /> : null}
          </button>
        </div>

        <div>
          <p className="mb-1.5 px-1 text-[11.5px] font-normal uppercase text-ink-faint">
            {t('mobile.spaces.myComputers')}
          </p>
          <div className="divide-y divide-hairline/70 overflow-hidden rounded-2xl border border-hairline/80 bg-paper">
            <button
              type="button"
              data-space-option={localScopeToken}
              onClick={() => { choose(localScopeToken); }}
              className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink/[0.03]"
            >
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink">
                <span className="h-2.5 w-2.5 rounded-full bg-success" aria-hidden="true" />
                {localWaitingCount > 0 ? (
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-normal tabular-nums text-primary-foreground">
                    {localWaitingCount}
                  </span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-normal text-ink">{localTitle}</span>
                <span className="block truncate text-[12px] text-ink-faint">
                  {localRunningCount > 0
                    ? t('mobile.space.runningCount', { count: localRunningCount })
                    : t('mobile.space.online')}
                </span>
              </span>
              {isLocalSelected ? <Icon name="check" size={16} className="text-ink" /> : null}
            </button>

            {remoteConnections.filter((record) => record.enabled).map((record) => {
              const key = remoteSpaceKey(record.id);
              const selected = activeScope === key;
              const health = healthBySpace.get(key);
              const online = health?.state === 'online' || record.state === 'online';
              const summary = remoteSummaryView(record);
              const waiting = summary?.needsYou ?? 0;
              const running = summary?.busy ?? 0;
              const platform = spacePlatformLabel(summary?.platform);
              const netTag = online ? networkTagFor(record.endpoint) : null;
              const subParts = [
                platform,
                online
                  ? running > 0
                    ? t('mobile.space.runningCount', { count: running })
                    : t('mobile.space.idle')
                  : undefined,
              ].filter((part): part is string => part !== undefined && part !== '');

              return (
                <div key={record.id}>
                  <button
                    type="button"
                    data-space-option={key}
                    onClick={() => {
                      if (online) {
                        choose(key);
                      } else {
                        setExpandedFailureId((cur) => (cur === record.id ? null : record.id));
                      }
                    }}
                    className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink/[0.03]"
                  >
                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-success' : 'border border-ink-faint bg-transparent'}`}
                        aria-hidden="true"
                      />
                      {waiting > 0 ? (
                        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-normal tabular-nums text-primary-foreground">
                          {waiting}
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-normal text-ink">{record.label}</span>
                      {subParts.length > 0 ? (
                        <span className="block truncate text-[12px] text-ink-faint">{subParts.join(' · ')}</span>
                      ) : null}
                    </span>
                    {netTag !== null ? (
                      <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-ink-soft">
                        {netTag}
                      </span>
                    ) : !online ? (
                      <span className="shrink-0 text-[12px] text-ink-faint">{t('mobile.space.offline')}</span>
                    ) : null}
                    {selected ? <Icon name="check" size={16} className="shrink-0 text-ink" /> : null}
                  </button>

                  {!online && expandedFailureId === record.id ? (
                    <div className="flex items-center gap-2 border-t border-hairline/60 bg-canvas/50 px-3.5 py-2">
                      <button
                        type="button"
                        disabled={retryingId === record.id}
                        onClick={() => {
                          setRetryingId(record.id);
                          void onRetryRemotes().finally(() => { setRetryingId(null); });
                        }}
                        className="inline-flex h-11 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-normal text-paper disabled:opacity-55"
                      >
                        <Icon name="refresh" size={12} />
                        <span>{t('mobile.space.retry')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onPairNew();
                        }}
                        className="inline-flex h-11 items-center rounded-full border border-hairline bg-panel px-4 text-[13px] font-normal text-ink-soft"
                      >
                        {t('mobile.space.repair')}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}

            <button
              type="button"
              data-mobile-pair-new
              onClick={() => {
                onClose();
                onPairNew();
              }}
              className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2.5 text-left text-ink-soft transition-colors hover:bg-ink/[0.03] hover:text-ink"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-soft">
                <Icon name="plus" size={16} />
              </span>
              <span className="text-[15px] font-normal">{t('mobile.space.pairNew')}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            data-mobile-open-workbench
            onClick={() => {
              onClose();
              onOpenWorkbench();
            }}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl text-[13px] font-normal text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <Icon name="external" size={14} />
            <span>{t('mobile.spaces.openWorkbench')}</span>
          </button>
        </div>
      </div>
    </ActionSheet>
  );
}
