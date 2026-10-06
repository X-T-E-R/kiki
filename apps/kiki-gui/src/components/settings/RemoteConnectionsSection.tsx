/**
 * Settings → Spaces: "Kikis I connect to" (outbound, §5.1 of the remote-space
 * design). A flat list in the accepted settings style: one row per registered
 * remote Kiki, the connection's own state, and the actions that affect only
 * this window's connection to it.
 *
 * The records belong to the local control home's server. While a remote space
 * is open this section still talks to that home, and says so in its source
 * line, so nobody configures B thinking they are configuring A.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { RemoteConnection } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  browsableRemote, connectionAddress, connectionsApi, hasGuiPurpose, identityBlock,
  remoteConnectionKeys, purposeKeys, remoteSummaryView, useRemoteConnections,
} from '../../lib/remoteConnections';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { useSpaceSettingsTarget } from '../../lib/spaceSettings';
import { SectionCard } from './SectionCard';
import { ListEmpty } from './list';
import { MAIN_SPACE_ID } from '../../lib/spaces';
import { SpaceRowMenu } from './spaces/SpaceRowMenu';
import { AddConnectionDialog } from './remote/AddConnectionDialog';
import { CopyField, RemoteStateChip, connectionFailureText } from './remote/parts';
import { useRemoteSpaceEntry } from './remote/useRemoteSpaceEntry';
import { CloudflareEntry } from './remote/CloudflareEntry';

export function RemoteConnectionsSection() {
  const host = useHost();
  const { client, localClient } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Management is always the control home's; a remote space's own client may
  // not reach `/api/remote-connections` at all.
  const control = host.kind === 'tauri' ? localClient : client;
  const connections = useRemoteConnections(control);
  // The same target read the local space list uses, so the two never disagree
  // about which home is being configured (and the read is shared, not repeated).
  const controlTarget = useSpaceSettingsTarget(control);
  const identity = useQuery({
    queryKey: ['remote-connections', 'identity', control?.baseUrl ?? null],
    queryFn: async () => (control === null ? null : connectionsApi(control).handshake()),
    enabled: control !== null,
    staleTime: 60_000,
  });
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'remove'; record: RemoteConnection } | null>(null);
  const [menu, setMenu] = useState<{ record: RemoteConnection; anchor: DOMRect; anchorElement: HTMLElement } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const records = connections.data ?? [];
  const api = control === null ? null : connectionsApi(control);
  const enterRemoteSpace = useRemoteSpaceEntry();
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all }); };

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
  const controlHomeLabel = controlHome === undefined ? undefined : controlHome === MAIN_SPACE_ID ? t('st.spaces.main') : controlHome;
  const sourceLine = control === null
    ? t('st.remote.controlUnavailable')
    : controlHomeLabel === undefined
      ? t('st.remote.configuresNoHome', { origin: connectionAddress(control.baseUrl) })
      : t('st.remote.configures', { origin: connectionAddress(control.baseUrl), home: controlHomeLabel });

  return (
    <SectionCard id="st-card-remote-connections" title={t('st.remote.outboundTitle')} scope="server">
      <div className="space-y-4" data-remote-connections>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 text-[12.5px] text-ink-soft" data-remote-source>{sourceLine}</p>
          <button type="button" data-remote-diagnostics className="shrink-0 text-[12.5px] text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink"
            onClick={() => { void navigate('/settings/connection'); }}>
            {t('st.remote.diagnostics')}
          </button>
        </div>

        {control !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-remote-add className={`${PRIMARY_BUTTON} inline-flex items-center gap-1`}
              onClick={() => { setDialog({ kind: 'add' }); }}>
              <Icon name="plus" size={12} />{t('st.remote.add')}
            </button>
          </div>
        ) : null}

        {connections.isLoading ? <Hint>{t('st.remote.loading')}</Hint> : null}
        {connections.isError ? <InlineError error={connections.error} /> : null}

        {connections.isSuccess && records.length === 0 ? (
          <div data-remote-empty>
            <ListEmpty kind="none" title={t('st.remote.emptyTitle')} body={t('st.remote.emptyBody')} />
          </div>
        ) : null}

        {records.length > 0 ? (
          <div role="list" aria-label={t('st.remote.outboundTitle')} className="space-y-1.5" data-remote-list>
            {records.map((record) => (
              <RemoteConnectionRow key={record.id} record={record} busy={busyId === record.id}
                onEnter={() => { enterRemoteSpace(record.id, record.label); }}
                onMenu={(anchor, element) => { setMenu({ record, anchor, anchorElement: element }); }} />
            ))}
          </div>
        ) : null}

        <FeedbackLine feedback={feedback} />
        <CloudflareEntry />

        {identity.data !== undefined && identity.data !== null ? (
          <div className="border-t border-hairline pt-4" data-remote-self-identity>
            <CopyField id="remote-self-identity" dataAttr="self"
              label={t('st.remote.identityTitle')}
              value={identityBlock(identity.data.identity)}
              copyLabel={t('st.remote.identityCopy')} copiedLabel={t('st.remote.identityCopied')}
              hint={t('st.remote.identityBody')} />
          </div>
        ) : null}
      </div>

      {menu !== null ? (
        <SpaceRowMenu anchor={menu.anchor} anchorElement={menu.anchorElement} ariaLabel={t('st.remote.menuAria', { name: menu.record.label })}
          onClose={() => { setMenu(null); }}
          items={[
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
              label: t('common.remove'),
              danger: true,
              separatorBefore: true,
              run: () => { setDialog({ kind: 'remove', record: menu.record }); },
            },
          ]} />
      ) : null}

      {dialog?.kind === 'add' && control !== null ? (
        <AddConnectionDialog client={control} onClose={() => { setDialog(null); }}
          onAdded={(record) => {
            setDialog(null);
            refresh();
            setFeedback({ tone: 'success', text: t('st.remote.added', { name: record.label }) });
          }} />
      ) : null}

      {dialog?.kind === 'remove' && control !== null ? (
        <ConfirmDialog open overlayId="remote-connection-remove" tone="danger"
          title={t('st.remote.removeTitle', { name: dialog.record.label })}
          body={t('st.remote.removeBody')}
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

/**
 * OneKiki: the name leads, the address and the last contact follow, and a Kiki
 * that only carries thread messages says so instead of offering a way in.
 */
function RemoteConnectionRow({ record, busy, onEnter, onMenu }: {
  record: RemoteConnection;
  busy: boolean;
  onEnter: () => void;
  onMenu: (anchor: DOMRect, element: HTMLElement) => void;
}) {
  const { t, locale } = useI18n();
  const summary = remoteSummaryView(record);
  const enterable = browsableRemote(record);
  const bridgeOnly = !hasGuiPurpose(record) && record.purposes.includes('bridge');
  const staleLabel = summary !== null && summary.stale && summary.asOf !== undefined
    ? t('st.remote.asOf', { time: relativeTime(new Date(summary.asOf).toISOString(), locale) })
    : undefined;
  const failure = record.lastError === undefined ? null : connectionFailureText(record.lastError);
  return (
    <div role="listitem" data-remote-connection={record.id} data-remote-purpose={record.purposes.join('+')}
      data-remote-stale={summary !== null && summary.stale ? '' : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-ink/[0.03] px-3 py-2">
      <Icon name="web" size={14} className="shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-ink" title={record.label}>{record.label}</span>
          <RemoteStateChip state={record.state} staleLabel={staleLabel} />
          {purposeKeys(record).map((key) => (
            <span key={key} className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] leading-[18px] text-ink-soft">{t(key)}</span>
          ))}
        </div>
        {/* Address and time only: this line is the secondary position, and the
            row keeps its width for the state and the counts. */}
        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" data-remote-address title={record.endpoint}>
          {connectionAddress(record.endpoint)}
          {record.lastConnectedAt !== undefined ? ` · ${relativeTime(new Date(record.lastConnectedAt).toISOString(), locale)}` : ''}
        </p>
        {summary !== null && (summary.busy > 0 || summary.needsYou > 0) ? (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink-faint" data-remote-summary>
            {summary.busy > 0 ? <span className="tabular-nums">{t('st.remote.busy', { count: summary.busy })}</span> : null}
            {summary.busy > 0 && summary.needsYou > 0 ? <span aria-hidden>·</span> : null}
            {summary.needsYou > 0 ? <span className="tabular-nums text-attention">{t('st.remote.needsYou', { count: summary.needsYou })}</span> : null}
          </p>
        ) : null}
        {bridgeOnly ? <p className="mt-0.5 text-[11.5px] text-ink-faint" data-remote-bridge-only>{t('st.remote.bridgeOnly')}</p> : null}
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
