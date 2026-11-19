/**
 * PairSheet — unified pairing sheet with two explicit directions (#21):
 * - `'outbound'`: "Pair a space on another computer" (address + pairing code or
 *   one-click `kiki://pair` URI, or SSH in the desktop app; `requestBridge` and
 *   `borrowTools` enabled by default).
 * - `'inbound'`: "Pairing code" (pre-consent screen naming what the peer can do
 *   and what generating a code switches on before any request is sent; thread
 *   messages and tool sharing enabled by default).
 *
 * Renders as a `SidePanel` (right sheet on desktop, full-height sheet on
 * phones).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { formatPairingUri, type BridgeOperation, type PairCodeCreateOutput, type RemoteConnection, type SshHost } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  completeConnectionEndpoint,
  connectionAddress,
  connectionsApi,
  endpointIssue,
  endpointNetworkKind,
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

const BASE_BRIDGE_OPERATIONS: readonly BridgeOperation[] = ['read', 'send', 'wait', 'wake', 'create'];

function remainingLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function endpointNetworkLabelKey(address: string): I18nKey | null {
  switch (endpointNetworkKind(address)) {
    case 'lan':
      return 'st.remote.endpointNetwork.lan';
    case 'tailscale':
      return 'st.remote.endpointNetwork.tailscale';
    case 'https':
      return 'st.remote.endpointNetwork.https';
    default:
      return null;
  }
}

export function PairSheet({
  client,
  direction,
  allowInboundTab = false,
  sshProfiles,
  defaultHome,
  initial,
  onClose,
  onPaired,
  onInvited,
}: {
  readonly client: KikiClient;
  readonly direction: PairSheetDirection;
  readonly allowInboundTab?: boolean;
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
      allowInboundTab={allowInboundTab}
      sshProfiles={sshProfiles}
      defaultHome={defaultHome}
      initial={initial}
      onClose={onClose}
      onPaired={onPaired}
      onInvited={onInvited}
    />
  );
}

function OutboundPairSheet({
  client,
  allowInboundTab,
  sshProfiles,
  defaultHome,
  initial,
  onClose,
  onPaired,
  onInvited,
}: {
  readonly client: KikiClient;
  readonly allowInboundTab: boolean;
  readonly sshProfiles?: readonly SshHost[];
  readonly defaultHome?: string;
  readonly initial?: AddConnectionStart;
  readonly onClose: () => void;
  readonly onPaired?: (record: RemoteConnection) => void;
  readonly onInvited?: () => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const sshFlag = useNativeSshEnabled(client);
  const hostsQuery = useSshHosts(client, sshFlag.enabled === true);
  const savedHosts = sshProfiles ?? hostsQuery.data ?? [];
  const spaces = useSpaces(client);
  const home = defaultHome ?? spaces.data?.find((space) => space.id === MAIN_SPACE_ID)?.path ?? '';

  const [way, setWay] = useState<'url' | 'inbound' | 'ssh'>(initial?.kind ?? 'url');
  const [profileId] = useState(initial?.kind === 'ssh' ? initial.profileId : '');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [pairingFingerprint, setPairingFingerprint] = useState('');
  const [requestBridge, setRequestBridge] = useState(true);
  const [borrowTools, setBorrowTools] = useState(true);
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
  const canPasteFromClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

  const applyPastedValue = (raw: string): boolean => {
    const parsed = parsePairingUri(raw);
    if (parsed !== undefined) {
      setEndpoint(completeConnectionEndpoint(parsed.endpoint));
      setCode(parsed.code);
      setPairingFingerprint(parsed.fingerprint ?? '');
      return true;
    }
    return false;
  };

  const pasteFromClipboard = async () => {
    if (!canPasteFromClipboard) return;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text === '') return;
      if (!applyPastedValue(text)) {
        setPairingFingerprint('');
        setEndpoint(completeConnectionEndpoint(text));
      }
      setFailure(null);
    } catch {
      // Clipboard read can be declined by the browser; the user can paste directly into either field.
    }
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setTouched({ label: true, endpoint: true, code: true });
    if (blocked) return;
    setSaving(true);
    setFailure(null);
    try {
      const effectiveBorrowTools = requestBridge && borrowTools;
      const record = await connectionsApi(client).pair({
        endpoint: completedEndpoint,
        code: code.trim(),
        label: label.trim() === '' ? undefined : label.trim(),
        backgroundSummary: background,
        requestBridge,
        borrowTools: effectiveBorrowTools,
        bridgeOperations: requestBridge
          ? (effectiveBorrowTools ? [...BASE_BRIDGE_OPERATIONS, 'tools'] : [...BASE_BRIDGE_OPERATIONS])
          : undefined,
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

  const showModeTabs = allowInboundTab || sshFlag.enabled === true;
  const modeTabs = showModeTabs ? (
    <div className="space-y-1.5">
      {!allowInboundTab ? (
        <span className="block text-[12px] font-medium text-ink-soft">{t('st.remote.way.label')}</span>
      ) : null}
      <div role="tablist" aria-label={t('st.remote.way.label')} data-remote-add-ways className="flex flex-wrap gap-1.5">
        <button
          type="button"
          role="tab"
          data-remote-add-way="url"
          data-pair-tab="outbound"
          aria-selected={way === 'url'}
          onClick={() => { setWay('url'); }}
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${way === 'url' ? 'bg-selected text-selected-ink' : ''}`}
        >
          <Icon name="web" size={12} />{t(allowInboundTab ? 'st.remote.way.outbound' : 'st.remote.way.url')}
        </button>
        {allowInboundTab ? (
          <button
            type="button"
            role="tab"
            data-pair-tab="inbound"
            aria-selected={way === 'inbound'}
            onClick={() => { setWay('inbound'); }}
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${way === 'inbound' ? 'bg-selected text-selected-ink' : ''}`}
          >
            <Icon name="smartphone" size={12} />{t('st.remote.way.inbound')}
          </button>
        ) : null}
        {sshFlag.enabled === true ? (
          <button
            type="button"
            role="tab"
            data-remote-add-way="ssh"
            data-pair-tab="ssh"
            aria-selected={way === 'ssh'}
            onClick={() => { setWay('ssh'); }}
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${way === 'ssh' ? 'bg-selected text-selected-ink' : ''}`}
          >
            <Icon name="terminal" size={12} />{t('st.remote.way.ssh')}
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  if (way === 'inbound' && allowInboundTab) {
    return (
      <InboundPairSheet
        client={client}
        onClose={onClose}
        onInvited={onInvited}
        autoMintWhenEnabled
        headerSlot={modeTabs}
        width="lg"
      />
    );
  }

  if (way === 'ssh') {
    return (
      <AddConnectionBySshDialog
        client={client}
        profiles={savedHosts}
        defaultHome={home}
        initialProfileId={profileId === '' ? undefined : profileId}
        headerSlot={modeTabs}
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
        {modeTabs}

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
          <div className="flex items-center gap-2">
            <input
              id="remote-connection-endpoint"
              data-remote-endpoint
              className="min-w-0 flex-1 rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
              value={endpoint}
              spellCheck={false}
              placeholder="http://192.168.1.20:58627"
              onChange={(event) => {
                if (applyPastedValue(event.target.value)) return;
                setPairingFingerprint('');
                setEndpoint(event.target.value);
              }}
              onBlur={() => {
                setEndpoint((value) => completeConnectionEndpoint(value));
                setTouched((state) => ({ ...state, endpoint: true }));
              }}
            />
            {canPasteFromClipboard ? (
              <button
                type="button"
                data-remote-paste-link
                onClick={() => { void pasteFromClipboard(); }}
                className={`${SECONDARY_BUTTON} shrink-0`}
              >
                {t('st.remote.pasteLink')}
              </button>
            ) : null}
          </div>
          {pairingFingerprint !== '' ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <span
                data-remote-tls-pinned
                title={pairingFingerprint}
                className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-ink/[0.04] px-2.5 py-0.5 font-mono text-[11px] text-ink-soft"
              >
                <Icon name="lock" size={12} className="shrink-0 text-success" />
                <span>{t('st.remote.tlsPinnedBadge', { fingerprint: fingerprint(pairingFingerprint, 8, 4) })}</span>
                <button
                  type="button"
                  data-remote-tls-pinned-clear
                  aria-label={t('st.remote.tlsPinnedClear')}
                  onClick={() => { setPairingFingerprint(''); }}
                  className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.08] hover:text-ink"
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            </div>
          ) : null}
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
              if (applyPastedValue(event.target.value)) return;
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
          <div className="space-y-2.5">
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

            <label
              className={`ml-6 flex items-start gap-2.5 text-[12.5px] ${requestBridge ? 'cursor-pointer text-ink' : 'cursor-not-allowed text-ink-faint opacity-60'}`}
              htmlFor="remote-connection-borrow-tools"
            >
              <input
                id="remote-connection-borrow-tools"
                type="checkbox"
                data-remote-borrow-tools
                checked={requestBridge && borrowTools}
                disabled={!requestBridge}
                onChange={(event) => { setBorrowTools(event.target.checked); }}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-strong accent-selected-ink"
              />
              <span className="font-medium">{t('st.remote.borrowTools')}</span>
            </label>
          </div>

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
  autoMintWhenEnabled = false,
  headerSlot,
  width = 'md',
}: {
  readonly client: KikiClient;
  readonly onClose: () => void;
  readonly onInvited?: () => void;
  readonly autoMintWhenEnabled?: boolean;
  readonly headerSlot?: ReactNode;
  readonly width?: 'md' | 'lg';
}) {
  const { t, locale } = useI18n();
  const invitedRef = useRef(onInvited);
  invitedRef.current = onInvited;
  const inboundStatus = useInboundStatus(client);
  const gateAlreadyOn = inboundStatus.data?.enabled === true;
  const devBypass = inboundStatus.data?.unavailableReason === 'dangerous_auth_bypass';

  const [allowBridge, setAllowBridge] = useState(true);
  const [allowTools, setAllowTools] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [issued, setIssued] = useState<PairCodeCreateOutput | null>(null);
  const [baselineGrantIds, setBaselineGrantIds] = useState<ReadonlySet<string> | null>(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const autoMintedRef = useRef(false);
  const savingRef = useRef(false);

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

  const generateCode = useCallback(async () => {
    if (savingRef.current || devBypass) return;
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    const knownGrants = new Set((inboundStatus.data?.grants ?? []).map((grant) => grant.id));
    try {
      const created = await connectionsApi(client).createPairCode(
        allowBridge
          ? {
              allowBridge: true,
              bridgeOperations: allowTools
                ? [...BASE_BRIDGE_OPERATIONS, 'tools']
                : [...BASE_BRIDGE_OPERATIONS],
            }
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
      savingRef.current = false;
      setSaving(false);
    }
  }, [allowBridge, allowTools, client, devBypass, inboundStatus, locale, t]);

  useEffect(() => {
    if (!autoMintWhenEnabled || autoMintedRef.current || issued !== null || devBypass) return;
    if (inboundStatus.data?.enabled !== true) return;
    autoMintedRef.current = true;
    void generateCode();
  }, [autoMintWhenEnabled, devBypass, generateCode, inboundStatus.data?.enabled, issued]);

  const newlyPairedGrant = issued !== null && baselineGrantIds !== null
    ? (inboundStatus.data?.grants ?? []).find((grant) => grant.status === 'approved' && !baselineGrantIds.has(grant.id))
    : undefined;

  const waitingForAutoMint = autoMintWhenEnabled && issued === null && failure === null && (
    inboundStatus.isPending || (gateAlreadyOn && !devBypass)
  );

  if (waitingForAutoMint) {
    return (
      <SidePanel
        onClose={onClose}
        overlayId="pair-sheet-inbound"
        title={t(autoMintWhenEnabled ? 'st.remote.way.inbound' : 'st.inbound.inviteTitle')}
        description={autoMintWhenEnabled ? t('st.inbound.pairThisComputerDesc') : undefined}
        width={width}
        data={{ 'data-pair-sheet': 'inbound', 'data-inbound-loading': '' }}
        footer={(
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t('common.cancel')}
          </button>
        )}
      >
        <div className="space-y-5">
          {headerSlot}
          <p className="text-[13px] text-ink-soft" role="status">{t('st.inbound.codeWorking')}</p>
        </div>
      </SidePanel>
    );
  }

  if (issued === null) {
    return (
      <SidePanel
        onClose={onClose}
        overlayId="pair-sheet-inbound"
        title={t(autoMintWhenEnabled ? 'st.remote.way.inbound' : 'st.inbound.inviteTitle')}
        description={autoMintWhenEnabled ? t('st.inbound.pairThisComputerDesc') : undefined}
        width={width}
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
                  : t(autoMintWhenEnabled ? 'st.inbound.turnOnAndShow' : 'st.inbound.turnOnAndGenerate')}
            </button>
          </>
        )}
      >
        <div className="space-y-4">
          {headerSlot}
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

            <div className="space-y-2">
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

              <label
                className={`ml-6 flex items-start gap-2.5 text-[12.5px] ${allowBridge ? 'cursor-pointer text-ink-soft' : 'cursor-not-allowed text-ink-faint opacity-60'}`}
                htmlFor="inbound-consent-tools"
              >
                <input
                  id="inbound-consent-tools"
                  type="checkbox"
                  data-inbound-consent-tools
                  checked={allowBridge && allowTools}
                  disabled={!allowBridge}
                  onChange={(event) => { setAllowTools(event.target.checked); }}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-strong accent-selected-ink"
                />
                <span>{t('st.inbound.consentTools')}</span>
              </label>
            </div>
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
      title={t(autoMintWhenEnabled ? 'st.remote.way.inbound' : 'st.inbound.inviteTitle')}
      description={t(autoMintWhenEnabled ? 'st.inbound.pairThisComputerDesc' : 'st.inbound.inviteBody')}
      width={width}
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
        {headerSlot}
        {newlyPairedGrant !== undefined ? (
          <div className="rounded-lg border border-success/40 bg-success/[0.06] px-3.5 py-3 text-[13px] font-medium text-success" data-inbound-paired-notice>
            {t('st.inbound.pairedNotice', { name: newlyPairedGrant.label })}
          </div>
        ) : null}

        {qrUri !== undefined ? (
          <CopyField
            id="inbound-pair-uri-value"
            dataAttr="inbound-pair-uri"
            label={t('st.inbound.pairUriLabel')}
            value={qrUri}
            copyLabel={t('st.inbound.pairUriCopy')}
            copiedLabel={t('st.inbound.pairUriCopied')}
          />
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
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {issued.suggestedEndpoints.map((address) => {
                const active = address === activeEndpoint;
                const networkKey = endpointNetworkLabelKey(address);
                return (
                  <button
                    key={address}
                    type="button"
                    data-inbound-code-address
                    data-inbound-code-address-active={active ? '' : undefined}
                    aria-pressed={active}
                    title={address}
                    onClick={() => { setSelectedEndpoint(address); }}
                    className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-left text-[12px] transition-colors ${
                      active
                        ? 'border-selected-ink/40 bg-selected font-medium text-selected-ink'
                        : 'border-hairline bg-ink/[0.02] text-ink-soft hover:border-hairline-strong hover:text-ink'
                    }`}
                  >
                    {active ? <Icon name="check" size={12} className="shrink-0" /> : null}
                    {networkKey !== null ? (
                      <span className="shrink-0 text-[11px] font-medium opacity-80" data-inbound-endpoint-kind={endpointNetworkKind(address)}>
                        {t(networkKey)}
                      </span>
                    ) : null}
                    {networkKey !== null ? <span aria-hidden className="opacity-45">·</span> : null}
                    <span className="break-all font-mono">{connectionAddress(address)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <FeedbackLine feedback={failure} />
      </div>
    </SidePanel>
  );
}
