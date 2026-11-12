/**
 * SpaceSwitchSheet — the switch panel behind the sidebar position bar (#17).
 *
 * Desktop: a 320px popover anchored under the position bar.
 * Phone touch mode: a bottom sheet capped at 70% of the viewport height,
 * scrolling the space lists while keeping the bottom actions fixed.
 *
 * A failed switch never takes over the page or pushes a toast: the panel stays
 * open and renders the failure reason plus one fitting recovery action directly
 * beneath the tapped row.
 */

import { type ReactNode, type RefObject } from 'react';
import { relativeTime } from '@kiki/session-core/util/time';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { RemoteConnection } from '@kiki/protocol';
import type { SpaceWindowMode } from '@kiki/session-core/settings';

import type { DesktopSpaceStatus } from '../host';
import { useI18n } from '../i18n';
import { usePhoneMode } from '../lib/layoutHooks';
import { browsableRemote, connectionStateTone, remoteSummaryView } from '../lib/remoteConnections';
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
  offline: 'border border-ink-faint/70',
  muted: 'bg-ink-faint/50',
};

const REMOTE_TONE_TEXT: Record<ReturnType<typeof connectionStateTone>, string> = {
  online: 'text-success',
  attention: 'text-attention',
  offline: 'text-ink-soft',
  muted: 'text-ink-faint',
};

function remoteStateLabel(record: RemoteConnection, t: (key: I18nKey, vars?: Record<string, string | number>) => string, staleTime?: string): string {
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
  readonly inRemoteScope: boolean;
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
  readonly currentConnectionId: string | null;
  readonly multi: boolean;
  readonly openingKey: string | null;
  readonly failure: SpaceRowFailure | null;
  readonly actionBusy: boolean;
  readonly switchComputerUrl: string | null;
  readonly onBackToLocal: () => void;
  readonly onSelectLocal: (space: SpaceListItem) => void;
  readonly onSelectRemote: (record: RemoteConnection) => void;
  readonly onTurnOnRemote: (recordId: string, record: RemoteConnection) => void;
  readonly onRemoveRemote: (recordId: string) => void;
  readonly onPairAgain: () => void;
  readonly onViewLog: (() => void) | undefined;
  readonly onPairRemote: () => void;
  readonly onNewSpace: (() => void) | undefined;
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
    inRemoteScope,
    localSpaceName,
    localComputerName,
    localItems,
    localLoading,
    localError,
    onRetryLocal,
    statuses,
    remoteItems,
    remoteLoading,
    remoteError,
    onRetryRemote,
    currentConnectionId,
    multi,
    openingKey,
    failure,
    actionBusy,
    switchComputerUrl,
    onBackToLocal,
    onSelectLocal,
    onSelectRemote,
    onTurnOnRemote,
    onRemoveRemote,
    onPairAgain,
    onViewLog,
    onPairRemote,
    onNewSpace,
    onManageSpaces,
  } = props;

  const busy = openingKey !== null || actionBusy;
  const group1Title = localComputerName ?? t('sidebar.space.thisComputer');
  const group2Title = t('sidebar.space.groupRemoteFrom', { space: localSpaceName });
  const onlyMainNoPairings =
    !localLoading &&
    !localError &&
    !remoteLoading &&
    !remoteError &&
    localItems.length <= 1 &&
    remoteItems.length === 0 &&
    !inRemoteScope;
  const showGroup2 = remoteError || remoteItems.length > 0;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);

  const body = (
    <div className="flex max-h-[inherit] min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-hairline px-3 pt-2.5 pb-2">
        <p className="text-[12.5px] font-medium text-ink">{t('sidebar.space.menuTitle')}</p>
        {localLoading && localItems.length === 0 ? (
          <p data-space-directory-pending role="status" className="mt-0.5 text-[11.5px] text-ink-soft">
            {t('st.spaces.loading')}
          </p>
        ) : !desktop && localItems.length > 1 ? (
          <p data-space-browser-hint className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">
            {t('sidebar.space.browserHint')}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5" data-space-switch-scroll>
        <p className="px-2.5 pt-1 pb-1 text-[11.5px] font-medium text-ink-faint" data-space-group-local>
          {group1Title}
        </p>

        {inRemoteScope ? (
          <button
            type="button"
            role="menuitem"
            data-space-back-local
            disabled={busy}
            onClick={onBackToLocal}
            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden className="shrink-0 text-ink-soft">←</span>
            <span className="min-w-0 flex-1 truncate">{t('sidebar.space.backToLocal', { space: localSpaceName })}</span>
          </button>
        ) : null}

        {localLoading && localItems.length === 0 ? (
          <div className="space-y-1 px-2.5 py-1.5" aria-hidden data-space-placeholders>
            <div className="h-8 rounded-md bg-ink/[0.04]" />
            <div className="h-8 rounded-md bg-ink/[0.04]" />
          </div>
        ) : localError && localItems.length === 0 ? (
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-ink-soft" data-space-local-error>
            <span>{t('sidebar.space.listLoadFailed')}</span>
            <button type="button" onClick={onRetryLocal}
              className="shrink-0 rounded px-2 py-0.5 text-[12px] font-medium text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent">
              {t('common.retry')}
            </button>
          </div>
        ) : (
          localItems.map((space, index) => {
            const localRun = spaceRunState(space.id, statuses);
            const run = inRemoteScope && localRun === 'current' ? 'hot' : localRun;
            const count = spaceStatus(space.id, statuses)?.pendingCount ?? 0;
            const current = run === 'current';
            const rowKey = `local:${space.id}`;
            const isOpening = openingKey === rowKey;
            const rowFailure = failure?.rowKey === rowKey ? failure : null;
            const disabled = busy || (!desktop && !current);
            const itemName = label(space);
            return (
              <div key={space.id}>
                <button
                  type="button"
                  role="menuitem"
                  data-space-switch-item={space.id}
                  data-space-state={run}
                  aria-current={current ? 'true' : undefined}
                  disabled={disabled}
                  onClick={() => { onSelectLocal(space); }}
                  className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <SpaceDot color={space.id === MAIN_SPACE_ID ? 'var(--color-ink-faint)' : space.color} />
                  <span className={`min-w-0 flex-1 truncate ${current ? 'font-medium' : ''}`} title={itemName}>{itemName}</span>
                  {isOpening ? (
                    <span className="shrink-0 text-[11.5px] text-ink-soft" data-space-row-opening>{t('sidebar.space.openingInline')}</span>
                  ) : current ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-ink-soft">
                      <Icon name="check" size={12} />{t('st.spaces.current')}
                    </span>
                  ) : desktop ? (
                    mode === 'switch' ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${run === 'hot' ? 'bg-success' : 'border border-ink-faint/70'}`} />
                        {t(run === 'hot' ? 'st.spaces.running' : 'st.spaces.notStarted')}
                        {count > 0 ? <span className="text-attention">· {t('sidebar.space.localWaiting', { count })}</span> : null}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11.5px] text-ink-faint">{t('sidebar.space.openWindow')}</span>
                    )
                  ) : null}
                  {desktop && index < 9 && multi ? (
                    <kbd className="hidden shrink-0 font-mono text-[10.5px] text-ink-faint md:inline pointer-coarse:hidden">⌃⌥{index + 1}</kbd>
                  ) : null}
                </button>
                {rowFailure !== null ? (
                  <InlineRowFailure
                    failure={rowFailure}
                    busy={actionBusy}
                    onRetry={() => { onSelectLocal(space); }}
                    onViewLog={onViewLog}
                  />
                ) : null}
              </div>
            );
          })
        )}

        {onlyMainNoPairings ? (
          <p data-space-single-hint className="px-2.5 pt-1.5 pb-1 text-[12px] leading-[1.45] text-ink-soft">
            {t('sidebar.space.singleHint')}
          </p>
        ) : null}

        {showGroup2 ? (
          <>
            <div className="mx-1.5 my-1.5 border-t border-hairline" />
            <p className="px-2.5 pt-0.5 pb-1 text-[11.5px] font-medium text-ink-faint" data-space-group-remote>
              {group2Title}
            </p>
            {remoteError && remoteItems.length === 0 ? (
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-ink-soft" data-space-remote-error>
                <span>{t('sidebar.space.listLoadFailed')}</span>
                <button type="button" onClick={onRetryRemote}
                  className="shrink-0 rounded px-2 py-0.5 text-[12px] font-medium text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent">
                  {t('common.retry')}
                </button>
              </div>
            ) : (
              (() => {
                let browsableOffset = 0;
                return remoteItems.map((record) => {
                  const rowKey = `remote:${record.id}`;
                  const rowFailure = failure?.rowKey === rowKey ? failure : null;
                  const canShortcut = browsableRemote(record);
                  const shortcutIndex = canShortcut ? (desktop ? localItems.length : 0) + browsableOffset++ : -1;
                  return (
                    <div key={record.id}>
                      <RemoteSpaceRow
                        record={record}
                        current={currentConnectionId === record.id}
                        opening={openingKey === rowKey}
                        disabled={busy}
                        shortcut={shortcutIndex + 1}
                        showShortcut={desktop && canShortcut && shortcutIndex < 9 && multi}
                        onEnter={() => { onSelectRemote(record); }}
                      />
                      {rowFailure !== null ? (
                        <InlineRowFailure
                          failure={rowFailure}
                          busy={actionBusy}
                          onRetry={() => { onSelectRemote(record); }}
                          onTurnOn={() => { onTurnOnRemote(record.id, record); }}
                          onRemove={() => { onRemoveRemote(record.id); }}
                          onPairAgain={onPairAgain}
                        />
                      ) : null}
                    </div>
                  );
                });
              })()
            )}
          </>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-hairline px-1 pt-1 pb-1" data-space-switch-footer>
        {onNewSpace !== undefined ? (
          <button
            type="button"
            role="menuitem"
            data-space-new-entry
            disabled={busy}
            onClick={onNewSpace}
            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:opacity-50"
          >
            <Icon name="plus" size={14} className="shrink-0 text-ink-soft" />
            <span className="truncate">{t('sidebar.space.new')}</span>
          </button>
        ) : null}
        <button
          type="button"
          role="menuitem"
          data-space-pair-entry
          disabled={busy}
          onClick={onPairRemote}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:opacity-50"
        >
          <Icon name="plus" size={14} className="shrink-0 text-ink-soft" />
          <span className="truncate">{t('sidebar.space.pairRemote')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-space-manage
          disabled={busy}
          onClick={onManageSpaces}
          className="flex min-h-9 w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-soft outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:bg-paper disabled:opacity-50"
        >
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
            className="flex min-h-9 w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-soft outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:bg-paper disabled:opacity-50"
          >
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
      widthClassName="w-[320px]"
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

function RemoteSpaceRow({
  record,
  current,
  opening,
  disabled,
  shortcut,
  showShortcut,
  onEnter,
}: {
  readonly record: RemoteConnection;
  readonly current: boolean;
  readonly opening: boolean;
  readonly disabled: boolean;
  readonly shortcut: number;
  readonly showShortcut: boolean;
  readonly onEnter: () => void;
}) {
  const { t, locale } = useI18n();
  const summary = remoteSummaryView(record);
  const stale = summary !== null && summary.stale && summary.asOf !== undefined;
  const staleTime = stale && summary?.asOf !== undefined
    ? t('sidebar.space.remoteAsOf', { time: relativeTime(new Date(summary.asOf).toISOString(), locale) })
    : undefined;
  const tone = connectionStateTone(record.state);
  const stateText = opening ? t('sidebar.space.openingInline') : remoteStateLabel(record, t, staleTime);

  return (
    <button
      type="button"
      role="menuitem"
      data-space-remote-item={record.id}
      data-space-remote-state={record.state}
      data-space-remote-stale={stale ? '' : undefined}
      aria-current={current ? 'true' : undefined}
      disabled={disabled}
      onClick={onEnter}
      className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-55"
    >
      <Icon name="web" size={14} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 py-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate ${current ? 'font-medium' : ''}`} title={record.label}>
            {record.label}
          </span>
          {current ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-ink-soft">
              <Icon name="check" size={12} />{t('st.spaces.current')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ink-faint">
          <span className={`inline-flex shrink-0 items-center gap-1 ${opening ? 'text-ink-soft' : REMOTE_TONE_TEXT[tone]}`} data-remote-state={record.state}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${REMOTE_TONE_DOT[tone]}`} />
            {stateText}
          </span>
          {!opening && summary !== null && summary.busy > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span data-space-remote-busy className="tabular-nums">{t('sidebar.space.remoteBusy', { count: summary.busy })}</span>
            </>
          ) : null}
          {!opening && summary !== null && summary.needsYou > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span data-space-remote-needs className="tabular-nums text-attention">{t('sidebar.space.remoteNeedsYou', { count: summary.needsYou })}</span>
            </>
          ) : null}
        </span>
      </span>
      {showShortcut ? (
        <kbd className="hidden shrink-0 font-mono text-[10.5px] text-ink-faint md:inline pointer-coarse:hidden">⌃⌥{shortcut}</kbd>
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
    'rounded px-1.5 py-0.5 text-[11.5px] font-medium text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent disabled:opacity-50';

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
      className="mx-2.5 mb-1.5 rounded-md bg-danger/[0.06] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink"
    >
      <p className="text-danger">{reasonText}</p>
      {actions !== null ? <div className="mt-1">{actions}</div> : null}
    </div>
  );
}
