/**
 * SpaceSwitchSheet — subtraction-first computer filter + local space switcher.
 *
 * Two-Tier model:
 *   1. Computers (`所有电脑`, `这台电脑`, paired remote computers): pure 0ms sidebar
 *      view filters. Each row is a single calm line with a status dot, name, optional
 *      `bg-attention` needs-you pill, and checkmark when focused. Platform, RTT, busy
 *      count, and offline/stale metadata live strictly in `title` / `aria-label`.
 *   2. Local Spaces (`空间` section, shown only when `localItems.length > 1`):
 *      window-level local Kiki homes (`主空间`, `妮娅·私语酒馆`).
 *
 * Desktop: a 280px popover anchored under the top-left control.
 * Phone touch mode: a bottom sheet capped at 70% of viewport height.
 */

import { type ReactNode, type RefObject } from 'react';
import { relativeTime } from '@kiki/session-core/util/time';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { RemoteConnection } from '@kiki/protocol';
import type { SpaceWindowMode } from '@kiki/session-core/settings';

import type { DesktopSpaceStatus } from '../host';
import { useI18n } from '../i18n';
import { usePhoneMode } from '../lib/layoutHooks';
import { connectionStateTone, remoteSummaryView, spacePlatformLabel } from '../lib/remoteConnections';
import { MAIN_SPACE_ID, spaceRunState, spaceStatus, type SpaceListItem } from '../lib/spaces';
import type { ScopeRestoreFailure } from '../lib/navScope';
import { Icon } from './icons';
import { ActionSheet } from './overlays/ActionSheet';
import { AnchoredPopover } from './overlays/AnchoredPopover';
import { SpaceDot } from './settings/spaces/SpaceDot';

export type SpaceRowFailureKind =
  | 'local-start'
  | 'remote-unreachable'
  | 'remote-closed'
  | 'remote-not-approved'
  | 'remote-identity-changed'
  | 'remote-paused'
  | 'remote-protocol';

export interface SpaceRowFailure {
  readonly rowKey: string;
  readonly kind: SpaceRowFailureKind;
  readonly spaceName: string;
  readonly recordId?: string;
  readonly spaceId?: string;
}

export function classifyRemoteSwitchError(error: unknown): SpaceRowFailureKind {
  const reason = (error as { reason?: ScopeRestoreFailure } | null)?.reason;
  switch (reason) {
    case 'remote-closed':
      return 'remote-closed';
    case 'remote-not-approved':
    case 'auth-required':
    case 'session-expired':
      return 'remote-not-approved';
    case 'remote-identity-changed':
    case 'identity-mismatch':
      return 'remote-identity-changed';
    case 'remote-paused':
      return 'remote-paused';
    case 'remote-protocol':
      return 'remote-protocol';
    default:
      return 'remote-unreachable';
  }
}

const REMOTE_TONE_DOT: Record<ReturnType<typeof connectionStateTone>, string> = {
  online: 'bg-success',
  attention: 'bg-attention',
  offline: 'border border-ink-faint/75',
  muted: 'border border-ink-faint/50',
};

function remoteStateLabel(
  record: RemoteConnection,
  t: (key: I18nKey, vars?: Record<string, string | number>) => string,
  staleTime?: string,
): string {
  if (record.state === 'online') return t('st.remote.state.online');
  if (record.state === 'disabled') return t('st.remote.state.disabled');
  if (record.state === 'identity_changed') return t('st.remote.state.identity_changed');
  if (record.lastError?.includes('inbound_disabled')) return t('sidebar.space.stateClosed');
  if (record.lastError?.includes('connection_not_approved')) return t('sidebar.space.stateRePair');
  if (record.state === 'authentication_required') return t('st.remote.state.authentication_required');
  if (staleTime !== undefined) return `${t('st.remote.state.offline')} · ${staleTime}`;
  return t('st.remote.state.offline');
}

export interface SpaceSwitchSheetProps {
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly desktop: boolean;
  readonly mode: SpaceWindowMode;
  readonly inSshScope?: boolean;
  readonly activeLocalHomeId: string;
  readonly localSpaceName: string;
  readonly localComputerName?: string;
  readonly localItems: readonly SpaceListItem[];
  readonly localLoading: boolean;
  readonly localError: boolean;
  readonly onRetryLocal: () => void;
  readonly statuses: readonly DesktopSpaceStatus[] | undefined;
  readonly remoteItems: readonly RemoteConnection[];
  readonly remoteLoading: boolean;
  readonly remoteError: boolean;
  readonly onRetryRemote: () => void;
  readonly spaceScope?: string;
  readonly onSelectAllComputers: () => void;
  readonly onSelectThisComputer: () => void;
  readonly openingKey: string | null;
  readonly failure: SpaceRowFailure | null;
  readonly actionBusy: boolean;
  readonly switchComputerUrl: string | null;
  readonly onBackToLocal?: () => void;
  readonly onSelectLocalSpace: (space: SpaceListItem) => void;
  readonly onSelectRemoteComputer: (record: RemoteConnection) => void;
  readonly onTurnOnRemote: (recordId: string, record: RemoteConnection) => void;
  readonly onRemoveRemote: (recordId: string) => void;
  readonly onPairAgain: () => void;
  readonly onViewLog: (() => void) | undefined;
  readonly onPairRemote: () => void;
  readonly onManageSpaces: () => void;
}

export function SpaceSwitchSheet(props: SpaceSwitchSheetProps) {
  const { t } = useI18n();
  const isPhone = usePhoneMode();
  const {
    anchorRef,
    onClose,
    desktop,
    mode,
    inSshScope = false,
    activeLocalHomeId,
    localSpaceName,
    localItems,
    localLoading,
    localError,
    onRetryLocal,
    statuses,
    remoteItems,
    remoteError,
    onRetryRemote,
    spaceScope = 'all',
    onSelectAllComputers,
    onSelectThisComputer,
    openingKey,
    failure,
    actionBusy,
    switchComputerUrl,
    onBackToLocal,
    onSelectLocalSpace,
    onSelectRemoteComputer,
    onTurnOnRemote,
    onRemoveRemote,
    onPairAgain,
    onViewLog,
    onPairRemote,
    onManageSpaces,
  } = props;

  const busy = openingKey !== null || actionBusy;
  const localScopeToken = `local:${activeLocalHomeId}`;
  const showComputerList = remoteItems.length > 0 || remoteError || spaceScope !== 'all';
  const allComputersActive = spaceScope === 'all';
  const thisComputerActive = spaceScope === localScopeToken;
  const showSpacesGroup = localItems.length > 1 || localLoading || localError;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);

  const body = (
    <div className="flex max-h-[inherit] min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5" data-space-switch-scroll>
        {inSshScope && onBackToLocal !== undefined ? (
          <div className="mb-1 border-b border-hairline pb-1">
            <button
              type="button"
              role="menuitem"
              data-space-back-local
              disabled={busy}
              onClick={onBackToLocal}
              className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-normal text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-ink-soft">←</span>
              <span className="min-w-0 flex-1 truncate">{t('sidebar.space.backToLocal', { space: localSpaceName })}</span>
            </button>
          </div>
        ) : null}

        {showComputerList ? (
          <>
            <button
              type="button"
              role="menuitem"
              data-space-scope-all
              aria-current={allComputersActive ? 'true' : undefined}
              disabled={busy}
              onClick={onSelectAllComputers}
              className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-ink-faint">
                <Icon name="agent" size={14} />
              </span>
              <span className={`min-w-0 flex-1 truncate`}>
                {t('sidebar.space.allSpaces')}
              </span>
              {allComputersActive ? (
                <span aria-hidden className="inline-flex shrink-0 items-center text-ink-soft">
                  <Icon name="check" size={12} />
                </span>
              ) : null}
            </button>

            <div className="mx-1.5 my-1 border-t border-hairline" />

            <button
              type="button"
              role="menuitem"
              data-space-computer-local
              aria-current={thisComputerActive ? 'true' : undefined}
              disabled={busy}
              onClick={onSelectThisComputer}
              className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span aria-hidden className="flex w-5 shrink-0 items-center justify-center">
                <span className="h-2 w-2 rounded-full bg-success" />
              </span>
              <span className={`min-w-0 flex-1 truncate`}>
                {t('sidebar.space.thisComputer')}
              </span>
              {thisComputerActive ? (
                <span aria-hidden className="inline-flex shrink-0 items-center text-ink-soft">
                  <Icon name="check" size={12} />
                </span>
              ) : null}
            </button>

            {remoteError && remoteItems.length === 0 ? (
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-ink-soft" data-space-remote-error>
                <span>{t('sidebar.space.listLoadFailed')}</span>
                <button
                  type="button"
                  onClick={onRetryRemote}
                  className="shrink-0 rounded px-2 py-0.5 text-[12px] font-normal text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent"
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : (
              remoteItems.map((record) => {
                const rowKey = `remote:${record.id}`;
                const rowFailure = failure?.rowKey === rowKey ? failure : null;
                return (
                  <div key={record.id}>
                    <RemoteComputerRow
                      record={record}
                      focused={spaceScope === rowKey}
                      disabled={busy}
                      onSelect={() => { onSelectRemoteComputer(record); }}
                    />
                    {rowFailure !== null ? (
                      <InlineRowFailure
                        failure={rowFailure}
                        busy={actionBusy}
                        onRetry={() => { onSelectRemoteComputer(record); }}
                        onTurnOn={() => { onTurnOnRemote(record.id, record); }}
                        onRemove={() => { onRemoveRemote(record.id); }}
                        onPairAgain={onPairAgain}
                      />
                    ) : null}
                  </div>
                );
              })
            )}
          </>
        ) : null}

        {showSpacesGroup ? (
          <>
            {showComputerList ? <div className="mx-1.5 my-1.5 border-t border-hairline" /> : null}
            <p className="px-2.5 pt-0.5 pb-1 text-[11px] font-normal text-ink-faint" data-space-group-spaces>
              {t('sidebar.space.groupSpaces')}
            </p>
            {localLoading && localItems.length === 0 ? (
              <div className="space-y-1 px-2.5 py-1" data-space-directory-pending role="status" aria-label={t('st.spaces.loading')}>
                <div className="h-8 rounded-md bg-ink/[0.04]" />
                <div className="h-8 rounded-md bg-ink/[0.04]" />
              </div>
            ) : localError && localItems.length === 0 ? (
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-ink-soft" data-space-local-error>
                <span>{t('sidebar.space.listLoadFailed')}</span>
                <button
                  type="button"
                  onClick={onRetryLocal}
                  className="shrink-0 rounded px-2 py-0.5 text-[12px] font-normal text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent"
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : (
              localItems.map((space) => {
                const run = space.id === activeLocalHomeId && !inSshScope
                  ? 'current'
                  : spaceRunState(space.id, statuses) === 'current'
                    ? 'hot'
                    : spaceRunState(space.id, statuses);
                const count = spaceStatus(space.id, statuses)?.pendingCount ?? 0;
                const isCurrentSpace = space.id === activeLocalHomeId && !inSshScope;
                const rowKey = `local:${space.id}`;
                const isOpening = openingKey === rowKey;
                const rowFailure = failure?.rowKey === rowKey ? failure : null;
                const disabled = busy || (!desktop && !isCurrentSpace);
                const itemName = label(space);
                const statusTitle = !isCurrentSpace && desktop
                  ? (mode === 'windows'
                      ? `${itemName} · ${t('sidebar.space.openWindow')}`
                      : `${itemName} · ${t(run === 'hot' ? 'st.spaces.running' : 'st.spaces.notStarted')}`)
                  : itemName;

                return (
                  <div key={space.id}>
                    <button
                      type="button"
                      role="menuitem"
                      data-space-switch-item={space.id}
                      data-space-state={run}
                      aria-current={isCurrentSpace ? 'true' : undefined}
                      title={statusTitle}
                      disabled={disabled}
                      onClick={() => { onSelectLocalSpace(space); }}
                      className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <span aria-hidden className="flex w-5 shrink-0 items-center justify-center">
                        <SpaceDot color={space.id === MAIN_SPACE_ID ? 'var(--color-ink-faint)' : space.color} />
                      </span>
                      <span className={`min-w-0 flex-1 truncate`}>
                        {itemName}
                      </span>
                      {count > 0 && !isCurrentSpace ? (
                        <span
                          data-space-local-pending={count}
                          className="shrink-0 rounded-full bg-attention px-1.5 text-[10.5px] font-normal tabular-nums leading-[16px] text-on-accent"
                        >
                          {count}
                        </span>
                      ) : null}
                      {isOpening ? (
                        <span className="shrink-0 text-[11.5px] text-ink-soft" data-space-row-opening>
                          {t('sidebar.space.openingInline')}
                        </span>
                      ) : isCurrentSpace ? (
                        <span aria-hidden className="inline-flex shrink-0 items-center text-ink-soft">
                          <Icon name="check" size={12} />
                        </span>
                      ) : desktop ? (
                        mode === 'windows' ? (
                          <span aria-hidden className="inline-flex shrink-0 items-center text-ink-faint">
                            <Icon name="external" size={12} />
                          </span>
                        ) : (
                          <span
                            aria-hidden
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${run === 'hot' ? 'bg-success' : 'border border-ink-faint/70'}`}
                          />
                        )
                      ) : null}
                    </button>
                    {rowFailure !== null ? (
                      <InlineRowFailure
                        failure={rowFailure}
                        busy={actionBusy}
                        onRetry={() => { onSelectLocalSpace(space); }}
                        onViewLog={onViewLog}
                      />
                    ) : null}
                  </div>
                );
              })
            )}
          </>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-hairline px-1 pt-1 pb-1" data-space-switch-footer>
        <button
          type="button"
          role="menuitem"
          data-space-pair-entry
          disabled={busy}
          onClick={onPairRemote}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:opacity-50"
        >
          <span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-ink-soft">
            <Icon name="plus" size={14} />
          </span>
          <span className="truncate">{t('sidebar.space.pairRemote')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-space-manage
          disabled={busy}
          onClick={onManageSpaces}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-soft outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:bg-paper disabled:opacity-50"
        >
          <span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-ink-faint">
            <Icon name="settings" size={14} />
          </span>
          <span className="truncate">{t('sidebar.space.manage')}</span>
        </button>
        {switchComputerUrl !== null ? (
          <button
            type="button"
            role="menuitem"
            data-space-switch-computer
            disabled={busy}
            onClick={() => {
              onClose();
              window.location.assign(switchComputerUrl);
            }}
            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-soft outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:bg-paper disabled:opacity-50"
          >
            <span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-ink-faint">
              <Icon name="web" size={14} />
            </span>
            <span className="truncate">{t('sidebar.space.switchComputer')}</span>
          </button>
        ) : null}
      </div>
    </div>
  );

  if (isPhone) {
    return (
      <ActionSheet
        ariaLabel={t('sidebar.space.menuTitle')}
        overlayId="space-switcher-sheet"
        onClose={onClose}
        dataAttribute="data-space-switcher-menu"
        sheetClassName="kiki-space-switch-sheet"
      >
        {body}
      </ActionSheet>
    );
  }

  return (
    <AnchoredPopover
      open
      onClose={onClose}
      anchorRef={anchorRef}
      id="space-switcher-menu"
      label={t('sidebar.space.menuTitle')}
      role="menu"
      widthClassName="w-[272px]"
      className="flex max-h-[min(70dvh,30rem)] flex-col overflow-hidden p-0"
      data={{ 'data-space-switcher-menu': '' }}
      initialFocusSelector='[aria-current="true"]'
      onSurfaceKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
        if (buttons.length === 0) return false;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length]?.focus();
        return true;
      }}
    >
      {body}
    </AnchoredPopover>
  );
}

function RemoteComputerRow({
  record,
  focused,
  disabled,
  onSelect,
}: {
  readonly record: RemoteConnection;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const { t, locale } = useI18n();
  const summary = remoteSummaryView(record);
  const stale = summary !== null && summary.stale && summary.asOf !== undefined;
  const staleTime = stale && summary?.asOf !== undefined
    ? t('sidebar.space.remoteAsOf', { time: relativeTime(new Date(summary.asOf).toISOString(), locale) })
    : undefined;
  const tone = connectionStateTone(record.state);
  const platformLabel = spacePlatformLabel(summary?.platform);
  const rttMs = record.state === 'online' ? (summary?.rttMs ?? record.rttMs) : undefined;
  const titleParts = [
    record.state !== 'online' ? remoteStateLabel(record, t, staleTime) : undefined,
    platformLabel,
    rttMs !== undefined ? `${rttMs} ms` : undefined,
    summary !== null && summary.busy > 0 ? t('sidebar.space.remoteBusy', { count: summary.busy }) : undefined,
    summary !== null && summary.needsYou > 0 ? t('sidebar.space.remoteNeedsYou', { count: summary.needsYou }) : undefined,
  ].filter((part): part is string => part !== undefined);
  const rowTitle = titleParts.length > 0 ? `${record.label} · ${titleParts.join(' · ')}` : record.label;

  return (
    <button
      type="button"
      role="menuitem"
      data-space-remote-item={record.id}
      data-space-remote-state={record.state}
      data-space-remote-stale={stale ? '' : undefined}
      aria-current={focused ? 'true' : undefined}
      title={rowTitle}
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span aria-hidden className="flex w-5 shrink-0 items-center justify-center">
        <span className={`h-2 w-2 rounded-full ${REMOTE_TONE_DOT[tone]}`} />
      </span>
      <span className={`min-w-0 flex-1 truncate ${record.state !== 'online' ? 'text-ink-soft' : ''}`}>
        {record.label}
      </span>
      {summary !== null && summary.needsYou > 0 ? (
        <span
          data-space-remote-needs={summary.needsYou}
          className="shrink-0 rounded-full bg-attention px-1.5 text-[10.5px] font-normal tabular-nums leading-[16px] text-on-accent"
        >
          {summary.needsYou}
        </span>
      ) : null}
      {focused ? (
        <span aria-hidden className="inline-flex shrink-0 items-center text-ink-soft">
          <Icon name="check" size={12} />
        </span>
      ) : null}
    </button>
  );
}

function InlineRowFailure({
  failure,
  busy,
  onRetry,
  onTurnOn,
  onRemove,
  onPairAgain,
  onViewLog,
}: {
  readonly failure: SpaceRowFailure;
  readonly busy: boolean;
  readonly onRetry?: () => void;
  readonly onTurnOn?: () => void;
  readonly onRemove?: () => void;
  readonly onPairAgain?: () => void;
  readonly onViewLog?: () => void;
}) {
  const { t } = useI18n();
  let reasonText: string;
  let actions: ReactNode = null;

  const actionButtonClass =
    'rounded px-1.5 py-0.5 text-[11.5px] font-normal text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent disabled:opacity-50';

  switch (failure.kind) {
    case 'local-start':
      reasonText = t('sidebar.space.fail.localStart', { name: failure.spaceName });
      actions = (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {onRetry !== undefined ? (
            <button type="button" data-space-row-action="retry" disabled={busy} onClick={onRetry} className={actionButtonClass}>
              {t('common.retry')}
            </button>
          ) : null}
          {onViewLog !== undefined ? (
            <>
              <span aria-hidden className="text-ink-faint">·</span>
              <button type="button" data-space-row-action="view-log" disabled={busy} onClick={onViewLog} className={actionButtonClass}>
                {t('sidebar.space.viewLog')}
              </button>
            </>
          ) : null}
        </span>
      );
      break;
    case 'remote-closed':
      reasonText = t('sidebar.space.fail.closed');
      actions = onRetry !== undefined ? (
        <button type="button" data-space-row-action="retry" disabled={busy} onClick={onRetry} className={actionButtonClass}>
          {t('common.retry')}
        </button>
      ) : null;
      break;
    case 'remote-not-approved':
      reasonText = t('sidebar.space.fail.notApproved');
      actions = onPairAgain !== undefined ? (
        <button type="button" data-space-row-action="pair-again" disabled={busy} onClick={onPairAgain} className={actionButtonClass}>
          {t('nav.scope.pairAgain')}
        </button>
      ) : null;
      break;
    case 'remote-identity-changed':
      reasonText = t('sidebar.space.fail.identityChanged');
      actions = onRemove !== undefined ? (
        <button type="button" data-space-row-action="remove" disabled={busy} onClick={onRemove} className={actionButtonClass}>
          {t('nav.scope.remove')}
        </button>
      ) : null;
      break;
    case 'remote-paused':
      reasonText = t('sidebar.space.fail.paused');
      actions = onTurnOn !== undefined ? (
        <button type="button" data-space-row-action="turn-on" disabled={busy} onClick={onTurnOn} className={actionButtonClass}>
          {t('st.remote.enable')}
        </button>
      ) : null;
      break;
    case 'remote-protocol':
      reasonText = t('sidebar.space.fail.protocol');
      actions = null;
      break;
    case 'remote-unreachable':
    default:
      reasonText = t('sidebar.space.fail.unreachable');
      actions = onRetry !== undefined ? (
        <button type="button" data-space-row-action="retry" disabled={busy} onClick={onRetry} className={actionButtonClass}>
          {t('common.retry')}
        </button>
      ) : null;
      break;
  }

  return (
    <div
      role="alert"
      data-space-row-failure={failure.kind}
      className="mx-2.5 mb-1.5 flex items-center justify-between gap-2 rounded-md bg-danger/[0.06] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink"
    >
      <p className="min-w-0 truncate text-danger" title={reasonText}>{reasonText}</p>
      {actions !== null ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
