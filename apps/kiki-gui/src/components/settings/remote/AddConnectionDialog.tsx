/**
 * Adding one outbound connection from an address and a pairing code. The code
 * is single-use; the credential it returns stays in this home's connection
 * layer and never lands in this window's storage.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import type { RemoteConnection, SshHost } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { completeConnectionEndpoint, connectionsApi, endpointIssue, formatPairingCode, labelIssue, pairingCodeIssue, parsePairingUri } from '../../../lib/remoteConnections';
import { useNativeSshEnabled, useSshHosts } from '../../../lib/ssh';
import { MAIN_SPACE_ID, useSpaces } from '../../../lib/spaces';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { SidePanel } from '../../SidePanel';
import { Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SetupSteps } from '../SetupSteps';
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
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [background, setBackground] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [touched, setTouched] = useState<{ label: boolean; endpoint: boolean; code: boolean }>({ label: false, endpoint: false, code: false });

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
        ...label.trim() === '' ? {} : { label: label.trim() },
        backgroundSummary: background,
      });
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

  const formId = 'remote-connection-add-form';
  return (
    <SidePanel onClose={onClose} overlayId="remote-connection-add" title={t('st.remote.addTitle')}
      description={t('st.remote.addBody')} width="lg"
      footer={<>
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" form={formId} data-remote-add-submit className={PRIMARY_BUTTON} disabled={blocked}
          onClick={(event) => { event.preventDefault(); void submit(); }}>
          {saving ? t('st.remote.adding') : t('st.remote.add')}
        </button>
      </>}>
      <form id={formId} className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-remote-add-form>

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

        {/* Rule 16: what to fetch from the other Kiki before filling this in. */}
        <SetupSteps data={{ 'data-remote-add-steps': '' }}
          steps={[t('st.remote.guide.step1'), t('st.remote.guide.step2'), t('st.remote.guide.step3')]} />

        <SettingField label={t('st.remote.endpointField')} htmlFor="remote-connection-endpoint" layout="stack"
          help={t('st.remote.endpointHint')}>
          <input id="remote-connection-endpoint" data-remote-endpoint className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={endpoint} spellCheck={false} placeholder="http://192.168.1.20:58627"
            onChange={(event) => {
              const parsed = parsePairingUri(event.target.value);
              if (parsed !== undefined) {
                setEndpoint(completeConnectionEndpoint(parsed.endpoint));
                setCode(parsed.code);
                return;
              }
              setEndpoint(event.target.value);
            }}
            onBlur={() => { setEndpoint((value) => completeConnectionEndpoint(value)); setTouched((state) => ({ ...state, endpoint: true })); }} />
          {touched.endpoint && endpointProblem !== null ? <p className="text-[12px] text-danger" role="alert" data-remote-endpoint-problem>{t(endpointProblem)}</p> : null}
        </SettingField>

        <SettingField label={t('st.remote.codeField')} htmlFor="remote-connection-code" layout="stack"
          help={t('st.remote.codeHint')}>
          <input id="remote-connection-code" data-remote-code className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[18px] tracking-[0.14em] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={code} spellCheck={false} autoCapitalize="characters" autoCorrect="off" placeholder="XXXX-XXXX"
            onChange={(event) => {
              const parsed = parsePairingUri(event.target.value);
              if (parsed !== undefined) {
                setEndpoint(completeConnectionEndpoint(parsed.endpoint));
                setCode(parsed.code);
                return;
              }
              setCode(formatPairingCode(event.target.value));
            }}
            onBlur={() => { setTouched((state) => ({ ...state, code: true })); }} />
          {touched.code && codeProblem !== null ? <p className="text-[12px] text-danger" role="alert" data-remote-code-problem>{t(codeProblem)}</p> : null}
        </SettingField>

        <SettingField label={t('st.remote.labelField')} htmlFor="remote-connection-label" layout="stack"
          help={t('st.remote.labelOptional')}>
          <input id="remote-connection-label" data-remote-label className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={label} maxLength={128} spellCheck={false}
            onChange={(event) => { setLabel(event.target.value); }}
            onBlur={() => { setTouched((state) => ({ ...state, label: true })); }} />
          {touched.label && labelProblem !== null ? <p className="text-[12px] text-danger" role="alert">{t(labelProblem)}</p> : null}
        </SettingField>

        <SettingField label={t('st.remote.background')} help={t('st.remote.backgroundHint')}>
          <Toggle id="remote-connection-background" label={t('st.remote.background')} layout="bare"
            checked={background} onChange={setBackground} />
        </SettingField>

        <FeedbackLine feedback={failure} />
      </form>
    </SidePanel>
  );
}
