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
import { remoteConnectionKeys } from '../../../lib/remoteConnections';
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
import { Icon } from '../../icons';
import { DANGER_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
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
  tools: 'st.remote.threadMessages.op.tools',
};

const OPERATION_ORDER: readonly BridgeOperation[] = ['read', 'send', 'wait', 'wake', 'create', 'tools'];

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
  const [syncing, setSyncing] = useState(false);
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

  const applyStatus = (nextStatus: BridgeStatus, successText: string) => {
    queryClient.setQueryData([...threadBridgeKeys.status(), client.baseUrl ?? null], nextStatus);
    refresh();
    setFeedback({ tone: 'success', text: successText });
  };

  const handleError = (error: unknown) => {
    const reason = connectionFailureText(error instanceof Error ? error.message : '');
    setFeedback({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
  };

  const runSync = () => {
    if (subject.kind !== 'outbound') return;
    setSyncing(true);
    setFeedback(null);
    void threadBridgesApi(client)
      .syncConnection(subject.record.id, { borrowTools: true })
      .then((nextStatus: BridgeStatus) => {
        void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
        applyStatus(nextStatus, t('st.remote.threadMessages.synced'));
      })
      .catch(handleError)
      .finally(() => { setSyncing(false); });
  };

  const runToggle = (entry: PairingBridgeEntry) => {
    const nextEnabled = !entry.enabled;
    setBusyId(entry.id);
    setFeedback(null);
    void threadBridgesApi(client)
      .setEnabled(entry.direction, entry.id, nextEnabled)
      .then((nextStatus: BridgeStatus) => {
        applyStatus(nextStatus, t(nextEnabled ? 'st.remote.threadMessages.turnedOn' : 'st.remote.threadMessages.turnedOff'));
      })
      .catch(handleError)
      .finally(() => { setBusyId(null); });
  };

  const runSetBorrowTools = (entry: PairingBridgeEntry, nextBorrowTools: boolean) => {
    setBusyId(entry.id);
    setFeedback(null);
    void threadBridgesApi(client)
      .setBorrowTools(entry.id, nextBorrowTools)
      .then((nextStatus: BridgeStatus) => {
        applyStatus(nextStatus, t(nextBorrowTools ? 'st.remote.threadMessages.borrowToolsOn' : 'st.remote.threadMessages.borrowToolsOff'));
      })
      .catch(handleError)
      .finally(() => { setBusyId(null); });
  };

  const runToggleOperation = (entry: PairingBridgeEntry, op: BridgeOperation) => {
    const activeSet = new Set<BridgeOperation>(entry.operations);
    if (activeSet.has(op)) {
      if (activeSet.size <= 1) return;
      activeSet.delete(op);
    } else {
      activeSet.add(op);
    }
    const nextOperations = OPERATION_ORDER.filter((candidate) => activeSet.has(candidate));
    if (nextOperations.length === 0) return;
    setBusyId(entry.id);
    setFeedback(null);
    void threadBridgesApi(client)
      .setOperations(entry.id, nextOperations)
      .then((nextStatus: BridgeStatus) => {
        applyStatus(nextStatus, t('st.remote.threadMessages.operationsUpdated'));
      })
      .catch(handleError)
      .finally(() => { setBusyId(null); });
  };

  const runRevoke = (entry: PairingBridgeEntry) => {
    setConfirmRevoke(null);
    setBusyId(entry.id);
    setFeedback(null);
    void threadBridgesApi(client)
      .revoke(entry.direction, entry.id)
      .then((nextStatus: BridgeStatus) => {
        applyStatus(nextStatus, t('st.remote.threadMessages.revoked'));
      })
      .catch(handleError)
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
            <div className="space-y-3" data-thread-messages-empty>
              <p className="text-[13px] text-ink-soft">
                {t('st.remote.threadMessages.empty', { name: peerName })}
              </p>
              {subject.kind === 'outbound' ? (
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  disabled={syncing || busyId !== null}
                  data-thread-messages-sync
                  onClick={() => { runSync(); }}
                >
                  {syncing ? t('st.remote.threadMessages.syncing') : t('st.remote.threadMessages.syncAction')}
                </button>
              ) : null}
            </div>
          ) : null}

          {entries.length > 0 ? (
            <div className="space-y-3" data-thread-messages-list>
              {entries.map((entry) => {
                const localWsName = entry.localScope.workspaceId === '*'
                  ? t('st.remote.threadMessages.scopeAllWorkspaces')
                  : (localWorkspaceNames.get(entry.localScope.workspaceId)
                    ?? sanitizeRemoteWorkspaceLabel(entry.localScope.workspaceId)
                    ?? t('st.remote.threadMessages.scopeUnknownLocal'));
                const remoteWsName = entry.remoteScope.workspaceId === '*'
                  ? t('st.remote.threadMessages.scopeAllWorkspaces')
                  : (sanitizeRemoteWorkspaceLabel(entry.remoteScope.workspaceId)
                    ?? t('st.remote.threadMessages.scopeRemoteWorkspace'));
                const localThreadScope = entry.localScope.sessionId !== undefined
                  ? t('st.remote.threadMessages.scopeOneThread')
                  : t('st.remote.threadMessages.scopeAllThreads');
                const remoteThreadScope = entry.remoteScope.sessionId !== undefined
                  ? t('st.remote.threadMessages.scopeOneThread')
                  : t('st.remote.threadMessages.scopeAllThreads');
                const providedOperations = new Set<BridgeOperation>(entry.operations);
                const orderedOps = OPERATION_ORDER.filter((op) => providedOperations.has(op));
                const hasWake = entry.operations.includes('wake');
                const canBorrowTools = entry.direction === 'outbound' && entry.operations.includes('tools');
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
                      {entry.direction === 'inbound' ? (
                        <div className="space-y-1.5 pt-0.5">
                          <dt className="text-ink-faint">{t('st.remote.threadMessages.operationsLabel')}</dt>
                          <dd className="flex flex-wrap gap-1.5" data-thread-message-operations>
                            {OPERATION_ORDER.map((op) => {
                              const active = providedOperations.has(op);
                              const lastRemaining = active && entry.operations.length <= 1;
                              return (
                                <button
                                  key={op}
                                  type="button"
                                  data-bridge-op-toggle={`${entry.id}:${op}`}
                                  aria-pressed={active}
                                  disabled={isBusy || entry.expired || lastRemaining}
                                  onClick={() => { runToggleOperation(entry, op); }}
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                    active
                                      ? 'border-selected-ink/40 bg-selected font-medium text-selected-ink'
                                      : 'border-hairline bg-paper text-ink-faint hover:border-hairline-strong hover:text-ink-soft'
                                  }`}
                                >
                                  {active ? <Icon name="check" size={12} className="shrink-0" /> : null}
                                  <span>{t(OPERATION_KEYS[op])}</span>
                                </button>
                              );
                            })}
                          </dd>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                          <dt className="text-ink-faint">{t('st.remote.threadMessages.operationsLabel')}</dt>
                          <dd className="text-ink" data-thread-message-operations>
                            {orderedOps.map((op) => t(OPERATION_KEYS[op])).join(' · ')}
                          </dd>
                        </div>
                      )}
                    </dl>

                    {canBorrowTools ? (
                      <label
                        className={`flex items-center gap-2 pt-0.5 text-[12px] ${isBusy || entry.expired ? 'cursor-not-allowed text-ink-faint opacity-60' : 'cursor-pointer text-ink'}`}
                        htmlFor={`bridge-borrow-tools-${entry.id}`}
                      >
                        <input
                          id={`bridge-borrow-tools-${entry.id}`}
                          type="checkbox"
                          data-bridge-borrow-tools={entry.id}
                          checked={entry.borrowTools ?? true}
                          disabled={isBusy || entry.expired}
                          onChange={(event) => { runSetBorrowTools(entry, event.target.checked); }}
                          className="h-3.5 w-3.5 shrink-0 rounded border-hairline-strong accent-selected-ink"
                        />
                        <span>{t('st.remote.threadMessages.borrowToolsLabel')}</span>
                      </label>
                    ) : null}

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
