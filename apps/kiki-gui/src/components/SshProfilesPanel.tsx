import { useEffect, useState, type FormEvent } from 'react';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import type { SshProfile } from '../state/connectionConfig';

export function SshProfilesPanel({
  onConnect,
  selectedProfile,
}: {
  onConnect: (id: string, token: string) => Promise<void>;
  selectedProfile?: SshProfile;
}) {
  const { t } = useI18n();
  const host = useHost();
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [label, setLabel] = useState('');
  const [alias, setAlias] = useState('');
  const [identityFile, setIdentityFile] = useState('');
  const [remotePort, setRemotePort] = useState('58627');
  const [expectedHomeId, setExpectedHomeId] = useState('');
  const [releaseChannel, setReleaseChannel] = useState<'stable' | 'beta'>('stable');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [token, setToken] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listFailed, setListFailed] = useState(false);

  useEffect(() => {
    if (!host.connection.listSshProfiles) return;
    let active = true;
    void host.connection.listSshProfiles().then(
      (items) => { if (active) setProfiles(items); },
      (cause: unknown) => {
        if (active) {
          setListFailed(true);
          setError(String(cause));
        }
      },
    );
    return () => { active = false; };
  }, [host]);

  const retryList = () => {
    setBusy('list');
    setError(null);
    void host.connection.listSshProfiles!().then(
      (items) => {
        setProfiles(items);
        setListFailed(false);
      },
      (cause: unknown) => setError(String(cause)),
    ).finally(() => setBusy(null));
  };

  if (!host.connection.listSshProfiles || !host.connection.saveSshProfile ||
      !host.connection.removeSshProfile) return null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const port = Number(remotePort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        !/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(expectedHomeId.trim())) {
      setError(t('connect.sshNeedSetup'));
      return;
    }
    const previous = profiles.find((entry) => entry.id === editingId);
    const profile: SshProfile = {
      id: previous?.id ?? crypto.randomUUID(),
      label: label.trim(),
      target: previous?.target.kind === 'host'
        ? { ...previous.target, hostname: alias.trim() }
        : { kind: 'alias', alias: alias.trim() },
      identityFile: identityFile.trim() || null,
      releaseChannel,
      remotePort: port,
      serverHomeId: expectedHomeId.trim().toLowerCase(),
    };
    setBusy('save');
    setError(null);
    void host.connection.saveSshProfile!(profile).then(
      (items) => {
        setProfiles(items);
        setLabel('');
        setAlias('');
        setIdentityFile('');
        setRemotePort('58627');
        setExpectedHomeId('');
        setReleaseChannel('stable');
        setEditingId(null);
      },
      (cause: unknown) => setError(String(cause)),
    ).finally(() => setBusy(null));
  };

  const connect = (id: string) => {
    const profile = profiles.find((item) => item.id === id) ?? (selectedProfile?.id === id ? selectedProfile : undefined);
    if (!profile?.remotePort || !profile.serverHomeId || token?.id !== id ||
        !/^[A-Za-z0-9_-]{43}$/.test(token.value)) {
      setError(t('connect.sshNeedSetup'));
      return;
    }
    setBusy(id);
    setError(null);
    void onConnect(id, token.value).then(() => setToken(null), (cause: unknown) => setError(String(cause)))
      .finally(() => setBusy(null));
  };

  const remove = (id: string) => {
    setBusy(id);
    setError(null);
    void host.connection.removeSshProfile!(id).then(
      (items) => setProfiles(items),
      (cause: unknown) => setError(String(cause)),
    ).finally(() => setBusy(null));
  };

  return (
    <section className="mt-5 border-t border-hairline pt-4" aria-label={t('connect.sshTitle')}>
      <h2 className="text-[13px] font-semibold text-ink">{t('connect.sshTitle')}</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">{t('connect.sshHint')}</p>
      {listFailed ? <button type="button" disabled={busy !== null} onClick={retryList}
        className="mt-2 rounded-md border border-hairline-strong px-2 py-1 text-[11px] text-ink disabled:opacity-50">
        {t('common.retry')}
      </button> : null}
      {(selectedProfile && !profiles.some((entry) => entry.id === selectedProfile.id)
        ? [selectedProfile, ...profiles] : profiles).map((profile) => (
        <div key={profile.id} className="mt-2 rounded-lg border border-hairline px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-ink">{profile.label}</p>
              <p className="truncate font-mono text-[10px] text-ink-soft">
                {profile.target.kind === 'alias' ? profile.target.alias : profile.target.hostname}
                {profile.remotePort ? ` · 127.0.0.1:${profile.remotePort}` : ''}
                {' · '}{t(profile.releaseChannel === 'beta' ? 'st.about.beta' : 'st.about.stable')}
              </p>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => {
              setEditingId(profile.id);
              setLabel(profile.label);
              setAlias(profile.target.kind === 'alias' ? profile.target.alias : profile.target.hostname);
              setIdentityFile(profile.identityFile ?? '');
              setRemotePort(String(profile.remotePort ?? 58627));
              setExpectedHomeId(profile.serverHomeId ?? '');
              setReleaseChannel(profile.releaseChannel);
              setError(null);
            }} className="rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-soft disabled:opacity-50">
              {t('goal.edit')}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => remove(profile.id)}
              className="rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-soft disabled:opacity-50">
              {t('connect.sshRemove')}
            </button>
          </div>
          <label className="mt-2 block text-[11px] text-ink-soft">{t('connect.sshToken')}
            <input type="password" value={token?.id === profile.id ? token.value : ''}
              onChange={(event) => setToken({ id: profile.id, value: event.target.value })}
              autoComplete="off" spellCheck={false} maxLength={43}
              className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink" />
          </label>
          <button type="button" disabled={busy !== null} onClick={() => connect(profile.id)}
            className="mt-2 rounded-md border border-hairline-strong px-2 py-1 text-[11px] text-ink disabled:opacity-50">
            {t('connect.sshConnect')}
          </button>
        </div>
      ))}
      <form onSubmit={save} className="mt-3 grid gap-2">
        <label className="text-[11px] text-ink-soft">{t('connect.sshLabel')}
          <input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={100}
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink" />
        </label>
        <label className="text-[11px] text-ink-soft">{t('connect.sshAlias')}
          <input value={alias} onChange={(event) => setAlias(event.target.value)} required maxLength={255}
            autoComplete="off" spellCheck={false} placeholder="dev-linux"
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink" />
          <span className="mt-1 block leading-relaxed">{t('connect.sshAliasHint')}</span>
        </label>
        <label className="text-[11px] text-ink-soft">{t('connect.sshIdentity')}
          <input value={identityFile} onChange={(event) => setIdentityFile(event.target.value)}
            autoComplete="off" spellCheck={false} placeholder="~/.ssh/id_ed25519"
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink" />
        </label>
        <label className="text-[11px] text-ink-soft">{t('connect.sshPort')}
          <input type="number" min={1} max={65535} required value={remotePort}
            onChange={(event) => setRemotePort(event.target.value)}
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink" />
        </label>
        <label className="text-[11px] text-ink-soft">{t('connect.sshHomeId')}
          <input value={expectedHomeId} onChange={(event) => setExpectedHomeId(event.target.value)} required
            maxLength={36} autoComplete="off" spellCheck={false} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink" />
        </label>
        <label className="text-[11px] text-ink-soft">{t('st.about.channel')}
          <select value={releaseChannel} onChange={(event) => setReleaseChannel(event.target.value as 'stable' | 'beta')}
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink">
            <option value="stable">{t('st.about.stable')}</option>
            <option value="beta">{t('st.about.beta')}</option>
          </select>
          <span className="mt-1 block leading-relaxed">{t('connect.sshChannelHint')}</span>
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={busy !== null}
            className="rounded-md border border-hairline-strong px-2 py-1.5 text-[12px] text-ink disabled:opacity-50">
            {t('connect.sshAdd')}
          </button>
          {editingId !== null ? <button type="button" disabled={busy !== null} onClick={() => {
            setEditingId(null); setLabel(''); setAlias(''); setIdentityFile('');
            setRemotePort('58627'); setExpectedHomeId(''); setReleaseChannel('stable');
          }} className="rounded-md border border-hairline px-2 py-1.5 text-[12px] text-ink-soft disabled:opacity-50">
            {t('common.cancel')}
          </button> : null}
        </div>
      </form>
      {error !== null ? <p role="alert" className="mt-2 whitespace-pre-wrap text-[11px] text-danger">{error}</p> : null}
    </section>
  );
}
