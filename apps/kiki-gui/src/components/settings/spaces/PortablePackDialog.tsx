import { useId, useState } from 'react';

import type { PortableSpaceEncryption, PortableSpaceExportReceipt, PortableSpaceSourceRecord } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { portableSpacesApi, suggestPackUnpackDestination } from '../../../lib/portableSpaces';
import { FeedbackLine, type Feedback } from '../../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSegmented } from '../SettingsPrimitives';

type PackEncMode = 'x25519' | 'passphrase';

export interface PortablePackDialogProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly source: PortableSpaceSourceRecord;
  readonly action: 'pack' | 'unpack';
  readonly deviceRecipient?: string;
  readonly onClose: () => void;
  readonly onDone: (receipt: PortableSpaceExportReceipt) => void;
}

export function PortablePackDialog({
  client,
  token,
  source,
  action,
  deviceRecipient,
  onClose,
  onDone,
}: PortablePackDialogProps) {
  const host = useHost();
  const { t, locale } = useI18n();
  const destId = useId();
  const destIssueId = useId();
  const passId = useId();
  const passIssueId = useId();

  const sourcePath = source.endpoint.kind === 'dir' || source.endpoint.kind === 'archive' ? source.endpoint.path : '';
  const [destination, setDestination] = useState(() => suggestPackUnpackDestination(sourcePath, action));
  const [encMode, setEncMode] = useState<PackEncMode>('x25519');
  const [passphrase, setPassphrase] = useState('');
  const [destIssue, setDestIssue] = useState<string | null>(null);
  const [passIssue, setPassIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const needsPassphrase =
    (action === 'pack' && encMode === 'passphrase') ||
    (action === 'unpack' && (source.format === 'age' || source.encryptionMode === 'passphrase' || source.secretMode === 'sealed'));

  const submit = async () => {
    if (busy) return;
    const trimmedDest = destination.trim();
    const nextDestIssue = trimmedDest === '' ? t('st.portable.exportDestRequired') : null;
    const nextPassIssue = action === 'pack' && encMode === 'passphrase' && passphrase.trim() === ''
      ? t('st.portable.passphraseRequired')
      : null;
    setDestIssue(nextDestIssue);
    setPassIssue(nextPassIssue);
    if (nextDestIssue !== null || nextPassIssue !== null) return;

    setBusy(true);
    setFeedback(null);
    try {
      const api = portableSpacesApi(client, { token });
      const encryption: PortableSpaceEncryption | undefined = action === 'pack'
        ? encMode === 'passphrase'
          ? { mode: 'passphrase', passphrase: passphrase.trim() }
          : { mode: 'x25519', recipients: deviceRecipient !== undefined ? [deviceRecipient] : undefined }
        : undefined;
      const body = {
        action,
        sourcePath,
        destinationPath: trimmedDest,
        format: action === 'pack' ? ('age' as const) : undefined,
        encryption,
        unlock: action === 'unpack' && passphrase.trim() !== '' ? { passphrase: passphrase.trim() } : undefined,
      };
      const receipt = action === 'pack' ? await api.pack(body) : await api.unpack(body);
      onDone(receipt);
    } catch (error) {
      setBusy(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const title = t(action === 'pack' ? 'st.portable.packTitle' : 'st.portable.unpackTitle');

  return (
    <Dialog
      onClose={() => { if (!busy) onClose(); }}
      ariaLabel={title}
      overlayId="portable-pack-dialog"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md}`}
    >
      <form
        data-portable-pack-dialog={action}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <h2 className="font-display text-[17px] font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-faint" title={sourcePath}>{sourcePath}</p>
        </div>

        <div>
          <label htmlFor={destId} className={FORM_LABEL}>{t('st.portable.exportDest')}</label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={destId}
              data-autofocus
              data-portable-pack-dest
              value={destination}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={destIssue !== null}
              aria-describedby={destIssue !== null ? destIssueId : undefined}
              onChange={(event) => { setDestination(event.target.value); setDestIssue(null); }}
              className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`}
            />
            {action === 'unpack' && host.pickDirectory !== undefined ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => {
                  void host.pickDirectory?.().then((picked) => {
                    if (picked !== null) {
                      setDestination(picked);
                      setDestIssue(null);
                      setFeedback(null);
                    }
                  }).catch((error: unknown) => {
                    setFeedback({ tone: 'error', text: errorText(locale, error) });
                  });
                }}
              >
                {t('st.spaces.browse')}
              </button>
            ) : null}
          </div>
          <FieldIssue id={destIssueId} text={destIssue} />
        </div>

        {action === 'pack' ? (
          <div>
            <span id={`${destId}-enc`} className={FORM_LABEL}>{t('st.portable.secretLabel')}</span>
            <div className="mt-1.5">
              <SettingsSegmented<PackEncMode>
                ariaLabelledBy={`${destId}-enc`}
                dataAttr="data-portable-pack-enc"
                value={encMode}
                onChange={(next) => { setEncMode(next); setPassIssue(null); }}
                choices={[
                  { value: 'x25519', label: t('st.portable.enc.x25519') },
                  { value: 'passphrase', label: t('st.portable.enc.passphrase') },
                ]}
              />
            </div>
          </div>
        ) : null}

        {needsPassphrase ? (
          <div>
            <label htmlFor={passId} className={FORM_LABEL}>
              {t(action === 'unpack' && source.encryptionMode !== 'passphrase' ? 'st.portable.passphraseOptionalLabel' : 'st.portable.passphraseLabel')}
            </label>
            <input
              id={passId}
              type="password"
              data-portable-pack-passphrase
              value={passphrase}
              placeholder={t('st.portable.passphrasePlaceholder')}
              autoComplete="off"
              aria-invalid={passIssue !== null}
              aria-describedby={passIssue !== null ? passIssueId : undefined}
              onChange={(event) => { setPassphrase(event.target.value); setPassIssue(null); }}
              className={`${INPUT} mt-1.5`}
            />
            <FieldIssue id={passIssueId} text={passIssue} />
          </div>
        ) : null}

        <FeedbackLine feedback={feedback} />

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" data-portable-pack-submit className={PRIMARY_BUTTON} disabled={busy}>
            {busy ? t('common.saving') : t(action === 'pack' ? 'st.portable.packAction' : 'st.portable.unpackAction')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
