/**
 * Adding one remote Kiki over an existing SSH profile, as the second path of
 * the same connection form the URL path uses.
 *
 * The flow is the source home's own typed plan → execute → register, and the
 * plan is shown as it came back: which home answered, and the real effects of
 * the one action being offered. A plan that needs a server says so and keeps
 * the target's lifetime in the person's words; a plan that is already running
 * attaches and starts nothing. Registering stores a reference like any other
 * connection, and this form's work is done the moment the record exists — the
 * space switcher takes it from there.
 */

import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import type { RemoteConnection, SshRemotePlan } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { connectionsApi, fingerprint, remoteProfileFor, sshRemoteHomeLabel } from '../../../lib/remoteConnections';
import type { SshHost } from '../../../lib/ssh';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { connectionFailureText } from './parts';

/** How the plan asked for it, as the person reads it before acting. */
export function planStateKey(state: SshRemotePlan['state']): 'st.ssh.remote.state.attach' | 'st.ssh.remote.state.ensure' | 'st.ssh.remote.state.ready' {
  return state === 'attach' ? 'st.ssh.remote.state.attach' : state === 'ready' ? 'st.ssh.remote.state.ready' : 'st.ssh.remote.state.ensure';
}

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
  const [enableInbound, setEnableInbound] = useState(true);
  const [background, setBackground] = useState(false);
  const [plan, setPlan] = useState<SshRemotePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const host = profiles.find((entry) => entry.id === profileId);
  // Memoized: the plan is read for this profile, so a fresh object every render
  // would re-plan forever.
  const profile = useMemo(
    () => (host === undefined ? undefined : remoteProfileFor(host, defaultHome)),
    [host, defaultHome],
  );

  useEffect(() => {
    if (label === '' && host !== undefined) setLabel(host.name);
  }, [host, label]);

  // The plan is read on the chosen profile and whenever it changes: what the
  // button will do must come from the source home, not from a guess here.
  useEffect(() => {
    if (profile === undefined) { setPlan(null); return; }
    const controller = new AbortController();
    setPlanning(true);
    setFailure(null);
    void connectionsApi(client).sshPlan(profile, { signal: controller.signal }).then(
      (next) => { setPlan(next); },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const reason = connectionFailureText(error instanceof Error ? error.message : '');
        setPlan(null);
        setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
      },
    ).finally(() => { setPlanning(false); });
    return () => controller.abort();
  }, [client, profile, locale, t]);

  const target = plan?.target;
  const needsEnsure = plan?.state === 'ensure_required';
  const canSubmit = profile !== undefined && plan !== null && label.trim() !== '' && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || profile === undefined || plan === null) return;
    setBusy(true);
    setFailure(null);
    try {
      // A plan that is already running is attached; only the plan that said it
      // needs a server may start one, and that is this one action.
      const ready = plan.state === 'attach' ? plan : await connectionsApi(client).sshExecute(plan.id, { ensure: needsEnsure });
      const record = await connectionsApi(client).sshRegister({
        purpose: 'gui', planId: ready.id, label: label.trim(), enableInbound, backgroundSummary: background,
      });
      onAdded(record);
    } catch (error) {
      const reason = connectionFailureText(error instanceof Error ? error.message : '');
      setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} overlayId="remote-connection-ssh" ariaLabel={t('st.ssh.remote.addTitle')}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <form className="space-y-5" onSubmit={(event) => { void submit(event); }} data-remote-ssh-form>
        <div>
          <h2 className="text-[14px] font-medium text-ink">{t('st.ssh.remote.addTitle')}</h2>
          <p className="mt-1 max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.ssh.remote.addBody')}</p>
        </div>

        <SettingField label={t('st.ssh.remote.profileField')} htmlFor="remote-ssh-profile" layout="stack"
          help={t('st.ssh.remote.profileHint')}>
          <select id="remote-ssh-profile" data-remote-ssh-profile
            className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={profileId} onChange={(event) => { setProfileId(event.target.value); }}>
            {profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </SettingField>

        {/* The plan is this form's subject, so it reads as one block: what the
            button will do, on which machine, and for how long. */}
        <div data-remote-ssh-plan className="rounded-lg border border-hairline bg-ink/[0.03] px-3 py-2.5">
          <p className="text-[12px] font-medium text-ink">{t('st.ssh.remote.planTitle')}</p>
          {planning ? <p className="mt-1 text-[12px] text-ink-faint">{t('st.ssh.remote.planning')}</p> : null}
          {!planning && plan !== null ? (
            <div className="mt-1.5 space-y-1.5">
              <p className="text-[12px] text-ink-soft" data-remote-ssh-state>
                {t(planStateKey(plan.state))}
              </p>
              {profile !== undefined ? (
                <p className="font-mono text-[11px] text-ink-faint" data-remote-ssh-home>{sshRemoteHomeLabel(profile)}</p>
              ) : null}
              <p className="font-mono text-[11px] text-ink-faint" data-remote-ssh-target>
                {target === undefined
                  ? t('st.ssh.remote.targetPending')
                  : t('st.remote.targetLine', { home: fingerprint(target.homeId), host: fingerprint(target.hostId) })}
              </p>
              <p className="text-[12px] leading-snug text-ink-soft" data-remote-ssh-effects>
                {t(plan.effects.startsServer ? 'st.ssh.remote.effects.start' : 'st.ssh.remote.effects.attach')}
                {' '}
                {t(plan.effects.serverLifetime === 'existing' ? 'st.ssh.remote.lifetime.existing' : 'st.ssh.remote.lifetime.untilStop')}
              </p>
              <p className="text-[12px] leading-snug text-ink-faint" data-remote-ssh-gate>
                {t('st.ssh.remote.gateNote')}
              </p>
            </div>
          ) : null}
        </div>

        <SettingField label={t('st.remote.labelField')} htmlFor="remote-ssh-label" layout="stack">
          <input id="remote-ssh-label" data-remote-ssh-label className="w-full rounded-md bg-ink/[0.04] px-2.5 py-2 text-[13px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
            value={label} maxLength={128} spellCheck={false} onChange={(event) => { setLabel(event.target.value); }} />
        </SettingField>

        <SettingField label={t('st.ssh.remote.enableInbound')} help={t('st.ssh.remote.enableInboundHint')}>
          <Toggle id="remote-ssh-inbound" label={t('st.ssh.remote.enableInbound')} layout="bare"
            checked={enableInbound} onChange={setEnableInbound} disabled={!needsEnsure} />
        </SettingField>

        <SettingField label={t('st.remote.background')} help={t('st.remote.backgroundHint')}>
          <Toggle id="remote-ssh-background" label={t('st.remote.background')} layout="bare"
            checked={background} onChange={setBackground} />
        </SettingField>

        <FeedbackLine feedback={failure} />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" data-remote-ssh-submit className={PRIMARY_BUTTON} disabled={!canSubmit}>
            {busy ? t('st.ssh.remote.working') : t(needsEnsure ? 'st.ssh.remote.start' : 'st.ssh.remote.attachAction')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
