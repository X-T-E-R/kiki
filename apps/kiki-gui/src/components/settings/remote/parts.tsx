/**
 * Shared pieces for the remote-connection surfaces: one status chip used by
 * both the space switcher and the settings rows, and the paste block a person
 * copies between two Kikis.
 */

import { useState, type ReactNode } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { copyTextToClipboard } from '../../../lib/clipboard';
import { connectionStateKey, connectionStateTone, type RemoteStateTone } from '../../../lib/remoteConnections';
import { Icon } from '../../icons';
import { Hint } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';

const TONE_CLASS: Record<RemoteStateTone, string> = {
  online: 'bg-success',
  attention: 'bg-attention',
  offline: 'border border-ink-faint/70',
  muted: 'bg-ink-faint/50',
};

const TONE_TEXT_CLASS: Record<RemoteStateTone, string> = {
  online: 'text-success',
  attention: 'text-attention',
  offline: 'text-ink-soft',
  muted: 'text-ink-faint',
};

/**
 * OneKiki's real state. A stale reading keeps its dot and adds "as of …", so an
 * offline space never quietly reads as if nothing ever happened.
 */
export function RemoteStateChip({ state, staleLabel, className = '' }: {
  state: Parameters<typeof connectionStateKey>[0];
  /** e.g. "as of 4m ago" for a value kept from before the connection dropped. */
  staleLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const tone = connectionStateTone(state);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[12px] ${TONE_TEXT_CLASS[tone]} ${className}`} data-remote-state={state}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONE_CLASS[tone]}`} />
      {t(connectionStateKey(state))}
      {staleLabel !== undefined ? <span className="text-ink-faint">· {staleLabel}</span> : null}
    </span>
  );
}

/**
 * A value that exists to be copied to the other machine: monospace, wrapping,
 * with the copy button next to it and the one thing the person must know.
 */
export function CopyField({ id, label, value, copyLabel, copiedLabel, hint, dataAttr }: {
  id: string;
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  hint?: ReactNode;
  dataAttr?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const copy = async () => {
    setFailed(null);
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 1_600);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div data-copy-field={dataAttr}>
      <span className="text-[13px] text-ink" id={`${id}-label`}>{label}</span>
      <div className="mt-1.5 flex items-start gap-2">
        <code id={id} aria-labelledby={`${id}-label`}
          className="min-w-0 flex-1 break-all rounded-md bg-ink/[0.04] px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink-soft">
          {value}
        </code>
        <button type="button" className={SECONDARY_BUTTON} data-copy-action onClick={() => { void copy(); }}>
          <Icon name="copy" size={12} className="mr-1 inline-block align-[-1px]" />
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      {hint !== undefined ? <div className="mt-1.5"><Hint>{hint}</Hint></div> : null}
      {failed !== null ? <p className="mt-1.5 text-[12px] text-danger" role="alert">{t('st.remote.copyFailed', { reason: failed })}</p> : null}
    </div>
  );
}

/** Server refusals, in the person's terms; an unknown reason passes through raw. */
const FAILURE_KEYS: readonly (readonly [string, I18nKey])[] = [
  ['inbound_disabled', 'st.remote.fail.inboundDisabled'],
  ['dangerous_auth_bypass', 'st.remote.fail.devRuntime'],
  ['invalid_invitation', 'st.remote.fail.invitation'],
  ['connection_claim_failed', 'st.remote.fail.invitation'],
  ['identity_changed', 'st.remote.fail.identity'],
  ['connection_not_approved', 'st.remote.fail.notApproved'],
  ['connection_requires_tls', 'st.remote.endpoint.tls'],
  ['invalid_connection_endpoint', 'st.remote.endpoint.invalid'],
  ['handshake_failed', 'st.remote.fail.handshake'],
  ['authentication_required', 'st.remote.fail.token'],
  ['connection_disabled', 'st.remote.fail.disabled'],
  ['connection_paused', 'st.remote.fail.paused'],
  ['gui_connection_required', 'st.remote.fail.guiRequired'],
  ['local_owner_required', 'st.remote.fail.ownerOnly'],
  ['connection_stopped', 'st.remote.fail.paused'],
  ['grant_not_found', 'st.remote.fail.grantGone'],
];

export function connectionFailureText(message: string): I18nKey | null {
  for (const [needle, key] of FAILURE_KEYS) if (message.includes(needle)) return key;
  return null;
}
