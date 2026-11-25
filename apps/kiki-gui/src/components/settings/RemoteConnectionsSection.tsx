/**
 * Settings → Spaces: "Spaces on other computers" (outbound paired spaces plus
 * saved Owner (SSH) profiles).
 *
 * The records belong to the local control home's server. While a space on
 * another computer is open this section still reads that home, and names it in
 * the section title so nobody configures B thinking they are configuring A.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { RemoteConnection } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { isDesktopHost } from '../../host/host';
import { useI18n } from '../../i18n';
import { isLocalOwnerRequiredError, isPeerConnectionSource } from '../../lib/peerAccess';
import {
  browsableRemote, connectionAddress, connectionsApi, fingerprint, hasGuiPurpose,
  remoteConnectionKeys, remoteSummaryView, spacePlatformLabel, useRemoteConnections,
} from '../../lib/remoteConnections';
import {
  hasThreadBridgesApi,
  remoteThreadMessageDirection,
  threadBridgeKeys,
  threadMessageFactKey,
  useThreadBridges,
  type ThreadMessageFact,
} from '../../lib/threadBridges';
import { useSpaceSettingsTarget } from '../../lib/spaceSettings';
import { MAIN_SPACE_ID, useSpaces } from '../../lib/spaces';
import { pushToast, UNDO_TOAST_MS } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SpaceRowMenu } from './spaces/SpaceRowMenu';
import { PairSheet } from './remote/PairSheet';
import { ThreadMessagesPanel } from './remote/ThreadMessagesPanel';
import { RemoteStateChip, connectionFailureText } from './remote/parts';
import { useRemoteSpaceEntry } from './remote/useRemoteSpaceEntry';

export function RemoteConnectionsSection() {
  const host = useHost();
  const { client, localClient, connectionId, sshLabel, connectionSource } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const inRemoteScope = Boolean(connectionId) || Boolean(sshLabel) || isPeerConnectionSource(connectionSource);
  const control = isDesktopHost(host) ? localClient : (localClient ?? (inRemoteScope ? null : client));
  const connections = useRemoteConnections(control);
  const threadBridges = useThreadBridges(control);
  const bridgesAvailable = hasThreadBridgesApi(control);
  const controlTarget = useSpaceSettingsTarget(control);
  const [dialog, setDialog] = useState<
    | { kind: 'add' }
    | { kind: 'remove'; record: RemoteConnection }
    | { kind: 'thread-messages'; record: RemoteConnection }
    | null
  >(null);
  const [menu, setMenu] = useState<{ record: RemoteConnection; anchor: DOMRect; anchorElement: HTMLElement } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const records = connections.data ?? [];
  const api = control === null ? null : connectionsApi(control);
  const enterRemoteSpace = useRemoteSpaceEntry();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
    void queryClient.invalidateQueries({ queryKey: threadBridgeKeys.all });
  };

  const run = (record: RemoteConnection, work: (api: ReturnType<typeof connectionsApi>) => Promise<unknown>, done: Feedback) => {
    if (api === null) return;
    setBusyId(record.id);
    setFeedback(null);
    void work(api)
      .then(() => { setFeedback(done); refresh(); })
      .catch((error: unknown) => {
        const reason = connectionFailureText(error instanceof Error ? error.message : '');
        setFeedback({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
      })
      .finally(() => { setBusyId(null); });
  };

  const controlHome = controlTarget?.identity.homeId;
  const spaceList = useSpaces(controlHome !== undefined && controlHome !== MAIN_SPACE_ID ? control : null);
  const controlHomeLabel = controlHome === undefined ? undefined
    : controlHome === MAIN_SPACE_ID ? t('st.spaces.main')
    : spaceList.data?.find((item) => item.id === controlHome)?.name;
  const sectionTitle = controlHomeLabel !== undefined
    ? t('st.remote.outboundTitleFrom', { space: controlHomeLabel })
    : t('st.remote.outboundTitle');
  const sourceLine = control === null
    ? t('st.remote.controlUnavailable')
    : controlHomeLabel === undefined
      ? t('st.remote.configuresNoHome', { origin: connectionAddress(control.baseUrl) })
      : undefined;

  return (
    <SectionCard id="st-card-remote-connections" title={sectionTitle} scope="server"
      aside={sourceLine === undefined ? undefined : <span data-remote-source>{sourceLine}</span>}
      actions={control === null ? undefined : (
        <button type="button" data-remote-add className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
          onClick={() => { setDialog({ kind: 'add' }); }}>
          <Icon name="plus" size={12} />{t('st.remote.add')}
        </button>
      )}>
      <div className="space-y-4" data-remote-connections>
        {connections.isLoading ? <Hint>{t('st.remote.loading')}</Hint> : null}
        {connections.isError ? (
          isLocalOwnerRequiredError(connections.error)
            ? <Hint>{t('st.remote.controlUnavailable')}</Hint>
            : <InlineError error={connections.error} />
        ) : null}

        {connections.isSuccess && records.length === 0 ? (
          <p className="text-[13px] text-ink-soft" data-remote-empty>{t('st.remote.emptyLine')}</p>
        ) : null}

        {records.length > 0 ? (
          <div role="list" aria-label={t('st.remote.outboundTitle')} className="space-y-1.5" data-remote-list>
            {records.map((record) => {
              const threadFact: ThreadMessageFact | null = !bridgesAvailable || threadBridges.isLoading
                ? (!bridgesAvailable ? 'unreadable' : null)
                : threadBridges.isError || threadBridges.data === undefined
                  ? 'unreadable'
                  : remoteThreadMessageDirection(record, threadBridges.data);
              return (
                <RemoteConnectionRow
                  key={record.id}
                  record={record}
                  busy={busyId === record.id}
                  threadFact={threadFact}
                  onEnter={() => { void enterRemoteSpace(record.id, record.label); }}
                  onVerifyFingerprint={api === null ? undefined : () => {
                    run(
                      record,
                      (connection) => connection.verifyFingerprint(record.id),
                      { tone: 'success', text: t('st.remote.fingerprintVerified', { name: record.label }) },
                    );
                  }}
                  onMenu={(anchor, element) => { setMenu({ record, anchor, anchorElement: element }); }}
                />
              );
            })}
          </div>
        ) : null}

        <FeedbackLine feedback={feedback} />
      </div>

      {menu !== null ? (
        <SpaceRowMenu anchor={menu.anchor} anchorElement={menu.anchorElement} ariaLabel={t('st.remote.menuAria', { name: menu.record.label })}
          onClose={() => { setMenu(null); }}
          items={[
            {
              key: 'thread-messages',
              label: t('st.remote.threadMessages.menu'),
              blockedReason: bridgesAvailable ? undefined : t('st.remote.controlUnavailable'),
              run: () => { setDialog({ kind: 'thread-messages', record: menu.record }); },
            },
            ...(hasGuiPurpose(menu.record) ? [{
              key: 'retry',
              label: t('st.remote.retry'),
              blockedReason: menu.record.enabled ? undefined : t('st.remote.blocked.disabled'),
              run: () => { run(menu.record, (connection) => connection.retry(menu.record.id), { tone: 'success', text: t('st.remote.retried', { name: menu.record.label }) }); },
            }, {
              key: 'toggle',
              label: menu.record.enabled ? t('st.remote.disable') : t('st.remote.enable'),
              run: () => {
                const next = !menu.record.enabled;
                run(menu.record, (connection) => connection.setEnabled(menu.record.id, next),
                  { tone: 'success', text: t(next ? 'st.remote.enabled' : 'st.remote.disabled', { name: menu.record.label }) });
              },
            }] : []),
            {
              key: 'remove',
              label: t('st.remote.removeMenu'),
              danger: true,
              separatorBefore: true,
              run: () => { setDialog({ kind: 'remove', record: menu.record }); },
            },
          ]} />
      ) : null}

      {dialog?.kind === 'thread-messages' && control !== null ? (
        <ThreadMessagesPanel
          client={control}
          subject={{ kind: 'outbound', record: dialog.record }}
          onClose={() => { setDialog(null); }}
        />
      ) : null}

      {dialog?.kind === 'add' && control !== null ? (
        <PairSheet
          client={control}
          direction="outbound"
          onClose={() => { setDialog(null); }}
          onPaired={(record) => {
            setDialog(null);
            refresh();
            pushToast({
              tone: 'success',
              text: record.fingerprintToVerify === undefined
                ? t('st.remote.added', { name: record.label })
                : t('st.remote.addedWithFingerprint', { name: record.label, fingerprint: fingerprint(record.fingerprintToVerify, 16, 8) }),
              durationMs: UNDO_TOAST_MS,
              action: browsableRemote(record)
                ? { label: t('st.remote.enter'), run: () => { void enterRemoteSpace(record.id, record.label); } }
                : undefined,
            });
          }}
        />
      ) : null}

      {dialog?.kind === 'remove' && control !== null ? (
        <ConfirmDialog open overlayId="remote-connection-remove" tone="danger"
          title={t('st.remote.removeTitle', { name: dialog.record.label })}
          body={t('st.remote.removeBody', { name: dialog.record.label })}
          confirmLabel={t('st.remote.removeConfirm')}
          onCancel={() => { setDialog(null); }}
          onConfirm={() => {
            const record = dialog.record;
            setDialog(null);
            run(record, (connection) => connection.remove(record.id), { tone: 'success', text: t('st.remote.removed', { name: record.label }) });
          }} />
      ) : null}
    </SectionCard>
  );
}

function RemoteConnectionRow({ record, busy, threadFact, onEnter, onVerifyFingerprint, onMenu }: {
  record: RemoteConnection;
  busy: boolean;
  threadFact: ThreadMessageFact | null;
  onEnter: () => void;
  onVerifyFingerprint?: () => void;
  onMenu: (anchor: DOMRect, element: HTMLElement) => void;
}) {
  const { t, tp, locale } = useI18n();
  const summary = remoteSummaryView(record);
  const canOpen = hasGuiPurpose(record) && record.enabled;
  const enterable = browsableRemote(record);
  const staleLabel = summary !== null && summary.stale && summary.asOf !== undefined
    ? t('st.remote.asOf', { time: relativeTime(new Date(summary.asOf).toISOString(), locale) })
    : undefined;
  const failure = record.lastError === undefined ? null : connectionFailureText(record.lastError);
  const hasCounts = summary !== null && (summary.busy > 0 || summary.needsYou > 0);
  const platformLabel = spacePlatformLabel(summary?.platform);
  const rttMs = record.state === 'online' ? (summary?.rttMs ?? record.rttMs) : undefined;
  const borrowableTools = summary?.borrowableTools;
  return (
    <div role="listitem" data-remote-connection={record.id} data-remote-purpose={record.purposes.join('+')}
      data-remote-stale={summary !== null && summary.stale ? '' : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-ink/[0.03] px-3 py-2">
      <Icon name="web" size={14} className="shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 max-w-full truncate text-[13px] font-normal text-ink" title={record.label}>{record.label}</span>
          <RemoteStateChip state={record.state} staleLabel={staleLabel} />
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" data-remote-address title={record.endpoint}>
          {connectionAddress(record.endpoint)}
          {record.lastConnectedAt !== undefined ? ` · ${relativeTime(new Date(record.lastConnectedAt).toISOString(), locale)}` : ''}
        </p>
        {record.fingerprintToVerify !== undefined ? (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ink-faint" data-remote-fingerprint-to-verify title={record.fingerprintToVerify}>
            <span className="shrink-0">{t('st.remote.fingerprintToVerify')}:</span>
            <span className="whitespace-nowrap font-mono text-ink-soft">{fingerprint(record.fingerprintToVerify, 16, 8)}</span>
            {onVerifyFingerprint !== undefined ? (
              <button
                type="button"
                data-remote-verify-fingerprint={record.id}
                disabled={busy}
                onClick={onVerifyFingerprint}
                className="rounded px-1.5 py-0.5 text-[11px] font-normal text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent disabled:opacity-50"
              >
                {t('st.remote.verifyFingerprint')}
              </button>
            ) : null}
          </p>
        ) : null}
        {record.pinnedFingerprint !== undefined ? (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-ink-faint" data-remote-pinned-fingerprint title={record.pinnedFingerprint}>
            <span className="shrink-0">{t('st.remote.pinnedFingerprint')}:</span>
            <span className="whitespace-nowrap font-mono text-ink-soft">{fingerprint(record.pinnedFingerprint, 16, 8)}</span>
          </p>
        ) : null}
        <div className="mt-0.5 overflow-hidden">
          <p className="flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-[11.5px] text-ink-faint" data-remote-facts>
            {platformLabel !== undefined ? (
              <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] leading-[18px] text-ink-soft" data-remote-platform={summary?.platform}>
                {platformLabel}
              </span>
            ) : null}
            {rttMs !== undefined ? (
              <span className="relative inline-flex items-center tabular-nums before:pointer-events-none before:absolute before:-left-2 before:text-ink-faint before:content-['·']" data-remote-rtt>
                {rttMs} ms
              </span>
            ) : null}
            {borrowableTools !== undefined && borrowableTools > 0 ? (
              <span className="relative inline-flex items-center tabular-nums before:pointer-events-none before:absolute before:-left-2 before:text-ink-faint before:content-['·']" data-remote-tools>
                {tp('st.remote.borrowableTools', borrowableTools)}
              </span>
            ) : null}
            <span className="relative inline-flex items-center before:pointer-events-none before:absolute before:-left-2 before:text-ink-faint before:content-['·']" data-remote-openable={canOpen ? 'yes' : 'no'}>
              {t(canOpen ? 'st.remote.canOpen' : 'st.remote.cantOpen')}
            </span>
            {threadFact !== null ? (
              <span
                className={`relative inline-flex items-center before:pointer-events-none before:absolute before:-left-2 before:text-ink-faint before:content-['·']${threadFact === 'unreadable' ? ' text-amber-ink' : ''}`}
                data-remote-thread-messages={threadFact}
              >
                {t(threadMessageFactKey(threadFact))}
              </span>
            ) : null}
            {hasCounts ? (
              <span className="contents" data-remote-summary>
                {summary.busy > 0 ? (
                  <span className="relative inline-flex items-center tabular-nums before:pointer-events-none before:absolute before:-left-2 before:text-ink-faint before:content-['·']">
                    {t('st.remote.busy', { count: summary.busy })}
                  </span>
                ) : null}
                {summary.needsYou > 0 ? (
                  <span className="relative inline-flex items-center tabular-nums text-attention before:pointer-events-none before:absolute before:-left-2 before:text-ink-faint before:content-['·']">
                    {t('st.remote.needsYou', { count: summary.needsYou })}
                  </span>
                ) : null}
              </span>
            ) : null}
          </p>
        </div>
        {!hasGuiPurpose(record) ? (
          <p className="mt-0.5 text-[11px] text-ink-faint" data-remote-bridge-only>
            {t('st.remote.bridgeOnly')}
          </p>
        ) : null}
        {failure !== null && record.state !== 'online' ? (
          <p className="mt-0.5 truncate text-[11.5px] text-amber-ink" data-remote-error title={record.lastError}>
            {t(failure)}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {enterable ? (
          <button type="button" data-remote-enter={record.id} className={SECONDARY_BUTTON} disabled={busy} onClick={onEnter}>
            {t('st.remote.enter')}
          </button>
        ) : null}
        <button type="button" data-remote-menu={record.id} aria-haspopup="menu" disabled={busy}
          aria-label={t('st.remote.menuAria', { name: record.label })}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          onClick={(event) => { onMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget); }}>
          <Icon name="more" size={14} />
        </button>
      </div>
    </div>
  );
}
