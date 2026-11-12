/**
 * Settings → Spaces: "Spaces on other computers" (outbound paired spaces plus
 * saved Owner (SSH) profiles).
 *
 * The records belong to the local control home's server. While a space on
 * another computer is open this section still reads that home, and names it in
 * the section title so nobody configures B thinking they are configuring A.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { RemoteConnection } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  browsableRemote, connectionAddress, connectionsApi, hasGuiPurpose,
  remoteConnectionKeys, remoteSummaryView, useRemoteConnections,
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
import type { SshProfile } from '../../state/connectionConfig';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { SshProfilesPanel } from '../SshProfilesPanel';
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
  const { client, localClient, connectionId, sshLabel, activateSshProfile } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const inRemoteScope = Boolean(connectionId) || Boolean(sshLabel);
  const control = host.kind === 'tauri' ? localClient : (localClient ?? (inRemoteScope ? null : client));
  const connections = useRemoteConnections(control);
  const threadBridges = useThreadBridges(control);
  const bridgesAvailable = hasThreadBridgesApi(control);
  const controlTarget = useSpaceSettingsTarget(control);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [dialog, setDialog] = useState<
    | { kind: 'add' }
    | { kind: 'remove'; record: RemoteConnection }
    | { kind: 'thread-messages'; record: RemoteConnection }
    | { kind: 'ssh'; profile?: SshProfile }
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

  const listSshProfiles = host.connection?.listSshProfiles;

  const reloadSshProfiles = () => {
    if (!listSshProfiles) return;
    void listSshProfiles().then(
      (items) => { setSshProfiles(items); },
      () => { setSshProfiles([]); },
    );
  };

  useEffect(() => {
    if (!listSshProfiles) {
      setSshProfiles((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let active = true;
    void listSshProfiles().then(
      (items) => { if (active) setSshProfiles(items); },
      () => { if (active) setSshProfiles([]); },
    );
    return () => { active = false; };
  }, [listSshProfiles]);

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

  const canManageSsh = Boolean(
    host.connection?.listSshProfiles &&
    host.connection?.saveSshProfile &&
    host.connection?.removeSshProfile &&
    activateSshProfile,
  );

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
        {connections.isError ? <InlineError error={connections.error} /> : null}

        {connections.isSuccess && records.length === 0 && sshProfiles.length === 0 ? (
          <p className="text-[13px] text-ink-soft" data-remote-empty>{t('st.remote.emptyLine')}</p>
        ) : null}

        {records.length > 0 || sshProfiles.length > 0 ? (
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
                  onEnter={() => { enterRemoteSpace(record.id, record.label); }}
                  onMenu={(anchor, element) => { setMenu({ record, anchor, anchorElement: element }); }}
                />
              );
            })}
            {sshProfiles.map((profile) => (
              <OwnerSshProfileRow key={profile.id} profile={profile}
                onConnect={() => { setDialog({ kind: 'ssh', profile }); }} />
            ))}
          </div>
        ) : null}

        {canManageSsh && sshProfiles.length === 0 ? (
          <div>
            <button type="button" data-owner-ssh-manage
              className="text-[12.5px] text-ink-faint underline decoration-hairline-strong underline-offset-2 hover:text-ink"
              onClick={() => { setDialog({ kind: 'ssh' }); }}>
              {t('st.remote.ownerSshManage')}
            </button>
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
              text: t('st.remote.added', { name: record.label }),
              durationMs: UNDO_TOAST_MS,
              action: browsableRemote(record)
                ? { label: t('st.remote.enter'), run: () => { void enterRemoteSpace(record.id, record.label); } }
                : undefined,
            });
          }}
        />
      ) : null}

      {dialog?.kind === 'ssh' && activateSshProfile !== undefined ? (
        <Dialog onClose={() => { setDialog(null); reloadSshProfiles(); }} overlayId="owner-ssh-profiles"
          ariaLabel={t('connect.sshTitle')}
          panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
          <div className="space-y-3" data-owner-ssh-dialog>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[14px] font-medium text-ink">{t('st.remote.ownerSshTag')}</h2>
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDialog(null); reloadSshProfiles(); }}>
                {t('common.close')}
              </button>
            </div>
            <SshProfilesPanel
              selectedProfile={dialog.profile}
              onConnect={async (id, token) => {
                await activateSshProfile(id, token);
                setDialog(null);
                reloadSshProfiles();
              }}
            />
          </div>
        </Dialog>
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

function OwnerSshProfileRow({ profile, onConnect }: {
  readonly profile: SshProfile;
  readonly onConnect: () => void;
}) {
  const { t } = useI18n();
  const target = profile.target.kind === 'alias' ? profile.target.alias : profile.target.hostname;
  return (
    <div role="listitem" data-ssh-profile-row={profile.id}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-ink/[0.03] px-3 py-2">
      <Icon name="terminal" size={14} className="shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-ink" title={profile.label}>
            {profile.label}
          </span>
          <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] leading-[18px] text-ink-soft" data-owner-ssh-tag>
            {t('st.remote.ownerSshTag')}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" title={target}>
          {target}{profile.remotePort !== undefined ? ` · 127.0.0.1:${profile.remotePort}` : ''}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" data-ssh-profile-connect={profile.id} className={SECONDARY_BUTTON} onClick={onConnect}>
          {t('st.remote.ownerSshConnect')}
        </button>
      </div>
    </div>
  );
}

function RemoteConnectionRow({ record, busy, threadFact, onEnter, onMenu }: {
  record: RemoteConnection;
  busy: boolean;
  threadFact: ThreadMessageFact | null;
  onEnter: () => void;
  onMenu: (anchor: DOMRect, element: HTMLElement) => void;
}) {
  const { t, locale } = useI18n();
  const summary = remoteSummaryView(record);
  const canOpen = hasGuiPurpose(record) && record.enabled;
  const enterable = browsableRemote(record);
  const staleLabel = summary !== null && summary.stale && summary.asOf !== undefined
    ? t('st.remote.asOf', { time: relativeTime(new Date(summary.asOf).toISOString(), locale) })
    : undefined;
  const failure = record.lastError === undefined ? null : connectionFailureText(record.lastError);
  const hasCounts = summary !== null && (summary.busy > 0 || summary.needsYou > 0);
  return (
    <div role="listitem" data-remote-connection={record.id} data-remote-purpose={record.purposes.join('+')}
      data-remote-stale={summary !== null && summary.stale ? '' : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-ink/[0.03] px-3 py-2">
      <Icon name="web" size={14} className="shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-ink" title={record.label}>{record.label}</span>
          <RemoteStateChip state={record.state} staleLabel={staleLabel} />
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" data-remote-address title={record.endpoint}>
          {connectionAddress(record.endpoint)}
          {record.lastConnectedAt !== undefined ? ` · ${relativeTime(new Date(record.lastConnectedAt).toISOString(), locale)}` : ''}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-faint" data-remote-facts>
          <span data-remote-openable={canOpen ? 'yes' : 'no'}>
            {t(canOpen ? 'st.remote.canOpen' : 'st.remote.cantOpen')}
          </span>
          {threadFact !== null ? (
            <>
              <span aria-hidden>·</span>
              <span
                className={threadFact === 'unreadable' ? 'text-amber-ink' : undefined}
                data-remote-thread-messages={threadFact}
              >
                {t(threadMessageFactKey(threadFact))}
              </span>
            </>
          ) : null}
          {hasCounts ? (
            <span className="inline-flex flex-wrap items-center gap-x-2" data-remote-summary>
              <span aria-hidden>·</span>
              {summary.busy > 0 ? <span className="tabular-nums">{t('st.remote.busy', { count: summary.busy })}</span> : null}
              {summary.busy > 0 && summary.needsYou > 0 ? <span aria-hidden>·</span> : null}
              {summary.needsYou > 0 ? <span className="tabular-nums text-attention">{t('st.remote.needsYou', { count: summary.needsYou })}</span> : null}
            </span>
          ) : null}
        </p>
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
