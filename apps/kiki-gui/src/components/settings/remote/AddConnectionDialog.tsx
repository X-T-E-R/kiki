/**
 * Adding one outbound connection: the invitation the other Kiki's owner sent,
 * a name and address, and the owner token. The token is written straight to
 * this home's connection layer through its own API and is cleared from this
 * form afterwards; it never lands in this window's storage or state.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import type { ConnectionAddInput, RemoteConnection, SshHost } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { connectionsApi, endpointIssue, fingerprint, labelIssue, readInvitationBlock } from '../../../lib/remoteConnections';
import { useNativeSshEnabled, useSshHosts } from '../../../lib/ssh';
import { MAIN_SPACE_ID, useSpaces } from '../../../lib/spaces';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SecretField } from '../SecretField';
import { connectionFailureText } from './parts';
import { AddConnectionBySshDialog } from './AddConnectionBySshDialog';

/** One form, two ways in: a URL the owner gave you, or a Kiki you reach by SSH. */
export type AddConnectionStart = { readonly kind: 'url' } | { readonly kind: 'ssh'; readonly profileId: string };

export function AddConnectionDialog({ client, sshProfiles, defaultHome, initial, onClose, onAdded }: {
  client: KikiClient;
  /** Saved SSH hosts; read from this control home when the caller has none. */
  sshProfiles?: readonly SshHost[];
  defaultHome?: string;
  initial?: AddConnectionStart;
  onClose: () => void;
  onAdded: (record: RemoteConnection) => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  // The SSH way is only offered when this home really can reach one: the same
  // flag and host list Settings › SSH hosts reads, on the same control client.
  const sshFlag = useNativeSshEnabled(client);
  const hostsQuery = useSshHosts(client, sshFlag.enabled === true);
  const savedHosts = sshProfiles ?? hostsQuery.data ?? [];
  const spaces = useSpaces(client);
  // The main space's own path is the default home on the other machine, the
  // same one the space directory shows.
  const home = defaultHome ?? spaces.data?.find((space) => space.id === MAIN_SPACE_ID)?.path ?? '';
  // Way in and chosen profile are separate state so the URL form below keeps
  // its own narrow `way` value; the SSH way returns before it renders.
  const [way, setWay] = useState<'url' | 'ssh'>(initial?.kind ?? 'url');
  // Read before the SSH way returns, so the tabs below still know which way is shown.
  const onUrlWay = way === 'url';
  const [profileId] = useState(initial?.kind === 'ssh' ? initial.profileId : '');
  const [paste, setPaste] = useState('');
  const [label, setLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [background, setBackground] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [touched, setTouched] = useState<{ label: boolean; endpoint: boolean }>({ label: false, endpoint: false });

  const parsed = useMemo(() => (paste.trim() === '' ? null : readInvitationBlock(paste)), [paste]);
  const invitation = parsed?.ok === true ? parsed : null;
  const pasteProblem = parsed !== null && parsed.ok === false ? t(parsed.problem) : null;
  const labelProblem = labelIssue(label);
  const endpointProblem = endpointIssue(endpoint);
  // The address is typed, so a TLS mistake is worth a word before saving; the
  // paste and the token have nothing to check locally.
  const blocked = invitation === null || labelProblem !== null || endpointProblem !== null || token.trim() === '' || saving;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked || invitation === null) return;
    setSaving(true);
    setFailure(null);
    const input: ConnectionAddInput = {
      label: label.trim(),
      endpoint: endpoint.trim(),
      target: invitation.target,
      ownerToken: token.trim(),
      invitation: invitation.invitation,
      backgroundSummary: background,
    };
    try {
      const record = await connectionsApi(client).add(input);
      // The token has left this form for the home's own store; nothing here keeps it.
      setToken('');
      onAdded(record);
    } catch (error) {
      const reason = connectionFailureText(error instanceof Error ? error.message : '');
      setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
    } finally {
      setSaving(false);
    }
  };

  if (way === 'ssh') {
    return (
      <AddConnectionBySshDialog client={client} profiles={savedHosts} defaultHome={home}
        initialProfileId={profileId === '' ? undefined : profileId}
        onClose={onClose} onAdded={onAdded} />
    );
  }

  return (
    <Dialog onClose={onClose} overlayId="remote-connection-add" ariaLabel={t('st.remote.addTitle')}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <form className="space-y-5" onSubmit={(event) => { void submit(event); }} data-remote-add-form>
        <div>
          <h2 className="text-[14px] font-medium text-ink">{t('st.remote.addTitle')}</h2>
          <p className="mt-1 max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">
            {t('st.remote.addBody')}
          </p>
        </div>

        {sshFlag.enabled === true ? (
          <div role="tablist" aria-label={t('st.remote.addTitle')} data-remote-add-ways className="flex gap-1.5">
            <button type="button" role="tab" data-remote-add-way="url" aria-selected={onUrlWay}
              onClick={() => { setWay('url'); }}
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${onUrlWay ? 'bg-selected text-selected-ink' : ''}`}>
              <Icon name="web" size={12} />{t('st.remote.way.url')}
            </button>
            <button type="button" role="tab" data-remote-add-way="ssh" aria-selected={!onUrlWay}
              onClick={() => { setWay('ssh'); }}
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${!onUrlWay ? 'bg-selected text-selected-ink' : ''}`}>
              <Icon name="terminal" size={12} />{t('st.remote.way.ssh')}
            </button>
          </div>
        ) : null}
        {/* The SSH way exists whenever this home can reach one; with no saved
            host it says so and points at the page that adds them, rather than
            a tab that leads nowhere. */}
        {sshFlag.enabled === true && savedHosts.length === 0 ? (
          <p data-remote-ssh-no-hosts className="text-[12px] leading-snug text-ink-soft">
            {t('st.remote.way.sshNoHosts')}{' '}
            <button type="button" data-remote-ssh-open-hosts onClick={() => { void navigate('/settings/ssh'); }}
              className="font-medium text-accent-ink underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
              {t('st.remote.way.sshOpenHosts')}
            </button>
          </p>
        ) : null}

        <SettingField label={t('st.remote.invitation')} htmlFor="remote-connection-invitation" layout="stack"
          help={invitation === null ? t('st.remote.invitationHint') : undefined}>
          <textarea id="remote-connection-invitation" data-remote-invitation rows={3} spellCheck={false}
            className="w-full resize-y rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            placeholder={t('st.remote.invitationPlaceholder')}
            value={paste}
            onChange={(event) => { setPaste(event.target.value); }} />
          {pasteProblem !== null ? (
            <p className="text-[12px] text-danger" role="alert" data-remote-invitation-problem>{pasteProblem}</p>
          ) : null}
          {invitation !== null ? (
            <p className="text-[12px] text-ink-soft" data-remote-target>
              {t('st.remote.targetLine', {
                home: fingerprint(invitation.target.homeId),
                host: fingerprint(invitation.target.hostId),
              })}
              {invitation.label !== undefined ? ` · ${t('st.remote.invitationNamed', { name: invitation.label })}` : ''}
            </p>
          ) : null}
        </SettingField>

        <SettingField label={t('st.remote.labelField')} htmlFor="remote-connection-label" layout="stack">
          <input id="remote-connection-label" data-remote-label className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={label} maxLength={128} spellCheck={false}
            onChange={(event) => { setLabel(event.target.value); }}
            onBlur={() => { setTouched((state) => ({ ...state, label: true })); }} />
          {touched.label && labelProblem !== null ? <p className="text-[12px] text-danger" role="alert">{t(labelProblem)}</p> : null}
        </SettingField>

        <SettingField label={t('st.remote.endpointField')} htmlFor="remote-connection-endpoint" layout="stack"
          help={t('st.remote.endpointHint')}>
          <input id="remote-connection-endpoint" data-remote-endpoint className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={endpoint} spellCheck={false} placeholder="https://"
            onChange={(event) => { setEndpoint(event.target.value); }}
            onBlur={() => { setTouched((state) => ({ ...state, endpoint: true })); }} />
          {touched.endpoint && endpointProblem !== null ? <p className="text-[12px] text-danger" role="alert">{t(endpointProblem)}</p> : null}
        </SettingField>

        <div data-remote-token>
          <SecretField id="remote-connection-token" label={t('st.remote.tokenField')} source="none"
            sourceText={t('st.remote.tokenHint')} clearable={false}
            draft={{ mode: 'set', value: token }} onChange={(draft) => { setToken(draft.mode === 'set' ? draft.value : ''); }} />
          <p className="mt-1 text-[12px] text-ink-faint">{t('st.remote.tokenStored')}</p>
        </div>

        <SettingField label={t('st.remote.background')} help={t('st.remote.backgroundHint')}>
          <Toggle id="remote-connection-background" label={t('st.remote.background')} layout="bare"
            checked={background} onChange={setBackground} />
        </SettingField>

        <FeedbackLine feedback={failure} />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" data-remote-add-submit className={PRIMARY_BUTTON} disabled={blocked}>
            {saving ? t('st.remote.adding') : t('st.remote.add')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
