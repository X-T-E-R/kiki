/**
 * Issuing one invitation. The person pastes the other Kiki's own identity, so
 * the allow-list line carries the real home/host rather than a typed name, and
 * the invitation itself is shown once — the server keeps only its digest, so
 * there is nothing to show again later.
 */

import { useMemo, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import type { ConnectionGrant } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { connectionsApi, fingerprint, invitationBlock, labelIssue, readIdentityBlock } from '../../../lib/remoteConnections';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { CopyField } from './parts';
import { FeedbackLine, type Feedback } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SettingsSelect } from '../SettingsPrimitives';
import { connectionFailureText } from './parts';

const EXPIRY_CHOICES = [
  { value: '600000', labelKey: 'st.inbound.expiry.tenMinutes' },
  { value: '1800000', labelKey: 'st.inbound.expiry.thirtyMinutes' },
  { value: '3600000', labelKey: 'st.inbound.expiry.oneHour' },
] as const;

export function InviteSourceDialog({ client, onClose, onInvited }: {
  client: KikiClient;
  onClose: () => void;
  onInvited: () => void;
}) {
  const { t, locale } = useI18n();
  const [paste, setPaste] = useState('');
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<string>('600000');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [issued, setIssued] = useState<{ grant: ConnectionGrant; invitation: string } | null>(null);

  const parsed = useMemo(() => (paste.trim() === '' ? null : readIdentityBlock(paste)), [paste]);
  const source = parsed?.ok === true ? parsed.identity : null;
  const pasteProblem = parsed !== null && parsed.ok === false ? t(parsed.problem) : null;
  const nameProblem = labelIssue(name);
  const blocked = source === null || nameProblem !== null || saving;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked || source === null) return;
    setSaving(true);
    setFailure(null);
    try {
      const result = await connectionsApi(client).invite({ source, label: name.trim(), expiresInMs: Number(expiry) });
      setIssued(result);
      onInvited();
    } catch (error) {
      const reason = connectionFailureText(error instanceof Error ? error.message : '');
      setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onClose={onClose} overlayId="remote-inbound-invite" ariaLabel={t('st.inbound.inviteTitle')}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      {issued === null ? (
        <form className="space-y-5" onSubmit={(event) => { void submit(event); }} data-inbound-invite-form>
          <div>
            <h2 className="text-[14px] font-medium text-ink">{t('st.inbound.inviteTitle')}</h2>
            <p className="mt-1 max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.inbound.inviteBody')}</p>
          </div>
          <SettingField label={t('st.inbound.sourceField')} htmlFor="inbound-source-identity" layout="stack"
            help={t('st.inbound.sourceHint')}>
            <textarea id="inbound-source-identity" data-inbound-source rows={3} spellCheck={false}
              className="w-full resize-y rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
              placeholder={t('st.inbound.sourcePlaceholder')}
              value={paste} onChange={(event) => { setPaste(event.target.value); }} />
            {pasteProblem !== null ? <p className="text-[12px] text-danger" role="alert" data-inbound-source-problem>{pasteProblem}</p> : null}
            {source !== null ? (
              <p className="text-[12px] text-ink-soft" data-inbound-source-target>
                {t('st.remote.targetLine', { home: fingerprint(source.homeId), host: fingerprint(source.hostId) })}
              </p>
            ) : null}
          </SettingField>
          <SettingField label={t('st.inbound.nameField')} htmlFor="inbound-source-name" layout="stack">
            <input id="inbound-source-name" data-inbound-name className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
              value={name} maxLength={128} spellCheck={false}
              onChange={(event) => { setName(event.target.value); }} />
            {nameProblem !== null && name !== '' ? <p className="text-[12px] text-danger" role="alert">{t(nameProblem)}</p> : null}
          </SettingField>
          <SettingField label={t('st.inbound.expiry')} htmlFor="inbound-source-expiry" help={t('st.inbound.expiryHint')}>
            <SettingsSelect id="inbound-source-expiry" value={expiry} onChange={setExpiry} ariaLabel={t('st.inbound.expiry')}
              choices={EXPIRY_CHOICES.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }))} />
          </SettingField>
          <FeedbackLine feedback={failure} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" data-inbound-invite-submit className={PRIMARY_BUTTON} disabled={blocked}>
              {saving ? t('st.inbound.inviting') : t('st.inbound.invite')}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-5" data-inbound-invitation>
          <div>
            <h2 className="text-[14px] font-medium text-ink">{t('st.inbound.invitationTitle', { name: name.trim() })}</h2>
            <p data-inbound-invite-body className="mt-1 max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.inbound.invitationBody', { name: name.trim() })}</p>
          </div>
          <CopyField id="inbound-invitation-value" dataAttr="inbound-invitation"
            label={t('st.inbound.invitationLabel')}
            value={invitationBlock({ invitation: issued.invitation, target: issued.grant.target, label: name.trim() })}
            copyLabel={t('st.inbound.invitationCopy')} copiedLabel={t('st.inbound.invitationCopied')}
            hint={t('st.inbound.invitationOnce')} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" data-inbound-invite-done className={PRIMARY_BUTTON} onClick={onClose}>{t('st.inbound.invitationDone')}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
