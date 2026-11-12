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
import { useNavigate } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { ConnectionGrant, ConnectionIdentity } from '@kiki/protocol';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { connectionsApi, identityBlock, remoteConnectionKeys, useInboundStatus } from '../../lib/remoteConnections';
import {
  hasThreadBridgesApi,
  inboundGrantThreadMessageDirection,
  threadBridgeKeys,
  threadMessageFactKey,
  useThreadBridges,
  type ThreadMessageFact,
} from '../../lib/threadBridges';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { AdvancedDetails } from './fields';
import { RowFrame } from './RowFrame';
import { SectionCard } from './SectionCard';
import { SpaceRowMenu, type SpaceMenuItem } from './spaces/SpaceRowMenu';
import { PairSheet } from './remote/PairSheet';
import { ThreadMessagesPanel } from './remote/ThreadMessagesPanel';
import { connectionFailureText } from './remote/parts';

const GRANT_STATUS_TONE: Readonly<Record<ConnectionGrant['status'], { dot: string; text: string }>> = {
  approved: { dot: 'bg-success', text: 'text-ink-soft' },
  invited: { dot: 'bg-attention', text: 'text-attention' },
  revoked: { dot: 'bg-hairline-strong', text: 'text-ink-faint' },
};

/** One peer space: a row whose ⋯ holds Thread messages… and Revoke…. */
function InboundGrantRow({ grant, gateEnabled, threadFact, bridgesAvailable, onOpenThreadMessages, onRevoke }: {
  readonly grant: ConnectionGrant;
  readonly gateEnabled: boolean;
  readonly threadFact: ThreadMessageFact | null;
  readonly bridgesAvailable: boolean;
  readonly onOpenThreadMessages: () => void;
  readonly onRevoke: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const tone = GRANT_STATUS_TONE[grant.status];
  const canOpenHere = gateEnabled && grant.status === 'approved' && grant.purpose === 'gui';
  const items: SpaceMenuItem[] = [
    {
      key: 'thread-messages',
      label: t('st.remote.threadMessages.menu'),
      blockedReason: bridgesAvailable ? undefined : t('st.remote.controlUnavailable'),
      run: onOpenThreadMessages,
    },
    {
      key: 'revoke',
      label: t('st.inbound.revoke'),
      danger: true,
      separatorBefore: true,
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
          <span data-inbound-openable={canOpenHere ? 'yes' : 'no'}>
            {t(canOpenHere ? 'st.inbound.canOpen' : 'st.inbound.cantOpen')}
          </span>
          {threadFact !== null ? (
            <>
              <span aria-hidden>·</span>
              <span
                className={threadFact === 'unreadable' ? 'text-amber-ink' : undefined}
                data-inbound-thread-messages={threadFact}
              >
                {t(threadMessageFactKey(threadFact))}
              </span>
            </>
          ) : null}
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
      {/* No home or host id here: an internal identifier is not something a
          person can check a peer by, and the name above is what they gave it. */}
      <p className="text-[12px] text-ink-faint" data-inbound-grant-details>
        {t('st.inbound.addedAt', { time: relativeTime(new Date(grant.createdAt).toISOString(), locale) })}
      </p>
    </RowFrame>
  );
}

function ManualIdentityExchangeRow({ identity }: { readonly identity: ConnectionIdentity }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const copy = async () => {
    setFailed(null);
    try {
      await copyTextToClipboard(identityBlock(identity));
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 1_600);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="pt-1" data-remote-self-identity>
      <div className="flex flex-wrap items-center justify-between gap-3" data-copy-field="self">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink" id="remote-self-identity-label">{t('st.remote.identityTitle')}</p>
          <p className="mt-0.5 text-[12px] text-ink-faint">{t('st.remote.identityBody')}</p>
        </div>
        <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} data-copy-action
          aria-describedby="remote-self-identity-label"
          onClick={() => { void copy(); }}>
          <Icon name="copy" size={12} className="mr-1 inline-block align-[-1px]" />
          {copied ? t('st.remote.identityCopied') : t('st.remote.identityCopy')}
        </button>
      </div>
      {failed !== null ? <p className="mt-1.5 text-[12px] text-danger" role="alert">{t('st.remote.copyFailed', { reason: failed })}</p> : null}
    </div>
  );
}

export function InboundConnectionsSection() {
  const host = useHost();
  const { client, localClient, connectionId, sshLabel } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inRemoteScope = Boolean(connectionId) || Boolean(sshLabel);
  const control = host.kind === 'tauri' ? localClient : (localClient ?? (inRemoteScope ? null : client));
  const status = useInboundStatus(control);
  const threadBridges = useThreadBridges(control);
  const bridgesAvailable = hasThreadBridgesApi(control);
  const api = control === null ? null : connectionsApi(control);
  const [dialog, setDialog] = useState<
    | { kind: 'invite' }
    | { kind: 'thread-messages'; grant: ConnectionGrant }
    | { kind: 'revoke'; grantId: string; name: string }
    | null
  >(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
    void queryClient.invalidateQueries({ queryKey: threadBridgeKeys.all });
  };
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
        disabled={api === null || status.data?.unavailableReason === 'dangerous_auth_bypass'}
        title={status.data?.unavailableReason === 'dangerous_auth_bypass' ? t('st.inbound.devRuntime') : undefined}
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
                <Toggle id="inbound-connections-enabled" layout="bare" label={t('st.inbound.gate')}
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
                {grants.map((grant) => {
                  const threadFact: ThreadMessageFact | null = !bridgesAvailable || threadBridges.isLoading
                    ? (!bridgesAvailable ? 'unreadable' : null)
                    : threadBridges.isError || threadBridges.data === undefined
                      ? 'unreadable'
                      : inboundGrantThreadMessageDirection(grant, threadBridges.data);
                  return (
                    <InboundGrantRow
                      key={grant.id}
                      grant={grant}
                      gateEnabled={effective}
                      threadFact={threadFact}
                      bridgesAvailable={bridgesAvailable}
                      onOpenThreadMessages={() => { setDialog({ kind: 'thread-messages', grant }); }}
                      onRevoke={() => { setDialog({ kind: 'revoke', grantId: grant.id, name: grant.label }); }}
                    />
                  );
                })}
              </div>
            ) : null}

            <p className="text-[12.5px] text-ink-faint" data-inbound-outbound-note>
              {t('st.inbound.outboundNotePrefix')}
              <button type="button" data-inbound-open-spaces
                className="text-ink-soft underline decoration-hairline-strong underline-offset-2 hover:text-ink"
                onClick={() => { void navigate('/settings/spaces'); }}>
                {t('st.inbound.outboundNoteLink')}
              </button>
              {t('st.inbound.outboundNoteSuffix')}
            </p>

            <AdvancedDetails summary={t('st.computer.advanced')} data-inbound-advanced-fold>
              <ManualIdentityExchangeRow identity={status.data.identity} />
            </AdvancedDetails>
          </>
        ) : null}

        <FeedbackLine feedback={feedback} />
      </div>

      {dialog?.kind === 'invite' && control !== null ? (
        <PairSheet client={control} direction="inbound" onClose={() => { setDialog(null); }} onInvited={refresh} />
      ) : null}

      {dialog?.kind === 'thread-messages' && control !== null ? (
        <ThreadMessagesPanel
          client={control}
          subject={{ kind: 'inbound', grant: dialog.grant }}
          onClose={() => { setDialog(null); }}
        />
      ) : null}

      {dialog?.kind === 'revoke' && api !== null ? (
        <ConfirmDialog open overlayId="inbound-revoke-confirm" tone="danger"
          title={t('st.inbound.revokeTitle', { name: dialog.name })}
          body={t('st.inbound.revokeBody', { name: dialog.name })}
          confirmLabel={t('st.inbound.revokeConfirm')}
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
