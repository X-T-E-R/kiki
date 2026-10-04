/**
 * Settings → Spaces: "Kikis allowed to connect to me" (inbound, §5.1/§5.2 of
 * the remote-space design).
 *
 * Two separate effects, deliberately not one switch: the gate says whether this
 * Kiki accepts peers at all, and the list says which Kikis it accepts. Opening
 * the gate allows nobody on its own. `enabled` is the state that is really in
 * effect; a saved-but-not-effective setting is said out loud rather than shown
 * as open.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { connectionsApi, fingerprint, remoteConnectionKeys, useInboundStatus } from '../../lib/remoteConnections';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { ListEmpty } from './list';
import { InviteSourceDialog } from './remote/InviteSourceDialog';
import { connectionFailureText } from './remote/parts';

export function InboundConnectionsSection() {
  const host = useHost();
  const { client, localClient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const control = host.kind === 'tauri' ? localClient : client;
  const status = useInboundStatus(control);
  const api = control === null ? null : connectionsApi(control);
  const [dialog, setDialog] = useState<{ kind: 'invite' } | { kind: 'revoke'; grantId: string; name: string } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all }); };
  const grants = status.data?.grants ?? [];
  const effective = status.data?.enabled ?? false;
  const configured = status.data?.configuredEnabled ?? false;

  const setEnabled = (enabled: boolean) => {
    if (api === null) return;
    setSaving(true);
    setFeedback(null);
    void api.setInbound(enabled)
      .then(() => { refresh(); })
      .catch((error: unknown) => {
        const reason = connectionFailureText(error instanceof Error ? error.message : '');
        setFeedback({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
      })
      .finally(() => { setSaving(false); });
  };

  return (
    <SectionCard id="st-card-inbound-connections" title={t('st.inbound.title')} scope="server">
      <div className="space-y-4" data-inbound-connections>
        {control === null ? <Hint>{t('st.remote.controlUnavailable')}</Hint> : null}
        {status.isError ? <InlineError error={status.error} /> : null}

        {status.data !== undefined ? (
          <>
            <div className="rounded-lg border border-hairline bg-paper px-3 py-2.5" data-inbound-gate>
              <Toggle id="inbound-connections-enabled" layout="row" label={t('st.inbound.gate')}
                checked={effective}
                disabled={saving || status.data.unavailableReason === 'dangerous_auth_bypass'}
                onChange={(next) => { setEnabled(next); }} />
              <p className="mt-1 max-w-[62ch] text-[12px] leading-snug text-ink-faint">{t('st.inbound.gateHint')}</p>
              {status.data.unavailableReason === 'dangerous_auth_bypass' ? (
                <p className="mt-1.5 text-[12px] leading-snug text-amber-ink" data-inbound-dev-runtime>{t('st.inbound.devRuntime')}</p>
              ) : configured !== effective ? (
                <p className="mt-1.5 text-[12px] leading-snug text-amber-ink" data-inbound-configured>{t('st.inbound.configuredOnly')}</p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12.5px] font-medium text-ink">{t('st.inbound.listTitle')}</p>
              <button type="button" data-inbound-invite className={`${PRIMARY_BUTTON} inline-flex items-center gap-1`}
                disabled={!effective || api === null}
                onClick={() => { setDialog({ kind: 'invite' }); }}>
                <Icon name="plus" size={12} />{t('st.inbound.invite')}
              </button>
            </div>
            {!effective ? (
              <Hint>{t(status.data.unavailableReason === 'dangerous_auth_bypass' ? 'st.inbound.inviteUnavailable' : 'st.inbound.inviteNeedsGate')}</Hint>
            ) : null}

            {grants.length === 0 ? (
              <div data-inbound-empty>
                <ListEmpty kind="none" title={t('st.inbound.emptyTitle')} body={t('st.inbound.emptyBody')} />
              </div>
            ) : (
              <div role="list" aria-label={t('st.inbound.listTitle')} className="space-y-1.5" data-inbound-list>
                {grants.map((grant) => (
                  <div key={grant.id} role="listitem" data-inbound-grant={grant.id} data-inbound-status={grant.status}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-ink/[0.03] px-3 py-2">
                    <Icon name="gate" size={14} className="shrink-0 text-ink-faint" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-ink" title={grant.label}>{grant.label}</span>
                        <span className={`shrink-0 rounded-full px-1.5 text-[11px] leading-[18px] ${grant.status === 'approved' ? 'bg-selected text-selected-ink' : grant.status === 'revoked' ? 'bg-ink/[0.06] text-ink-faint' : 'bg-attention-soft text-attention'}`}
                          data-inbound-status-chip={grant.status}>
                          {t(`st.inbound.status.${grant.status}` as I18nKey)}
                        </span>
                        <span className="shrink-0 text-[11.5px] text-ink-faint">{t('st.remote.purpose.gui')}</span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" data-inbound-source-detail title={grant.source.homeId}>
                        {t('st.inbound.sourceLine', { home: fingerprint(grant.source.homeId), host: fingerprint(grant.source.hostId) })}
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-ink-faint" data-inbound-activity>
                        {grant.lastConnectedAt === undefined
                          ? t('st.inbound.neverConnected')
                          : t('st.remote.lastConnected', { time: relativeTime(new Date(grant.lastConnectedAt).toISOString(), locale) })}
                        {grant.activeLeases > 0 ? ` · ${t('st.inbound.active', { count: grant.activeLeases })}` : ''}
                      </p>
                    </div>
                    {grant.status !== 'revoked' ? (
                      <button type="button" data-inbound-revoke={grant.id} className={SECONDARY_BUTTON}
                        onClick={() => { setDialog({ kind: 'revoke', grantId: grant.id, name: grant.label }); }}>
                        {t('st.inbound.revoke')}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <Hint>{t('st.inbound.bridgeNote')}</Hint>
          </>
        ) : null}

        <FeedbackLine feedback={feedback} />
      </div>

      {dialog?.kind === 'invite' && control !== null ? (
        <InviteSourceDialog client={control} onClose={() => { setDialog(null); }} onInvited={refresh} />
      ) : null}

      {dialog?.kind === 'revoke' && api !== null ? (
        <ConfirmDialog open overlayId="inbound-revoke-confirm" tone="danger"
          title={t('st.inbound.revokeTitle', { name: dialog.name })}
          body={t('st.inbound.revokeBody')}
          confirmLabel={t('st.inbound.revoke')}
          onCancel={() => { setDialog(null); }}
          onConfirm={() => {
            const grantId = dialog.grantId;
            const name = dialog.name;
            setDialog(null);
            setSaving(true);
            void api.revoke(grantId)
              .then(() => { setFeedback({ tone: 'success', text: t('st.inbound.revoked', { name }) }); refresh(); })
              .catch((error: unknown) => {
                const reason = connectionFailureText(error instanceof Error ? error.message : '');
                setFeedback({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
              })
              .finally(() => { setSaving(false); });
          }} />
      ) : null}
    </SectionCard>
  );
}
