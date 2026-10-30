/**
 * Settings → Access from elsewhere → Other Kiki: "Kikis allowed to connect to me" (inbound, §5.1/§5.2 of
 * the remote-space design).
 *
 * Two separate effects, deliberately not one switch: the gate says whether this
 * Kiki accepts peers at all, and the list says which Kikis it accepts. Opening
 * the gate allows nobody on its own. `enabled` is the state that is really in
 * effect; a saved-but-not-effective setting is said out loud rather than shown
 * as open.
 */

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { ConnectionGrant } from '@kiki/protocol';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { connectionsApi, fingerprint, remoteConnectionKeys, useInboundStatus } from '../../lib/remoteConnections';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { PRIMARY_BUTTON } from '../ui';
import { RowFrame } from './RowFrame';
import { SectionCard } from './SectionCard';
import { AdvancedDetails } from './fields';
import { CopyField } from './remote/parts';
import { SpaceRowMenu, type SpaceMenuItem } from './spaces/SpaceRowMenu';
import { InviteSourceDialog } from './remote/InviteSourceDialog';
import { connectionFailureText } from './remote/parts';

const GRANT_STATUS_TONE: Readonly<Record<ConnectionGrant['status'], { dot: string; text: string }>> = {
  approved: { dot: 'bg-success', text: 'text-ink-soft' },
  invited: { dot: 'bg-attention', text: 'text-attention' },
  revoked: { dot: 'bg-hairline-strong', text: 'text-ink-faint' },
};

/** One peer Kiki: a row whose ⋯ holds its revoke, and whose raw ids fold away. */
function InboundGrantRow({ grant, onRevoke }: {
  readonly grant: ConnectionGrant;
  readonly onRevoke: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const tone = GRANT_STATUS_TONE[grant.status];
  const items: SpaceMenuItem[] = [
    {
      key: 'revoke',
      label: t('st.inbound.revoke'),
      danger: true,
      blockedReason: grant.status === 'revoked' ? t('st.inbound.status.revoked') : undefined,
      run: onRevoke,
    },
  ];
  return (
    <RowFrame
      data={{
        'data-inbound-grant': grant.id,
        'data-inbound-status': grant.status,
      }}
      open={open}
      onToggle={() => { setOpen((current) => !current); }}
      bodyId={`inbound-grant-body-${grant.id}`}
      expandLabel={t('st.browser.menu.openRow', { name: grant.label })}
      name={grant.label}
      marks={(
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${tone.text}`} data-inbound-status-chip={grant.status}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {t(`st.inbound.status.${grant.status}` as I18nKey)}
        </span>
      )}
      subtitle={(
        <>
          <span>{t('st.remote.purpose.gui')}</span>
          <span aria-hidden>·</span>
          <span data-inbound-activity>
            {grant.lastConnectedAt === undefined
              ? t('st.inbound.neverConnected')
              : t('st.remote.lastConnected', { time: relativeTime(new Date(grant.lastConnectedAt).toISOString(), locale) })}
            {grant.activeLeases > 0 ? ` · ${t('st.inbound.active', { count: grant.activeLeases })}` : ''}
          </span>
        </>
      )}
      control={(
        <>
          <button
            ref={anchorRef}
            type="button"
            data-inbound-grant-menu={grant.id}
            aria-label={t('st.browser.menu.open', { name: grant.label })}
            aria-haspopup="menu"
            aria-expanded={menuRect !== null}
            onClick={() => { setMenuRect(anchorRef.current?.getBoundingClientRect() ?? null); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <Icon name="more" size={14} />
          </button>
          {menuRect !== null ? (
            <SpaceRowMenu
              anchor={menuRect}
              anchorElement={anchorRef.current}
              items={items}
              ariaLabel={t('st.browser.menu.open', { name: grant.label })}
              onClose={() => { setMenuRect(null); }}
            />
          ) : null}
        </>
      )}
    >
      {/* The raw home/host ids are reference, not identity: folded, sans, copyable. */}
      <AdvancedDetails summary={t('st.inbound.details')} data-inbound-grant-details>
        <div className="grid gap-x-4 gap-y-2 pt-1 sm:grid-cols-2">
          <CopyField id={`inbound-home-${grant.id}`} dataAttr={`inbound-home-${grant.id}`}
            label={t('st.inbound.homeId')}
            value={fingerprint(grant.source.homeId, 12, 8)}
            copyLabel={t('st.inbound.copyId')} copiedLabel={t('st.inbound.copiedId')} />
          <CopyField id={`inbound-host-${grant.id}`} dataAttr={`inbound-host-${grant.id}`}
            label={t('st.inbound.hostId')}
            value={fingerprint(grant.source.hostId, 12, 8)}
            copyLabel={t('st.inbound.copyId')} copiedLabel={t('st.inbound.copiedId')} />
        </div>
      </AdvancedDetails>
    </RowFrame>
  );
}

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
    <SectionCard id="st-card-inbound-connections" title={t('st.inbound.title')} scope="server" actions={(
      <button type="button" data-inbound-invite className={`${PRIMARY_BUTTON} inline-flex items-center gap-1`}
        disabled={!effective || api === null}
        title={!effective ? t('st.inbound.inviteNeedsGate') : undefined}
        onClick={() => { setDialog({ kind: 'invite' }); }}>
        <Icon name="plus" size={12} />{t('st.inbound.invite')}
      </button>
    )}>
      <div className="space-y-4" data-inbound-connections>
        {control === null ? <Hint>{t('st.remote.controlUnavailable')}</Hint> : null}
        {status.isError ? <InlineError error={status.error} /> : null}

        {status.data !== undefined ? (
          <>
            {/* The gate, the header way: one sentence, the switch on the right.
                No card, no rule — the heading above already names the section. */}
            <div className="space-y-1.5" data-inbound-gate>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="mr-auto text-[13px] text-ink">{t('st.inbound.gate')}</p>
                <Toggle layout="bare" label={t('st.inbound.gate')}
                  checked={effective}
                  disabled={saving || status.data.unavailableReason === 'dangerous_auth_bypass'}
                  dataAttr="data-inbound-gate-switch"
                  onChange={(next) => { setEnabled(next); }} />
              </div>
              <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint">{t('st.inbound.gateHint')}</p>
              {status.data.unavailableReason === 'dangerous_auth_bypass' ? (
                <p className="text-[12px] leading-snug text-amber-ink" data-inbound-dev-runtime>{t('st.inbound.devRuntime')}</p>
              ) : configured !== effective ? (
                <p className="text-[12px] leading-snug text-amber-ink" data-inbound-configured>{t('st.inbound.configuredOnly')}</p>
              ) : null}
            </div>

            {/* While the gate is shut the empty line has nothing to add: the
                gate hint above and the disabled invite's title already say the
                one next step. */}
            {effective && grants.length === 0 ? (
              <p className="text-[13px] text-ink-soft" data-inbound-empty>{t('st.inbound.emptyLine')}</p>
            ) : grants.length > 0 ? (
              <div aria-label={t('st.inbound.listTitle')} data-inbound-list>
                {grants.map((grant) => (
                  <InboundGrantRow key={grant.id} grant={grant}
                    onRevoke={() => { setDialog({ kind: 'revoke', grantId: grant.id, name: grant.label }); }} />
                ))}
              </div>
            ) : null}
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
