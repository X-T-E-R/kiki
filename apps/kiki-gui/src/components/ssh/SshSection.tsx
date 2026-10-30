/**
 * Settings › SSH hosts. Two cards:
 *
 *   SSH hosts   Kiki's own hosts (editable) above the aliases read from
 *               ~/.ssh/config (read-only; can be saved as a Kiki host). Each
 *               row opens to its target, roots, host-key note and actions, and
 *               reads that host's known_hosts entries only when asked.
 *   Connection  "Always sync ~/.ssh/config" and "Connect without asking",
 *               both instant-apply, both drawn from the value the server
 *               reports rather than a guess made from the host lists.
 *
 * Everything goes through the wired `klient.rest.ssh` routes; the sign-in
 * fields the server cannot take yet stay drawn as "Coming soon" in the host
 * form, never filled with made-up values.
 */

import { useEffect, useId, useState } from 'react';

import { pushToast, pushUndoToast } from '../../lib/toasts';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { SshHostKeys } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import {
  canWriteBack,
  NATIVE_SSH_FLAG,
  sshApi,
  sshKeys,
  sshTargetLabel,
  useNativeSshEnabled,
  useSshConfigSync,
  useSshHostKeys,
  useSshHosts,
  visibleState,
  type SshHost,
  type SshHostInput,
  type SshHostStatus,
} from '../../lib/ssh';
import { MAIN_SPACE_ID, useSpaces } from '../../lib/spaces';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { ExperimentalRow, useExperimentalFlags } from '../settings/ExperimentalRows';
import { SectionCard } from '../settings/SectionCard';
import { SettingField, SettingsBox } from '../settings/fields';
import { useSavedTick } from '../settings/useSavedTick';
import { SshStateMark } from './SshBits';
import { SshHostFormDialog, type SshHostFormMode } from './SshHostFormDialog';
import { AddConnectionBySshDialog } from '../settings/remote/AddConnectionBySshDialog';

const ROW_ACTION =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:h-10';

/** Same rhythm as the row actions, sized for a glyph that sits on a text line. */
const COPY_BUTTON =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10';

export function SshSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const flag = useNativeSshEnabled(client);

  if (flag.loading) return <SectionCard id="st-card-ssh-hosts" title={t('st.ssh.hostsTitle')}><Hint>{t('st.ssh.loading')}</Hint></SectionCard>;
  if (flag.enabled !== true) return <SshFlagOffCard />;
  return <SshHostsSettings />;
}

/**
 * The flag-off fallback: the enable switch lives right here instead of a link
 * to the page's own experimental row, which only renders when the server
 * reports the flag and could leave that link scrolling nowhere. It is the
 * same three-way ExperimentalRow the page would show below.
 */
function SshFlagOffCard() {
  const { t } = useI18n();
  const { rows, effective, loading } = useExperimentalFlags();
  const saved = rows.find((row) => row.id === NATIVE_SSH_FLAG);
  return (
    <SectionCard id="st-card-ssh-hosts" title={t('st.ssh.hostsTitle')}>
      <div data-ssh-flag-off className="space-y-3">
        <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.ssh.flagOff')}</p>
        {loading ? <Hint>{t('st.ssh.loading')}</Hint> : (
          <SettingsBox>
            <ExperimentalRow id={NATIVE_SSH_FLAG} override={saved?.override} effective={effective[NATIVE_SSH_FLAG]} />
          </SettingsBox>
        )}
      </div>
    </SectionCard>
  );
}

function SshHostsSettings() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const hostsQuery = useSshHosts(client);
  const discoveredQuery = useQuery({
    queryKey: sshKeys.discovered(),
    queryFn: async () => (await sshApi(client).discover()).hosts,
    staleTime: 30_000,
  });
  const hosts = hostsQuery.data ?? [];
  const statuses = useQueries({
    queries: hosts.map((host) => ({
      queryKey: sshKeys.status(host.id),
      // Reading status never opens a connection (contract).
      queryFn: () => sshApi(client).status(host.id),
      staleTime: 10_000,
    })),
  });
  const statusFor = (id: string): SshHostStatus | undefined =>
    statuses[hosts.findIndex((host) => host.id === id)]?.data;

  const [form, setForm] = useState<SshHostFormMode | null>(null);
  // One dialog, opened from a profile row: this Kiki keeps the connection.
  const [remoteSpace, setRemoteSpace] = useState<{ profileId: string } | null>(null);
  // The main space's own path is the default home on the other machine, the
  // same one the space directory shows.
  const mainSpacePath = useSpaces(client).data?.find((space) => space.id === MAIN_SPACE_ID)?.path ?? '';
  const [confirm, setConfirm] = useState<{ kind: 'delete'; host: SshHost } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowFeedback, setRowFeedback] = useState<{ id: string; feedback: Feedback } | null>(null);

  // Kiki's own hosts come first (they are the editable ones), the system
  // config's aliases after; one list, one order.
  const kikiHosts = hosts.filter((host) => host.source === 'kiki');
  const configHosts = hosts.filter((host) => host.source === 'ssh-config');
  // Kiki hosts that shadow a discovered alias keep the alias visible as "overridden".
  const discovered = discoveredQuery.data ?? [];
  const overridden = new Set(kikiHosts.filter((host) => discovered.some((alias) => alias.id === host.id)).map((host) => host.id));
  const empty = hostsQuery.isSuccess && hosts.length === 0;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: sshKeys.all });
  };

  const run = async (host: SshHost, action: () => Promise<unknown>, success: string) => {
    setBusy(host.id);
    setRowFeedback(null);
    try {
      await action();
      setRowFeedback({ id: host.id, feedback: { tone: 'success', text: success } });
      await refresh();
    } catch (error) {
      setRowFeedback({ id: host.id, feedback: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      setBusy(null);
    }
  };

  // Writing a host back to ~/.ssh/config is reversible with the store the
  // server keeps: the row holds the pre-write record, so run it at once and
  // let the toast put that record back instead of asking first. Deleting the
  // stored host stays a confirm — the record itself is gone there.
  const writeBack = async (host: SshHost) => {
    const prior: SshHostInput = {
      name: host.name,
      hostname: host.hostname,
      user: host.user,
      port: host.port,
      identityFile: host.identityFile,
      roots: host.roots,
      description: host.description,
      agentAccess: host.agentAccess,
    };
    setBusy(host.id);
    setRowFeedback(null);
    try {
      await sshApi(client).writeBack(host.id);
      await refresh();
      pushUndoToast({
        text: t('st.ssh.writtenBack', { alias: host.id }),
        undoFailedText: t('toast.undoFailed'),
        undo: async () => {
          await sshApi(client).upsert(host.id, prior);
          await refresh();
        },
      });
    } catch (error) {
      setRowFeedback({ id: host.id, feedback: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionCard id="st-card-ssh-hosts" title={t('st.ssh.hostsTitle')}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <button type="button" data-ssh-add-host className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
              onClick={() => { setForm({ kind: 'create' }); }}>
              <Icon name="plus" size={12} />
              {t('st.ssh.addHost')}
            </button>
          </div>

          {hostsQuery.isLoading ? <Hint>{t('st.ssh.loading')}</Hint> : null}
          {hostsQuery.isError ? <InlineError error={hostsQuery.error} /> : null}

          {empty ? (
            <div data-ssh-empty className="space-y-2">
              <p className="text-[13px] font-medium text-ink">{t('st.ssh.emptyTitle')}</p>
              <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.ssh.emptyBody')}</p>
              <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                onClick={() => { setForm({ kind: 'create' }); }}>
                <Icon name="plus" size={12} />
                {t('st.ssh.addHost')}
              </button>
            </div>
          ) : null}

          {hosts.length > 0 ? (
            // One list: where a host lives is a tag on its row, not a group the
            // reader has to learn. Kiki's own hosts first (they are the ones the
            // user can edit), the system config's aliases after.
            <HostList
              hosts={hosts}
              statusFor={statusFor}
              busy={busy}
              feedbackFor={(id) => (rowFeedback?.id === id ? rowFeedback.feedback : null)}
              overridden={overridden}
              onEdit={(host) => { setForm({ kind: 'edit', host }); }}
              onRemoteSpace={(host) => { setRemoteSpace({ profileId: host.id }); }}
              onDelete={(host) => { setConfirm({ kind: 'delete', host }); }}
              onWriteBack={(host) => { void writeBack(host); }}
              onOverride={(host) => { setForm({ kind: 'override', host }); }}
              onDisconnect={(host) => void run(host, () => sshApi(client).disconnect(host.id), t('st.ssh.disconnected'))}
            />
          ) : null}

          {discoveredQuery.isError ? (
            <p role="alert" className="text-[12px] leading-4 text-danger">{t('st.ssh.discoverFailed', { detail: errorText(locale, discoveredQuery.error) })}</p>
          ) : null}
        </div>
      </SectionCard>

      <ConnectionCard />

      {remoteSpace !== null ? (
        <AddConnectionBySshDialog client={client} profiles={hosts} defaultHome={mainSpacePath}
          initialProfileId={remoteSpace.profileId}
          onClose={() => { setRemoteSpace(null); }}
          onAdded={(record) => { setRemoteSpace(null); pushToast({ tone: 'success', text: t('st.ssh.remoteAdded', { name: record.label }) }); }} />
      ) : null}

      {form !== null ? (
        <SshHostFormDialog
          mode={form}
          onClose={() => { setForm(null); }}
          onSubmit={async (id, input) => {
            await sshApi(client).upsert(id, input);
            await refresh();
            setForm(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={t('st.ssh.deleteTitle', { name: confirm?.host.name ?? '' })}
        body={t('st.ssh.deleteBody')}
        confirmLabel={t('st.ssh.deleteConfirm')}
        overlayId="ssh-delete-host"
        busy={busy !== null}
        onCancel={() => { setConfirm(null); }}
        onConfirm={() => {
          const host = confirm!.host;
          setConfirm(null);
          void run(host, () => sshApi(client).remove(host.id), t('st.ssh.deleted', { name: host.name }));
        }}
      />
    </>
  );
}

function HostList({
  hosts, statusFor, busy, feedbackFor, overridden,
  onEdit, onRemoteSpace, onDelete, onWriteBack, onOverride, onDisconnect,
}: {
  hosts: readonly SshHost[];
  statusFor: (id: string) => SshHostStatus | undefined;
  busy: string | null;
  feedbackFor: (id: string) => Feedback;
  overridden: ReadonlySet<string>;
  onEdit?: (host: SshHost) => void;
  onRemoteSpace?: (host: SshHost) => void;
  onDelete?: (host: SshHost) => void;
  onWriteBack?: (host: SshHost) => void;
  onOverride?: (host: SshHost) => void;
  onDisconnect: (host: SshHost) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
      {hosts.map((host) => (
        <HostRow
          key={host.id}
          host={host}
          status={statusFor(host.id)}
          busy={busy === host.id}
          feedback={feedbackFor(host.id)}
          overridesConfig={overridden.has(host.id)}
          onEdit={host.source === 'kiki' ? onEdit : undefined}
          onRemoteSpace={host.source === 'kiki' ? onRemoteSpace : undefined}
          onDelete={host.source === 'kiki' ? onDelete : undefined}
          onWriteBack={host.source === 'kiki' ? onWriteBack : undefined}
          onOverride={host.source === 'ssh-config' ? onOverride : undefined}
          onDisconnect={onDisconnect}
        />
      ))}
    </div>
  );
}

function HostRow({
  host, status, busy, feedback, overridesConfig, onEdit, onRemoteSpace, onDelete, onWriteBack, onOverride, onDisconnect,
}: {
  host: SshHost;
  status: SshHostStatus | undefined;
  busy: boolean;
  feedback: Feedback;
  overridesConfig: boolean;
  onEdit?: (host: SshHost) => void;
  onRemoteSpace?: (host: SshHost) => void;
  onDelete?: (host: SshHost) => void;
  onWriteBack?: (host: SshHost) => void;
  onOverride?: (host: SshHost) => void;
  onDisconnect: (host: SshHost) => void;
}) {
  const { t } = useI18n();
  const keyRegionId = useId();
  const [showKeys, setShowKeys] = useState(false);
  const state = visibleState(status);
  const target = sshTargetLabel(host);
  const fromConfig = host.source === 'ssh-config';
  const secondLine = target ?? (fromConfig ? t('st.ssh.row.fromConfig') : t('st.ssh.row.aliasOnly', { alias: host.id }));
  const sourceTag = fromConfig && target !== undefined;
  const connected = state === 'ready' || state === 'connecting';
  const writable = canWriteBack(host);

  return (
    <details
      data-ssh-host-row={host.id}
      data-ssh-source={host.source}
      className="group/ssh border-b border-hairline last:border-b-0 [&[open]]:bg-paper"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{host.name}</span>
            {host.name !== host.id ? <span className="hidden truncate font-mono text-[12px] text-ink-faint sm:inline">{host.id}</span> : null}
          </span>
          <span className={`block truncate text-[12px] leading-4 text-ink-faint ${target !== undefined ? 'font-mono' : ''}`}>
            {secondLine}
          </span>
        </span>
        {sourceTag ? (
          <span className="hidden shrink-0 text-[12px] text-ink-faint sm:inline" data-ssh-source-tag>{t('st.ssh.row.fromConfig')}</span>
        ) : null}
        {host.agentAccess === 'hidden' ? (
          <span className="hidden shrink-0 text-[12px] text-ink-faint sm:inline">{t('st.ssh.row.hidden')}</span>
        ) : null}
        {overridesConfig ? (
          <span className="hidden shrink-0 text-[12px] text-ink-faint sm:inline">{t('st.ssh.row.overrides')}</span>
        ) : null}
        {state !== undefined ? <SshStateMark state={state} /> : null}
        <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/ssh:rotate-90" />
      </summary>

      <div className="space-y-3 px-3 pb-3 pt-1">
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px] leading-4">
          <dt className="text-ink-faint">{t('st.ssh.detail.source')}</dt>
          <dd className="min-w-0 text-ink-soft">{fromConfig ? t('st.ssh.detail.sourceConfig') : t('st.ssh.detail.sourceKiki')}</dd>
          <dt className="text-ink-faint">{t('st.ssh.detail.target')}</dt>
          <dd className="min-w-0 break-all font-mono text-ink-soft">{target ?? t('st.ssh.detail.targetFromConfig', { alias: host.id })}</dd>
          {host.identityFile !== undefined ? (
            <>
              <dt className="text-ink-faint">{t('st.ssh.detail.identity')}</dt>
              <dd className="min-w-0 break-all font-mono text-ink-soft">{host.identityFile}</dd>
            </>
          ) : null}
          <dt className="text-ink-faint">{t('st.ssh.detail.roots')}</dt>
          {/* One root per line: a joined string would be folded into one line by
              the layout, and these are paths a person compares one by one. */}
          <dd className="min-w-0">
            {host.roots !== undefined && host.roots.length > 0
              ? host.roots.map((root) => <span key={root} className="block break-all font-mono text-ink-soft">{root}</span>)
              : <span className="font-sans text-ink-faint">{t('st.ssh.detail.rootsDefault')}</span>}
          </dd>
          <dt className="text-ink-faint">{t('st.ssh.detail.agent')}</dt>
          <dd className="min-w-0 text-ink-soft">{host.agentAccess === 'hidden' ? t('st.ssh.detail.agentHidden') : t('st.ssh.detail.agentOffered')}</dd>
          {host.description !== undefined ? (
            <>
              <dt className="text-ink-faint">{t('st.ssh.detail.description')}</dt>
              <dd className="min-w-0 text-ink-soft">{host.description}</dd>
            </>
          ) : null}
          <dt className="text-ink-faint">{t('st.ssh.detail.hostKey')}</dt>
          <dd data-ssh-host-key className="min-w-0 text-ink-soft">
            <span className="block">{t('st.ssh.detail.hostKeyPolicy')}</span>
            <button
              type="button"
              data-ssh-host-keys-toggle
              aria-expanded={showKeys}
              aria-controls={keyRegionId}
              className={`${ROW_ACTION} -ml-2 mt-0.5`}
              onClick={() => { setShowKeys(!showKeys); }}
            >
              <Icon name={showKeys ? 'eyeOff' : 'eye'} size={12} />
              {t(showKeys ? 'st.ssh.hostKeys.hide' : 'st.ssh.hostKeys.view')}
            </button>
          </dd>
        </dl>

        {showKeys ? <HostKeyPanel host={host} regionId={keyRegionId} /> : null}

        <div className="flex flex-wrap items-center gap-1 pt-1">
          {onEdit !== undefined ? (
            <button type="button" data-ssh-edit className={ROW_ACTION} disabled={busy} onClick={() => { onEdit(host); }}>
              <Icon name="edit" size={12} />{t('st.ssh.edit')}
            </button>
          ) : null}
          {onRemoteSpace !== undefined ? (
            <button type="button" data-ssh-as-remote-space={host.id} className={ROW_ACTION} disabled={busy}
              onClick={() => { onRemoteSpace(host); }}>
              <Icon name="external" size={12} />{t('st.ssh.asRemoteSpace')}
            </button>
          ) : null}
          {onOverride !== undefined ? (
            <button type="button" data-ssh-override className={ROW_ACTION} disabled={busy} onClick={() => { onOverride(host); }}>
              <Icon name="plus" size={12} />{t('st.ssh.saveAsKiki')}
            </button>
          ) : null}
          {onWriteBack !== undefined ? (
            <button
              type="button"
              data-ssh-write-back
              className={ROW_ACTION}
              disabled={busy || !writable || overridesConfig}
              title={overridesConfig ? t('st.ssh.writeBackExists') : writable ? undefined : t('st.ssh.writeBackNeedsTarget')}
              onClick={() => { onWriteBack(host); }}
            >
              <Icon name="file" size={12} />{t('st.ssh.writeBack')}
            </button>
          ) : null}
          {connected ? (
            <button type="button" data-ssh-disconnect className={ROW_ACTION} disabled={busy} onClick={() => { onDisconnect(host); }}>
              {t('st.ssh.disconnect')}
            </button>
          ) : null}
          {onDelete !== undefined ? (
            <button type="button" data-ssh-delete className={`${ROW_ACTION} ml-auto hover:bg-danger/[0.06] hover:text-danger`} disabled={busy} onClick={() => { onDelete(host); }}>
              {t('st.ssh.delete')}
            </button>
          ) : null}
        </div>
        {onWriteBack !== undefined && !writable ? (
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.ssh.writeBackNeedsTarget')}</p>
        ) : null}
        {fromConfig ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.ssh.configReadOnly')}</p> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </details>
  );
}

type HostKeyRecord = SshHostKeys['records'][number];
type HostKeyFile = SshHostKeys['files'][number];

/** Words for the entries a connection would refuse or cannot use as they stand. */
const RECORD_STATUS_KEY: Record<Exclude<HostKeyRecord['status'], 'recorded'>, I18nKey> = {
  revoked: 'st.ssh.hostKeys.status.revoked',
  unsupported: 'st.ssh.hostKeys.status.unsupported',
  invalid: 'st.ssh.hostKeys.status.invalid',
};

const FILE_STATE_KEY: Record<HostKeyFile['state'], I18nKey> = {
  read: 'st.ssh.hostKeys.file.read',
  missing: 'st.ssh.hostKeys.file.missing',
  unavailable: 'st.ssh.hostKeys.file.unavailable',
};

const AMBIGUOUS_PATHS_REASON = 'ambiguous-known-hosts-paths';

/**
 * The server's reason codes are the diagnostic of record; only the two the
 * contract names get words of their own, and anything else stays visible as
 * the raw code rather than being paraphrased into a claim nobody made.
 */
function recordReasonKey(record: HostKeyRecord): I18nKey | undefined {
  if (record.status === 'revoked') return 'st.ssh.hostKeys.reason.revoked';
  if (record.status === 'invalid') {
    return record.reason === 'invalid-public-key' ? 'st.ssh.hostKeys.reason.invalidKey' : undefined;
  }
  if (record.status === 'unsupported') {
    return record.reason === 'unsupported-marker:@cert-authority' ? 'st.ssh.hostKeys.reason.certAuthority' : undefined;
  }
  return undefined;
}

/**
 * One host's known_hosts entries, opened from the row that asked for them and
 * drawn flat inside the same `details`. The answer is about this computer's
 * files: a match means the local files hold an entry for this host, never that
 * the remote key was verified or that it stayed the same, so nothing here
 * wears a "safe" mark. There is no trust, forget or ignore action either — a
 * first-seen or changed key is decided on the connection card, and a revoked
 * entry is not a thing a settings row should wave away.
 */
function HostKeyPanel({ host, regionId }: { host: SshHost; regionId: string }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const query = useSshHostKeys(client, host.id, true);
  const info = query.data;
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => { setCopied(null); }, 1_600);
    return () => { clearTimeout(timer); };
  }, [copied]);

  const copy = async (fingerprint: string) => {
    setCopyFailed(false);
    try {
      await copyTextToClipboard(fingerprint);
      setCopied(fingerprint);
    } catch {
      setCopyFailed(true);
    }
  };

  const records = info?.records ?? [];
  const files = info?.files ?? [];
  const ambiguous = files.some((file) => file.state === 'unavailable' && file.reason === AMBIGUOUS_PATHS_REASON);
  // Every file that was read is already named by the entries inside it; the
  // list earns its place only where it says what could not be searched.
  const listed = info !== undefined && (info.state === 'unrecorded' || ambiguous)
    ? files
    : files.filter((file) => file.state !== 'read');

  const fileList = listed.length > 0 ? (
    <div data-ssh-host-key-files className="space-y-0.5">
      {listed.map((file) => (
        <p key={file.path} data-ssh-host-key-file data-file-state={file.state}
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] leading-4 text-ink-faint">
          <span className="min-w-0 break-all font-mono">{file.path}</span>
          <span>· {t(FILE_STATE_KEY[file.state])}</span>
          {file.reason !== undefined && file.reason !== AMBIGUOUS_PATHS_REASON ? <span>· {file.reason}</span> : null}
        </p>
      ))}
    </div>
  ) : null;

  return (
    <section
      id={regionId}
      data-ssh-host-keys
      data-state={info?.state ?? (query.isError ? 'error' : 'loading')}
      className="space-y-2 border-t border-hairline pt-3"
    >
      {query.isError ? (
        <div className="space-y-1">
          <p role="alert" className="max-w-[62ch] text-[12px] leading-4 text-danger">
            {t('st.ssh.hostKeys.readFailed', { detail: errorText(locale, query.error) })}
          </p>
          <button type="button" data-ssh-host-keys-retry className={ROW_ACTION} disabled={query.isFetching}
            onClick={() => { void query.refetch(); }}>
            {t('common.retry')}
          </button>
        </div>
      ) : info === undefined ? (
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.ssh.hostKeys.reading')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span data-ssh-host-key-label className="min-w-0 break-all font-mono text-[12px] text-ink">{info.label}</span>
            <button type="button" data-ssh-host-keys-refresh className={`${ROW_ACTION} ml-auto`} disabled={query.isFetching}
              onClick={() => { void query.refetch(); }}>
              {t('st.ssh.hostKeys.refresh')}
            </button>
          </div>

          {info.state === 'unrecorded' ? (
            <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('st.ssh.hostKeys.unrecorded')}</p>
          ) : ambiguous ? (
            // -G drops the quotes around a path with a space, so one quoted file
            // and two files read identically; saying "no record" here would be
            // wrong, and asking for a fresh trust decision would be worse.
            <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('st.ssh.hostKeys.ambiguous')}</p>
          ) : records.length > 0 ? (
            <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.ssh.hostKeys.localNote')}</p>
          ) : (
            <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('st.ssh.hostKeys.unavailable')}</p>
          )}

          {records.length > 0 ? (
            <ul data-ssh-host-key-records className="space-y-2">
              {records.map((record, index) => {
                const reasonKey = recordReasonKey(record);
                return (
                  <li key={`${record.file}:${record.line}:${index}`} data-ssh-host-key-record data-status={record.status}
                    className="border-t border-hairline pt-2 first:border-t-0 first:pt-0">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-[12px] text-ink">{record.algorithm}</span>
                      {record.status !== 'recorded' ? (
                        <span className={record.status === 'unsupported' ? 'text-[12px] text-amber-ink' : 'text-[12px] text-danger'}>
                          {t(RECORD_STATUS_KEY[record.status])}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        data-ssh-host-key-fingerprint
                        className="min-w-0 flex-1 select-all break-all font-mono text-[11px] leading-4 text-ink-soft"
                      >
                        {record.fingerprint ?? t('st.ssh.hostKeys.noFingerprint')}
                      </span>
                      {record.fingerprint !== undefined ? (
                        <button
                          type="button"
                          data-ssh-host-key-copy
                          aria-label={t('st.ssh.hostKeys.copy', { algorithm: record.algorithm })}
                          title={t('st.ssh.hostKeys.copy', { algorithm: record.algorithm })}
                          className={COPY_BUTTON}
                          onClick={() => void copy(record.fingerprint!)}
                        >
                          <Icon name={copied === record.fingerprint ? 'check' : 'copy'} size={12}
                            className={copied === record.fingerprint ? 'text-success' : ''} />
                        </button>
                      ) : null}
                    </div>
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] leading-4 text-ink-faint">
                      <span className="min-w-0 break-all font-mono">{record.file}:{record.line}</span>
                      <span>· {record.hostPattern}</span>
                    </p>
                    {reasonKey !== undefined ? (
                      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t(reasonKey)}</p>
                    ) : record.reason !== undefined ? (
                      <p className="max-w-[62ch] break-all font-mono text-[12px] leading-4 text-ink-faint">{record.reason}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {fileList}

          {copyFailed ? (
            <p role="alert" className="max-w-[62ch] text-[12px] leading-4 text-danger">{t('st.ssh.hostKeys.copyFailed')}</p>
          ) : null}
          <p role="status" className="sr-only">{copied === null ? '' : t('st.ssh.hostKeys.copied')}</p>
        </>
      )}
    </section>
  );
}

/**
 * Two instant-apply switches. Config sync reads its own stored value from the
 * server: what the host lists show cannot tell sync-off from an empty ssh
 * config or from every alias being shadowed, and drawing a guess as ON is
 * exactly the state a user cannot act on. Until the value arrives the row
 * shows a loading line, and a failed read shows the retry instead of a switch
 * nobody can trust.
 */
function ConnectionCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const approvalQuery = useQuery({
    queryKey: sshKeys.approval(),
    queryFn: () => sshApi(client).connectionApproval(),
    staleTime: 30_000,
  });
  const syncQuery = useSshConfigSync(client);
  // Optimistic only while the write is in flight: what the switch shows after
  // a save is the value the server read back, never the value we asked for.
  const [pendingSync, setPendingSync] = useState<boolean | undefined>(undefined);
  const sync = pendingSync ?? syncQuery.data?.enabled;
  const syncSource = syncQuery.data?.source;
  const [saving, setSaving] = useState<'sync' | 'approval' | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<Feedback>(null);
  const [approvalFeedback, setApprovalFeedback] = useState<Feedback>(null);
  const [syncSaved, pingSync] = useSavedTick();
  const [approvalSaved, pingApproval] = useSavedTick();
  const [pendingSkip, setPendingSkip] = useState<boolean | undefined>(undefined);
  const skipApproval = pendingSkip ?? (approvalQuery.data === undefined ? false : !approvalQuery.data.enabled);

  const setSync = async (next: boolean) => {
    setPendingSync(next);
    setSaving('sync');
    setSyncFeedback(null);
    try {
      const stored = await sshApi(client).setConfigSync(next);
      queryClient.setQueryData(sshKeys.configSync(), stored);
      await queryClient.invalidateQueries({ queryKey: sshKeys.hosts() });
      pingSync();
    } catch (error) {
      setSyncFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      // Either way the switch falls back to the stored value: the write landed
      // and the cache now holds what the server reports, or it failed and the
      // last official value is still the truth.
      setPendingSync(undefined);
      setSaving(null);
    }
  };

  const setSkip = async (skip: boolean) => {
    setPendingSkip(skip);
    setSaving('approval');
    setApprovalFeedback(null);
    try {
      const result = await sshApi(client).setConnectionApproval(!skip);
      queryClient.setQueryData(sshKeys.approval(), result);
      pingApproval();
    } catch (error) {
      setApprovalFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setPendingSkip(undefined);
      setSaving(null);
    }
  };

  return (
    <SectionCard id="st-card-ssh-connection" title={t('st.ssh.connectionTitle')}>
      <SettingsBox>
        <div data-ssh-sync data-ssh-sync-source={syncSource ?? 'unknown'}>
          {sync !== undefined ? (
            <SettingField
              label={t('st.ssh.syncToggle')}
              help={t('st.ssh.syncHint')}
            >
              <SavedTick show={syncSaved} />
              <Toggle layout="bare" label={t('st.ssh.syncToggle')} checked={sync} disabled={saving === 'sync'}
                onChange={(checked) => void setSync(checked)} />
            </SettingField>
          ) : (
            // The label holds the row's place while the value is unknown — same
            // line height as the switch row, so nothing jumps when it arrives.
            <div data-settings-field className="space-y-1">
              <p className="flex min-h-7 items-center text-[13px] text-ink">{t('st.ssh.syncToggle')}</p>
              {syncQuery.isError ? (
                <div className="space-y-1 py-0.5">
                  <p role="alert" className="max-w-[62ch] text-[12px] leading-snug text-danger">
                    {t('st.ssh.syncReadFailed')}
                  </p>
                  <button type="button" data-ssh-sync-retry className={ROW_ACTION} disabled={syncQuery.isFetching}
                    onClick={() => { void syncQuery.refetch(); }}>
                    {t('common.retry')}
                  </button>
                </div>
              ) : (
                <p className="text-[12px] leading-4 text-ink-faint">{t('st.ssh.syncReading')}</p>
              )}
            </div>
          )}
          <FeedbackLine feedback={syncFeedback} />
        </div>

        <div data-ssh-approval>
          {approvalQuery.isError ? <InlineError error={approvalQuery.error} /> : (
            // Stated next to the switch on purpose: it decides whether turning it on is safe.
            <SettingField label={t('st.ssh.approvalToggle')} help={t('st.ssh.approvalHint')}>
              <SavedTick show={approvalSaved} />
              <Toggle layout="bare" label={t('st.ssh.approvalToggle')} checked={skipApproval}
                disabled={approvalQuery.data === undefined || saving === 'approval'}
                onChange={(checked) => void setSkip(checked)} />
            </SettingField>
          )}
          <FeedbackLine feedback={approvalFeedback} />
        </div>
      </SettingsBox>
    </SectionCard>
  );
}
