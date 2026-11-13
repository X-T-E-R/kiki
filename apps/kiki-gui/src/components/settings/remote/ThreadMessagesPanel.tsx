/**
 * ThreadMessagesPanel — inspects, toggles, and revokes the thread-message
 * permissions belonging to a single pairing (`RemoteConnection` on Spaces, or
 * `ConnectionGrant` on Access → Other spaces).
 *
 * Renders as a `SidePanel` (right sheet on desktop, full-height sheet on
 * phone). All reads and writes go through the window's own control client.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { BridgeOperation, BridgeStatus, ConnectionGrant, RemoteConnection } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  listInboundGrantBridges,
  listRemotePairingBridges,
  sanitizeRemoteWorkspaceLabel,
  threadBridgeKeys,
  threadBridgesApi,
  useThreadBridges,
  type PairingBridgeEntry,
} from '../../../lib/threadBridges';
import { ConfirmDialog } from '../../ConfirmDialog';
import { SidePanel } from '../../SidePanel';
import { FeedbackLine, Hint, type Feedback } from '../../controls';
import { DANGER_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { connectionFailureText } from './parts';

export type ThreadMessagesSubject =
  | { readonly kind: 'outbound'; readonly record: RemoteConnection }
  | { readonly kind: 'inbound'; readonly grant: ConnectionGrant };

const OPERATION_KEYS: Readonly<Record<BridgeOperation, I18nKey>> = {
  read: 'st.remote.threadMessages.op.read',
  send: 'st.remote.threadMessages.op.send',
  wait: 'st.remote.threadMessages.op.wait',
  wake: 'st.remote.threadMessages.op.wake',
  create: 'st.remote.threadMessages.op.create',
};

const OPERATION_ORDER: readonly BridgeOperation[] = ['read', 'send', 'wait', 'wake', 'create'];

function formatExpiryDate(expiresAt: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(expiresAt));
  } catch {
    return new Date(expiresAt).toISOString().slice(0, 10);
  }
}

export function ThreadMessagesPanel({
  client,
  subject,
  onClose,
}: {
  readonly client: KikiClient;
  readonly subject: ThreadMessagesSubject;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const peerName = subject.kind === 'outbound' ? subject.record.label : subject.grant.label;
  const bridgesQuery = useThreadBridges(client);

  const canReadWorkspaces = typeof client.listWorkspaceCatalog === 'function' || typeof client.listWorkspaces === 'function';
  const localWorkspacesQuery = useQuery({
    queryKey: [...threadBridgeKeys.localWorkspaces(), client.baseUrl ?? null],
    queryFn: async () => {
      if (typeof client.listWorkspaceCatalog === 'function') {
        const res = await client.listWorkspaceCatalog();
        return res.items;
      }
      if (typeof client.listWorkspaces === 'function') {
        const res = await client.listWorkspaces();
        return res.items;
      }
      return [];
    },
    enabled: canReadWorkspaces,
    staleTime: 30_000,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<PairingBridgeEntry | null>(null);

  const entries: PairingBridgeEntry[] = bridgesQuery.data === undefined
    ? []
    : subject.kind === 'outbound'
      ? listRemotePairingBridges(subject.record, bridgesQuery.data)
      : listInboundGrantBridges(subject.grant, bridgesQuery.data);

  const localWorkspaceNames = new Map<string, string>();
  for (const ws of localWorkspacesQuery.data ?? []) {
    localWorkspaceNames.set(ws.id, ws.name);
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: threadBridgeKeys.all });
  };

  const runToggle = (entry: PairingBridgeEntry) => {
    const nextEnabled = !entry.enabled;
    setBusyId(entry.id);
    setFeedback(null);
    void threadBridgesApi(client)
      .setEnabled(entry.direction, entry.id, nextEnabled)
      .then((nextStatus: BridgeStatus) => {
        queryClient.setQueryData([...threadBridgeKeys.status(), client.baseUrl ?? null], nextStatus);
        refresh();
        setFeedback({
          tone: 'success',
          text: t(nextEnabled ? 'st.remote.threadMessages.turnedOn' : 'st.remote.threadMessages.turnedOff'),
        });
      })
      .catch((error: unknown) => {
        const reason = connectionFailureText(error instanceof Error ? error.message : '');
        setFeedback({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
      })
      .finally(() => { setBusyId(null); });
  };

  const runRevoke = (entry: PairingBridgeEntry) => {
    setConfirmRevoke(null);
    setBusyId(entry.id);
    setFeedback(null);
    void threadBridgesApi(client)
      .revoke(entry.direction, entry.id)
      .then((nextStatus: BridgeStatus) => {
        queryClient.setQueryData([...threadBridgeKeys.status(), client.baseUrl ?? null], nextStatus);
        refresh();
        setFeedback({ tone: 'success', text: t('st.remote.threadMessages.revoked') });
      })
      .catch((error: unknown) => {
        const reason = connectionFailureText(error instanceof Error ? error.message : '');
        setFeedback({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
      })
      .finally(() => { setBusyId(null); });
  };

  const directionText = (entry: PairingBridgeEntry) =>
    entry.direction === 'outbound'
      ? t('st.remote.threadMessages.dirOutgoing', { space: peerName })
      : t('st.remote.threadMessages.dirIncoming', { space: peerName });

  return (
    <>
      <SidePanel
        title={t('st.remote.threadMessages.title')}
        description={t('st.remote.threadMessages.description', { name: peerName })}
        overlayId="thread-messages-panel"
        onClose={onClose}
        data={{ 'data-thread-messages-panel': subject.kind === 'outbound' ? subject.record.id : subject.grant.id }}
        footer={(
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose} data-thread-messages-close>
            {t('common.close')}
          </button>
        )}
      >
        <div className="space-y-4">
          {bridgesQuery.isLoading ? <Hint>{t('st.remote.loading')}</Hint> : null}

          {bridgesQuery.isError ? (
            <p className="text-[13px] text-amber-ink" role="alert" data-thread-messages-error>
              {t('st.remote.threadMessages.loadError')}
            </p>
          ) : null}

          {bridgesQuery.isSuccess && entries.length === 0 ? (
            <p className="text-[13px] text-ink-soft" data-thread-messages-empty>
              {t('st.remote.threadMessages.empty', { name: peerName })}
            </p>
          ) : null}

          {entries.length > 0 ? (
            <div className="space-y-3" data-thread-messages-list>
              {entries.map((entry) => {
                const localWsName = localWorkspaceNames.get(entry.localScope.workspaceId)
                  ?? sanitizeRemoteWorkspaceLabel(entry.localScope.workspaceId)
                  ?? t('st.remote.threadMessages.scopeUnknownLocal');
                const remoteWsName = sanitizeRemoteWorkspaceLabel(entry.remoteScope.workspaceId)
                  ?? t('st.remote.threadMessages.scopeRemoteWorkspace');
                const localThreadScope = entry.localScope.sessionId !== undefined
                  ? t('st.remote.threadMessages.scopeOneThread')
                  : t('st.remote.threadMessages.scopeAllThreads');
                const remoteThreadScope = entry.remoteScope.sessionId !== undefined
                  ? t('st.remote.threadMessages.scopeOneThread')
                  : t('st.remote.threadMessages.scopeAllThreads');
                const providedOperations = new Set<string>(entry.operations);
                const orderedOps = OPERATION_ORDER.filter((op) => providedOperations.has(op));
                const hasWake = entry.operations.includes('wake');
                const statusChip = entry.expired
                  ? { label: t('st.remote.threadMessages.stateExpired'), dot: 'bg-attention', text: 'text-amber-ink' }
                  : entry.enabled
                    ? { label: t('st.remote.threadMessages.stateOn'), dot: 'bg-success', text: 'text-ink-soft' }
                    : { label: t('st.remote.threadMessages.stateOff'), dot: 'bg-ink-faint/50', text: 'text-ink-faint' };
                const isBusy = busyId === entry.id;

                return (
                  <section
                    key={`${entry.direction}:${entry.id}`}
                    data-thread-message-entry={entry.id}
                    data-thread-message-direction={entry.direction}
                    className="space-y-2.5 rounded-lg border border-hairline bg-ink/[0.02] px-3.5 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-[13.5px] font-medium text-ink" data-thread-message-heading>
                        {directionText(entry)}
                      </h3>
                      <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${statusChip.text}`} data-thread-message-state>
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${statusChip.dot}`} />
                        {statusChip.label}
                      </span>
                    </div>

                    <dl className="space-y-1.5 text-[12px]">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <dt className="text-ink-faint">{t('st.remote.threadMessages.scopeLocalLabel')}</dt>
                        <dd className="text-ink-soft" data-thread-message-local-scope>
                          <span className="font-medium text-ink">{localWsName}</span>
                          <span className="text-ink-faint">{` · ${localThreadScope}`}</span>
                        </dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <dt className="text-ink-faint">{t('st.remote.threadMessages.scopeRemoteLabel', { space: peerName })}</dt>
                        <dd className="text-ink-soft" data-thread-message-remote-scope>
                          <span className="font-medium text-ink">{remoteWsName}</span>
                          <span className="text-ink-faint">{` · ${remoteThreadScope}`}</span>
                        </dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <dt className="text-ink-faint">{t('st.remote.threadMessages.operationsLabel')}</dt>
                        <dd className="text-ink" data-thread-message-operations>
                          {orderedOps.map((op) => t(OPERATION_KEYS[op])).join(' · ')}
                        </dd>
                      </div>
                    </dl>

                    {!hasWake ? (
                      <p className="text-[11.5px] leading-snug text-ink-faint" data-thread-message-no-wake>
                        {t('st.remote.threadMessages.noWakeNote')}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2.5">
                      <span className="text-[11.5px] text-ink-faint tabular-nums" data-thread-message-expiry>
                        {t('st.remote.threadMessages.expiresOn', { date: formatExpiryDate(entry.grant.expiresAt, locale) })}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          disabled={isBusy || entry.expired}
                          data-thread-message-toggle={entry.id}
                          onClick={() => { runToggle(entry); }}
                        >
                          {entry.enabled ? t('st.remote.threadMessages.turnOff') : t('st.remote.threadMessages.turnOn')}
                        </button>
                        <button
                          type="button"
                          className={DANGER_BUTTON}
                          disabled={isBusy}
                          data-thread-message-revoke={entry.id}
                          onClick={() => { setConfirmRevoke(entry); }}
                        >
                          {t('st.remote.threadMessages.revokeMenu')}
                        </button>
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : null}

          <FeedbackLine feedback={feedback} />
        </div>
      </SidePanel>

      {confirmRevoke !== null ? (
        <ConfirmDialog
          open
          stacked
          overlayId="thread-message-revoke"
          tone="danger"
          title={t('st.remote.threadMessages.revokeTitle')}
          body={t('st.remote.threadMessages.revokeBody', {
            direction: directionText(confirmRevoke),
            name: peerName,
          })}
          confirmLabel={t('st.remote.threadMessages.revokeConfirm')}
          onCancel={() => { setConfirmRevoke(null); }}
          onConfirm={() => { runRevoke(confirmRevoke); }}
        />
      ) : null}
    </>
  );
}
