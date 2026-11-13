/**
 * PairSheet — unified pairing sheet with two explicit directions (#21):
 * - `'outbound'`: "Pair a space on another computer" (address + pairing code,
 *   or SSH when available in the desktop app; opt-in `requestBridge` unchecked
 *   by default).
 * - `'inbound'`: "Pairing code" (pre-consent screen naming what the peer can do
 *   and what generating a code switches on before any request is sent; opt-in
 *   thread messages unchecked by default).
 *
 * Renders as a `SidePanel` (right sheet on desktop, full-height sheet on
 * phones).
 */

import { useEffect, useRef, useState } from 'react';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { formatPairingUri, type PairCodeCreateOutput, type RemoteConnection, type SshHost } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  completeConnectionEndpoint,
  connectionsApi,
  endpointIssue,
  fingerprint,
  formatPairingCode,
  labelIssue,
  pairingCodeIssue,
  parsePairingUri,
  useInboundStatus,
} from '../../../lib/remoteConnections';
import { useNativeSshEnabled, useSshHosts } from '../../../lib/ssh';
import { MAIN_SPACE_ID, useSpaces } from '../../../lib/spaces';
import { SidePanel } from '../../SidePanel';
import { FeedbackLine, type Feedback } from '../../controls';
import { useGuardedNavigate } from '../../dirtyGuard';
import { Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { wechatQrImage } from '../notifications/wechatQr';
import { AddConnectionBySshDialog } from './AddConnectionBySshDialog';
import { CopyField, connectionFailureText } from './parts';

export type PairSheetDirection = 'outbound' | 'inbound';
export type AddConnectionStart = { readonly kind: 'url' } | { readonly kind: 'ssh'; readonly profileId: string };

export function classifyOutboundPairFailure(error: unknown): I18nKey | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('pairing_rate_limited')) return 'st.remote.fail.pairingRate';
  if (message.includes('invalid_pairing_code') || message.includes('invalid_invitation') || message.includes('connection_claim_failed')) {
    return 'st.remote.pairFail.code';
  }
  if (message.includes('inbound_disabled')) return 'st.remote.pairFail.inboundDisabled';
  if (message.includes('identity_changed')) return 'st.remote.pairFail.selfSpace';
  if (message.includes('connection_requires_tls')) return 'st.remote.endpoint.tls';
  if (message.includes('invalid_connection_endpoint')) return 'st.remote.endpoint.invalid';
  if (message.includes('dangerous_auth_bypass')) return 'st.remote.fail.devRuntime';
  if (
    error instanceof TypeError ||
    /fetch failed|econnrefused|enotfound|etimedout|ehostunreach|enetunreach|network|timed? ?out|socket|502|503|504/i.test(message)
  ) {
    return 'st.remote.pairFail.unreachable';
  }
  return connectionFailureText(message);
}

function remainingLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function PairSheet({
  client,
  direction,
  sshProfiles,
  defaultHome,
  initial,
  onClose,
  onPaired,
  onInvited,
}: {
  readonly client: KikiClient;
  readonly direction: PairSheetDirection;
  readonly sshProfiles?: readonly SshHost[];
  readonly defaultHome?: string;
  readonly initial?: AddConnectionStart;
  readonly onClose: () => void;
  readonly onPaired?: (record: RemoteConnection) => void;
  readonly onInvited?: () => void;
}) {
  if (direction === 'inbound') {
    return <InboundPairSheet client={client} onClose={onClose} onInvited={onInvited} />;
  }
  return (
    <OutboundPairSheet
      client={client}
      sshProfiles={sshProfiles}
      defaultHome={defaultHome}
      initial={initial}
      onClose={onClose}
      onPaired={onPaired}
    />
  );
}

function OutboundPairSheet({
  client,
  sshProfiles,
  defaultHome,
  initial,
  onClose,
  onPaired,
}: {
  readonly client: KikiClient;
  readonly sshProfiles?: readonly SshHost[];
  readonly defaultHome?: string;
  readonly initial?: AddConnectionStart;
  readonly onClose: () => void;
  readonly onPaired?: (record: RemoteConnection) => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const sshFlag = useNativeSshEnabled(client);
  const hostsQuery = useSshHosts(client, sshFlag.enabled === true);
  const savedHosts = sshProfiles ?? hostsQuery.data ?? [];
  const spaces = useSpaces(client);
  const home = defaultHome ?? spaces.data?.find((space) => space.id === MAIN_SPACE_ID)?.path ?? '';

  const [way, setWay] = useState<'url' | 'ssh'>(initial?.kind ?? 'url');
  const onUrlWay = way === 'url';
  const [profileId] = useState(initial?.kind === 'ssh' ? initial.profileId : '');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [pairingFingerprint, setPairingFingerprint] = useState('');
  const [requestBridge, setRequestBridge] = useState(false);
  const [background, setBackground] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [touched, setTouched] = useState<{ label: boolean; endpoint: boolean; code: boolean }>({
    label: false,
    endpoint: false,
    code: false,
  });

  const completedEndpoint = completeConnectionEndpoint(endpoint);
  const labelProblem = labelIssue(label);
  const endpointProblem = endpointIssue(completedEndpoint);
  const codeProblem = pairingCodeIssue(code);
  const blocked = codeProblem !== null || labelProblem !== null || endpointProblem !== null || saving;

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setTouched({ label: true, endpoint: true, code: true });
    if (blocked) return;
    setSaving(true);
    setFailure(null);
    try {
      const record = await connectionsApi(client).pair({
        endpoint: completedEndpoint,
        code: code.trim(),
        ...(label.trim() === '' ? {} : { label: label.trim() }),
        backgroundSummary: background,
        requestBridge,
        fingerprint: pairingFingerprint || undefined,
      });
      onPaired?.(record);
    } catch (error) {
      const reason = classifyOutboundPairFailure(error);
      setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
    } finally {
      setSaving(false);
    }
  };

  if (way === 'ssh') {
    return (
      <AddConnectionBySshDialog
        client={client}
        profiles={savedHosts}
        defaultHome={home}
        initialProfileId={profileId === '' ? undefined : profileId}
        onClose={onClose}
        onAdded={(record) => { onPaired?.(record); }}
      />
    );
  }

  const formId = 'remote-connection-add-form';
  return (
    <SidePanel
      onClose={onClose}
      overlayId="pair-sheet-outbound"
      title={t('st.remote.addTitle')}
      description={t('st.remote.addBody')}
      width="lg"
      data={{ 'data-pair-sheet': 'outbound' }}
      footer={(
        <>
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            data-remote-add-submit
            className={PRIMARY_BUTTON}
            disabled={blocked}
            onClick={(event) => { event.preventDefault(); void submit(); }}
          >
            {saving ? t('st.remote.adding') : t('st.remote.pairSubmit')}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className="space-y-5"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        data-remote-add-form
      >
        {sshFlag.enabled === true ? (
          <div className="space-y-1.5">
            <span className="block text-[12px] font-medium text-ink-soft">{t('st.remote.way.label')}</span>
            <div role="tablist" aria-label={t('st.remote.way.label')} data-remote-add-ways className="flex gap-1.5">
              <button
                type="button"
                role="tab"
                data-remote-add-way="url"
                aria-selected={onUrlWay}
                onClick={() => { setWay('url'); }}
                className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${onUrlWay ? 'bg-selected text-selected-ink' : ''}`}
              >
                <Icon name="web" size={12} />{t('st.remote.way.url')}
              </button>
              <button
                type="button"
                role="tab"
                data-remote-add-way="ssh"
                aria-selected={!onUrlWay}
                onClick={() => { setWay('ssh'); }}
                className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${!onUrlWay ? 'bg-selected text-selected-ink' : ''}`}
              >
                <Icon name="terminal" size={12} />{t('st.remote.way.ssh')}
              </button>
            </div>
          </div>
        ) : null}

        {sshFlag.enabled === true && savedHosts.length === 0 ? (
          <p data-remote-ssh-no-hosts className="text-[12px] leading-snug text-ink-soft">
            {t('st.remote.way.sshNoHosts')}{' '}
            <button
              type="button"
              data-remote-ssh-open-hosts
              onClick={() => { onClose(); void navigate('/settings/ssh'); }}
              className="font-medium text-accent-ink underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              {t('st.remote.way.sshOpenHosts')}
            </button>
          </p>
        ) : null}

        <SettingField
          label={t('st.remote.endpointField')}
          htmlFor="remote-connection-endpoint"
          layout="stack"
          help={t('st.remote.endpointHint')}
        >
          <input
            id="remote-connection-endpoint"
            data-remote-endpoint
            className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={endpoint}
            spellCheck={false}
            placeholder="http://192.168.1.20:58627"
            onChange={(event) => {
              const parsed = parsePairingUri(event.target.value);
              if (parsed !== undefined) {
                setEndpoint(completeConnectionEndpoint(parsed.endpoint));
                setCode(parsed.code);
                setPairingFingerprint(parsed.fingerprint ?? '');
                return;
              }
              setPairingFingerprint('');
              setEndpoint(event.target.value);
            }}
            onBlur={() => {
              setEndpoint((value) => completeConnectionEndpoint(value));
              setTouched((state) => ({ ...state, endpoint: true }));
            }}
          />
          {touched.endpoint && endpointProblem !== null ? (
            <p className="text-[12px] text-danger" role="alert" data-remote-endpoint-problem>
              {t(endpointProblem)}
            </p>
          ) : null}
        </SettingField>

        <SettingField
          label={t('st.remote.codeField')}
          htmlFor="remote-connection-code"
          layout="stack"
          help={t('st.remote.codeHint')}
        >
          <input
            id="remote-connection-code"
            data-remote-code
            className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[18px] tracking-[0.14em] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={code}
            spellCheck={false}
            autoCapitalize="characters"
            autoCorrect="off"
            placeholder="XXXX-XXXX"
            onChange={(event) => {
              const parsed = parsePairingUri(event.target.value);
              if (parsed !== undefined) {
                setEndpoint(completeConnectionEndpoint(parsed.endpoint));
                setCode(parsed.code);
                setPairingFingerprint(parsed.fingerprint ?? '');
                return;
              }
              setPairingFingerprint('');
              setCode(formatPairingCode(event.target.value));
            }}
            onBlur={() => { setTouched((state) => ({ ...state, code: true })); }}
          />
          {touched.code && codeProblem !== null ? (
            <p className="text-[12px] text-danger" role="alert" data-remote-code-problem>
              {t(codeProblem)}
            </p>
          ) : null}
        </SettingField>

        <SettingField
          label={t('st.remote.labelField')}
          htmlFor="remote-connection-label"
          layout="stack"
          help={t('st.remote.labelOptional')}
        >
          <input
            id="remote-connection-label"
            data-remote-label
            className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={label}
            maxLength={128}
            spellCheck={false}
            placeholder={t('st.remote.labelOptional')}
            onChange={(event) => { setLabel(event.target.value); }}
            onBlur={() => { setTouched((state) => ({ ...state, label: true })); }}
          />
          {touched.label && labelProblem !== null ? (
            <p className="text-[12px] text-danger" role="alert">{t(labelProblem)}</p>
          ) : null}
        </SettingField>

        <div className="space-y-3 border-t border-hairline pt-4">
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink" htmlFor="remote-connection-request-bridge">
            <input
              id="remote-connection-request-bridge"
              type="checkbox"
              data-remote-request-bridge
              checked={requestBridge}
              onChange={(event) => { setRequestBridge(event.target.checked); }}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-strong accent-selected-ink"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{t('st.remote.requestBridge')}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t('st.remote.requestBridgeHint')}</span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink" htmlFor="remote-connection-background">
            <input
              id="remote-connection-background"
              type="checkbox"
              data-remote-background-summary
              checked={background}
              onChange={(event) => { setBackground(event.target.checked); }}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-strong accent-selected-ink"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{t('st.remote.pairBackground')}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t('st.remote.pairBackgroundHint')}</span>
            </span>
          </label>
        </div>

        <FeedbackLine feedback={failure} />
      </form>
    </SidePanel>
  );
}

function InboundPairSheet({
  client,
  onClose,
  onInvited,
}: {
  readonly client: KikiClient;
  readonly onClose: () => void;
  readonly onInvited?: () => void;
}) {
  const { t, locale } = useI18n();
  const invitedRef = useRef(onInvited);
  invitedRef.current = onInvited;
  const inboundStatus = useInboundStatus(client);
  const gateAlreadyOn = inboundStatus.data?.enabled === true;
  const devBypass = inboundStatus.data?.unavailableReason === 'dangerous_auth_bypass';

  const [allowBridge, setAllowBridge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [issued, setIssued] = useState<PairCodeCreateOutput | null>(null);
  const [baselineGrantIds, setBaselineGrantIds] = useState<ReadonlySet<string> | null>(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (issued === null) return undefined;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [issued]);

  useEffect(() => {
    if (issued === null) return undefined;
    const poll = window.setInterval(() => { void inboundStatus.refetch(); }, 2_500);
    return () => { window.clearInterval(poll); };
  }, [issued, inboundStatus]);

  const generateCode = async () => {
    if (saving || devBypass) return;
    setSaving(true);
    setFailure(null);
    const knownGrants = new Set((inboundStatus.data?.grants ?? []).map((grant) => grant.id));
    try {
      const created = await connectionsApi(client).createPairCode(
        allowBridge
          ? { allowBridge: true, bridgeOperations: ['read', 'send', 'wait', 'wake'] }
          : { allowBridge: false },
      );
      setBaselineGrantIds(knownGrants);
      setIssued(created);
      setSelectedEndpoint(created.suggestedEndpoints[0] ?? '');
      setNow(Date.now());
      invitedRef.current?.();
      void inboundStatus.refetch();
    } catch (error) {
      const reason = connectionFailureText(error instanceof Error ? error.message : '');
      setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
    } finally {
      setSaving(false);
    }
  };

  const newlyPairedGrant = issued !== null && baselineGrantIds !== null
    ? (inboundStatus.data?.grants ?? []).find((grant) => grant.status === 'approved' && !baselineGrantIds.has(grant.id))
    : undefined;

  if (issued === null) {
    return (
      <SidePanel
        onClose={onClose}
        overlayId="pair-sheet-inbound"
        title={t('st.inbound.inviteTitle')}
        width="md"
        data={{ 'data-pair-sheet': 'inbound', 'data-inbound-consent': '' }}
        footer={(
          <>
            <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-inbound-generate-code
              className={PRIMARY_BUTTON}
              disabled={saving || devBypass}
              title={devBypass ? t('st.inbound.devRuntime') : undefined}
              onClick={() => { void generateCode(); }}
            >
              {saving
                ? t('st.inbound.codeWorking')
                : gateAlreadyOn
                  ? t('st.inbound.generateCode')
                  : t('st.inbound.turnOnAndGenerate')}
            </button>
          </>
        )}
      >
        <div className="space-y-4">
          <p className="text-[13px] text-ink-soft">{t('st.inbound.consentLead')}</p>

          <div className="space-y-3 rounded-lg border border-hairline bg-ink/[0.02] p-3.5">
            <label className="flex items-start gap-2.5 text-[13px] text-ink">
              <input
                type="checkbox"
                checked
                disabled
                data-inbound-consent-open
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-strong accent-selected-ink"
              />
              <span className="font-medium text-ink">{t('st.inbound.consentOpen')}</span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink" htmlFor="inbound-consent-bridge">
              <input
                id="inbound-consent-bridge"
                type="checkbox"
                data-inbound-consent-bridge
                checked={allowBridge}
                onChange={(event) => { setAllowBridge(event.target.checked); }}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-strong accent-selected-ink"
              />
              <span className="font-medium text-ink">{t('st.inbound.consentBridge')}</span>
            </label>
          </div>

          {!gateAlreadyOn && !devBypass ? (
            <p className="text-[12.5px] leading-relaxed text-ink-soft" data-inbound-gate-consequence>
              {t('st.inbound.consentGateNote')}
            </p>
          ) : null}

          {devBypass ? (
            <p className="text-[12px] leading-snug text-amber-ink" data-inbound-dev-runtime>
              {t('st.inbound.devRuntime')}
            </p>
          ) : null}

          <FeedbackLine feedback={failure} />
        </div>
      </SidePanel>
    );
  }

  const expired = issued.expiresAt <= now;
  const activeEndpoint = issued.suggestedEndpoints.includes(selectedEndpoint)
    ? selectedEndpoint
    : issued.suggestedEndpoints[0];
  const qrUri = !expired && newlyPairedGrant === undefined && activeEndpoint !== undefined
    ? formatPairingUri({ endpoint: activeEndpoint, code: issued.code, fingerprint: issued.tlsFingerprint })
    : undefined;
  const qrImage = qrUri === undefined ? undefined : wechatQrImage(qrUri);

  return (
    <SidePanel
      onClose={onClose}
      overlayId="pair-sheet-inbound"
      title={t('st.inbound.inviteTitle')}
      description={t('st.inbound.inviteBody')}
      width="md"
      data={{ 'data-pair-sheet': 'inbound', 'data-inbound-pair-code': '' }}
      footer={(
        <>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-inbound-code-regenerate
            disabled={saving}
            onClick={() => { void generateCode(); }}
          >
            {t('st.inbound.codeRegenerate')}
          </button>
          <button type="button" data-inbound-invite-done className={PRIMARY_BUTTON} onClick={onClose}>
            {t('st.inbound.invitationDone')}
          </button>
        </>
      )}
    >
      <div className="space-y-5">
        {newlyPairedGrant !== undefined ? (
          <div className="rounded-lg border border-success/40 bg-success/[0.06] px-3.5 py-3 text-[13px] font-medium text-success" data-inbound-paired-notice>
            {t('st.inbound.pairedNotice', { name: newlyPairedGrant.label })}
          </div>
        ) : null}

        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-[14rem] flex-1 space-y-3">
            <p data-inbound-code className="font-mono text-[1.75rem] leading-none tracking-[0.14em] text-ink">
              {issued.code}
            </p>
            <CopyField
              id="inbound-pair-code-value"
              dataAttr="inbound-pair-code"
              label={t('st.inbound.codeLabel')}
              value={issued.code}
              copyLabel={t('st.inbound.codeCopy')}
              copiedLabel={t('st.inbound.codeCopied')}
              hint={t('st.inbound.codeOnce')}
            />
            {issued.tlsFingerprint !== undefined ? (
              <p className="break-all text-[12px] text-ink-soft" data-inbound-tls-fingerprint>
                {t('st.inbound.tlsFingerprint')}: <span className="font-mono text-ink" title={issued.tlsFingerprint}>{fingerprint(issued.tlsFingerprint, 16, 8)}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft" data-inbound-code-remaining>
              {expired ? (
                <>
                  <span className="text-amber-ink">{t('st.inbound.codeExpired')}</span>
                  <button
                    type="button"
                    className="font-medium text-ink underline decoration-hairline-strong underline-offset-2 hover:text-accent"
                    disabled={saving}
                    onClick={() => { void generateCode(); }}
                  >
                    {t('st.inbound.codeRegenerate')}
                  </button>
                </>
              ) : (
                <span>{t('st.inbound.codeRemaining', { time: remainingLabel(issued.expiresAt, now) })}</span>
              )}
            </div>
          </div>
          {qrImage !== undefined && qrUri !== undefined ? (
            <img
              src={qrImage}
              alt={t('st.inbound.inviteTitle')}
              data-inbound-qr
              data-inbound-qr-uri={qrUri}
              className="h-32 w-32 shrink-0 rounded-lg bg-[#fbfaf6] p-1.5"
            />
          ) : null}
        </div>

        <div data-inbound-code-addresses>
          <p className="text-[13px] text-ink">{t('st.inbound.codeAddresses')}</p>
          {issued.suggestedEndpoints.length === 0 ? (
            <p className="mt-1 text-[12px] text-ink-faint">{t('st.inbound.codeNoAddress')}</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {issued.suggestedEndpoints.map((address) => (
                <li
                  key={address}
                  data-inbound-code-address
                  data-inbound-code-address-active={address === activeEndpoint ? '' : undefined}
                  onClick={issued.suggestedEndpoints.length > 1 ? () => { setSelectedEndpoint(address); } : undefined}
                  className={`break-all font-mono text-[12px] ${issued.suggestedEndpoints.length > 1 ? 'cursor-pointer' : ''} ${address === activeEndpoint && issued.suggestedEndpoints.length > 1 ? 'font-medium text-ink' : 'text-ink-soft'}`}
                >
                  {address}
                </li>
              ))}
            </ul>
          )}
        </div>

        <FeedbackLine feedback={failure} />
      </div>
    </SidePanel>
  );
}
