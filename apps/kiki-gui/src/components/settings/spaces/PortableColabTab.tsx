import { useEffect, useId, useMemo, useState } from 'react';

import type {
  PortableSpaceEncryption,
  PortableSpaceInspectResult,
  PortableSpaceSourceRecord,
  PortableSpaceUnlock,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { copyTextToClipboard } from '../../../lib/clipboard';
import { buildColabCommand, portableSpacesApi } from '../../../lib/portableSpaces';
import { pushToast } from '../../../lib/toasts';
import { FeedbackLine, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';

type RekeyMode = 'x25519' | 'passphrase';

export interface PortableColabTabProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly source: PortableSpaceSourceRecord;
  readonly inspect?: PortableSpaceInspectResult;
  readonly deviceRecipient?: string;
  readonly portableSources: readonly PortableSpaceSourceRecord[];
  readonly unlock?: PortableSpaceUnlock;
  readonly onRekeyed: (next: PortableSpaceInspectResult, nextUnlock?: PortableSpaceUnlock) => void;
}

export function PortableColabTab({
  client,
  token,
  source,
  inspect,
  deviceRecipient,
  portableSources,
  unlock,
  onRekeyed,
}: PortableColabTabProps) {
  const { t, locale } = useI18n();
  const recipientsId = useId();
  const passId = useId();
  const passIssueId = useId();

  const overlayCandidates = useMemo(
    () => portableSources.filter((item) => item.id !== source.id),
    [portableSources, source.id],
  );
  const [overlayId, setOverlayId] = useState('');
  const [rekeyMode, setRekeyMode] = useState<RekeyMode>(
    (inspect?.encryptionMode ?? source.encryptionMode) === 'passphrase' ? 'passphrase' : 'x25519',
  );
  const inspectRecipientsKey = inspect?.recipients.join('\n') ?? '';
  const [recipientsText, setRecipientsText] = useState(() =>
    inspectRecipientsKey !== '' ? inspectRecipientsKey : (deviceRecipient ?? ''),
  );
  useEffect(() => {
    if (inspectRecipientsKey !== '') {
      setRecipientsText(inspectRecipientsKey);
    } else if (deviceRecipient !== undefined) {
      setRecipientsText(deviceRecipient);
    }
  }, [inspectRecipientsKey, deviceRecipient]);
  const [passphrase, setPassphrase] = useState('');
  const [passIssue, setPassIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const selectedOverlay = overlayCandidates.find((item) => item.id === overlayId);
  const colabCommand = useMemo(
    () => buildColabCommand({ source: source.endpoint, overlay: selectedOverlay?.endpoint }),
    [source.endpoint, selectedOverlay?.endpoint],
  );

  const targetPath = source.endpoint.kind === 'archive' || source.endpoint.kind === 'dir' ? source.endpoint.path : null;
  const canRekey = targetPath !== null && (source.format === 'age' || source.secretMode === 'sealed');

  const copyRecipient = async () => {
    if (deviceRecipient === undefined) return;
    try {
      await copyTextToClipboard(deviceRecipient);
      pushToast({ tone: 'success', text: t('st.portable.deviceKeyCopied') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const copyColab = async () => {
    try {
      await copyTextToClipboard(colabCommand);
      pushToast({ tone: 'success', text: t('st.portable.colabCopied') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const submitRekey = async () => {
    if (targetPath === null || busy) return;
    if (rekeyMode === 'passphrase' && passphrase.trim() === '') {
      setPassIssue(t('st.portable.passphraseRequired'));
      return;
    }
    const recipients = recipientsText
      .split(/[\r\n,]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const trimmedPassphrase = passphrase.trim();
    const encryption: PortableSpaceEncryption = rekeyMode === 'passphrase'
      ? { mode: 'passphrase', passphrase: trimmedPassphrase }
      : { mode: 'x25519', recipients: recipients.length > 0 ? recipients : undefined };
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await portableSpacesApi(client).rekey({
        target: targetPath,
        unlock,
        encryption,
      });
      setPassphrase('');
      setFeedback({ tone: 'success', text: t('st.portable.rekeyDone') });
      onRekeyed(updated, rekeyMode === 'passphrase' ? { passphrase: trimmedPassphrase } : undefined);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6" data-portable-colab-tab>
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[13px] font-medium text-ink">{t('st.portable.colabTitle')}</h4>
          {overlayCandidates.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-faint">{t('st.portable.colabOverlay')}</span>
              <SettingsSelect<string>
                ariaLabel={t('st.portable.colabOverlay')}
                dataAttr="data-portable-colab-overlay"
                value={overlayId}
                onChange={setOverlayId}
                choices={[
                  { value: '', label: t('st.portable.colabOverlayNone') },
                  ...overlayCandidates.map((item) => ({ value: item.id, label: item.label })),
                ]}
              />
            </div>
          ) : null}
        </div>
        <pre
          data-portable-colab-command
          className="overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-paper px-3.5 py-3 font-mono text-[12px] leading-5 text-ink"
        >
          <code>{colabCommand}</code>
        </pre>
        <div>
          <button
            type="button"
            data-portable-copy-colab
            className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
            onClick={() => { void copyColab(); }}
          >
            <Icon name="copy" size={12} />
            {t('st.portable.colabCopy')}
          </button>
        </div>
      </div>

      {deviceRecipient !== undefined ? (
        <div className="space-y-2 border-t border-hairline pt-5">
          <p className="text-[13px] font-medium text-ink">{t('st.portable.deviceKeyLabel')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              data-portable-device-recipient
              className="min-w-0 flex-1 truncate rounded-md border border-hairline bg-paper px-3 py-1.5 font-mono text-[12px] text-ink-soft"
              title={deviceRecipient}
            >
              {deviceRecipient}
            </code>
            <button
              type="button"
              data-portable-copy-recipient
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
              onClick={() => { void copyRecipient(); }}
            >
              <Icon name="copy" size={12} />
              {t('st.portable.deviceKeyCopy')}
            </button>
          </div>
        </div>
      ) : null}

      {canRekey ? (
        <div className="space-y-3 border-t border-hairline pt-5" data-portable-rekey-section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-ink">{t('st.portable.rekeyTitle')}</p>
            <SettingsSegmented<RekeyMode>
              ariaLabel={t('st.portable.rekeyTitle')}
              dataAttr="data-portable-rekey-mode"
              value={rekeyMode}
              onChange={(next) => { setRekeyMode(next); setPassIssue(null); }}
              choices={[
                { value: 'x25519', label: t('st.portable.enc.x25519') },
                { value: 'passphrase', label: t('st.portable.enc.passphrase') },
              ]}
            />
          </div>

          {rekeyMode === 'x25519' ? (
            <div>
              <label htmlFor={recipientsId} className={FORM_LABEL}>{t('st.portable.recipientsLabel')}</label>
              <textarea
                id={recipientsId}
                rows={2}
                data-portable-rekey-recipients
                value={recipientsText}
                placeholder={t('st.portable.recipientsPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setRecipientsText(event.target.value); }}
                className={`${INPUT} mt-1.5 font-mono text-[12px]`}
              />
            </div>
          ) : (
            <div>
              <label htmlFor={passId} className={FORM_LABEL}>{t('st.portable.passphraseLabel')}</label>
              <input
                id={passId}
                type="password"
                data-portable-rekey-passphrase
                value={passphrase}
                autoComplete="new-password"
                placeholder={t('st.portable.passphrasePlaceholder')}
                aria-invalid={passIssue !== null}
                aria-describedby={passIssue !== null ? passIssueId : undefined}
                onChange={(event) => { setPassphrase(event.target.value); setPassIssue(null); }}
                className={`${INPUT} mt-1.5`}
              />
              <FieldIssue id={passIssueId} text={passIssue} />
            </div>
          )}

          <div>
            <button
              type="button"
              data-portable-rekey-submit
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => { void submitRekey(); }}
            >
              {busy ? t('common.saving') : t('st.portable.rekeySubmit')}
            </button>
          </div>
        </div>
      ) : null}

      <FeedbackLine feedback={feedback} />
    </div>
  );
}
