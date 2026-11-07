/**
 * Adding one remote Kiki over an existing SSH profile. One action attaches
 * when that Kiki is already running and starts it when it is not.
 */

import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import type { RemoteConnection } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { connectionsApi, remoteProfileFor, sshRemoteHomeLabel } from '../../../lib/remoteConnections';
import type { SshHost } from '../../../lib/ssh';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { SidePanel } from '../../SidePanel';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { connectionFailureText } from './parts';

export function AddConnectionBySshDialog({ client, profiles, defaultHome, initialProfileId, onClose, onAdded }: {
  client: KikiClient;
  /** Profiles the person already saved under SSH hosts. */
  profiles: readonly SshHost[];
  /** This home's own path, used when a profile does not name a remote home. */
  defaultHome: string;
  /** Pre-selected from the profile row this was opened from. */
  initialProfileId?: string;
  onClose: () => void;
  onAdded: (record: RemoteConnection) => void;
}) {
  const { t, locale } = useI18n();
  const [profileId, setProfileId] = useState(initialProfileId ?? profiles[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [background, setBackground] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const host = profiles.find((entry) => entry.id === profileId);
  const profile = useMemo(
    () => (host === undefined ? undefined : remoteProfileFor(host, defaultHome)),
    [host, defaultHome],
  );

  useEffect(() => {
    if (label === '' && host !== undefined) setLabel(host.name);
  }, [host, label]);

  const canSubmit = profile !== undefined && label.trim() !== '' && !busy;

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!canSubmit || profile === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      const record = await connectionsApi(client).sshConnect({ profile, label: label.trim(), backgroundSummary: background });
      onAdded(record);
    } catch (error) {
      const reason = connectionFailureText(error instanceof Error ? error.message : '');
      setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
    } finally {
      setBusy(false);
    }
  };

  const formId = 'remote-connection-ssh-form';
  return (
    <SidePanel onClose={onClose} overlayId="remote-connection-ssh" title={t('st.ssh.remote.addTitle')}
      description={t('st.ssh.remote.addBody')} width="lg"
      footer={<>
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" form={formId} data-remote-ssh-submit className={PRIMARY_BUTTON} disabled={!canSubmit}
          onClick={(event) => { event.preventDefault(); void submit(); }}>
          {busy ? t('st.ssh.remote.working') : t('st.ssh.remote.connect')}
        </button>
      </>}>
      <form id={formId} className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-remote-ssh-form>
        <SettingField label={t('st.ssh.remote.profileField')} htmlFor="remote-ssh-profile" layout="stack"
          help={t('st.ssh.remote.profileHint')}>
          <select id="remote-ssh-profile" data-remote-ssh-profile
            className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={profileId} onChange={(event) => { setProfileId(event.target.value); }}>
            {profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </SettingField>

        {profile !== undefined ? (
          <p className="font-mono text-[11px] text-ink-faint" data-remote-ssh-home>{sshRemoteHomeLabel(profile)}</p>
        ) : null}
        <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft" data-remote-ssh-note>{t('st.ssh.remote.connectHint')}</p>

        <SettingField label={t('st.remote.labelField')} htmlFor="remote-ssh-label" layout="stack">
          <input id="remote-ssh-label" data-remote-ssh-label className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={label} maxLength={128} spellCheck={false} onChange={(event) => { setLabel(event.target.value); }} />
        </SettingField>

        <SettingField label={t('st.remote.background')} help={t('st.remote.backgroundHint')}>
          <Toggle id="remote-ssh-background" label={t('st.remote.background')} layout="bare"
            checked={background} onChange={setBackground} />
        </SettingField>

        <FeedbackLine feedback={failure} />
      </form>
    </SidePanel>
  );
}
