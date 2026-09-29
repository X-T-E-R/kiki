/**
 * Settings › SSH hosts. Two cards:
 *
 *   SSH hosts   Kiki's own hosts (editable) above the aliases read from
 *               ~/.ssh/config (read-only; can be saved as a Kiki host). Each
 *               row opens to its target, roots, host-key note and actions.
 *   Connection  "Always sync ~/.ssh/config" and "Connect without asking",
 *               both instant-apply.
 *
 * Everything goes through the wired `klient.rest.ssh` routes; fields the
 * server does not expose yet (host-key fingerprints, sign-in) are drawn as
 * disabled rows marked "Coming soon", never filled with made-up values.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  canWriteBack,
  inferConfigSync,
  sshApi,
  sshKeys,
  sshTargetLabel,
  useNativeSshEnabled,
  useSshHosts,
  visibleState,
  type SshHost,
  type SshHostStatus,
} from '../../lib/ssh';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from '../settings/SectionCard';
import { useSavedTick } from '../settings/useSavedTick';
import { ComingSoonTag, SshStateMark } from './SshBits';
import { SshHostFormDialog, type SshHostFormMode } from './SshHostFormDialog';

const ROW_ACTION =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:h-10';

export function SshSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const flag = useNativeSshEnabled(client);

  if (flag.loading) return <SectionCard id="st-card-ssh-hosts" title={t('st.ssh.hostsTitle')}><Hint>{t('st.ssh.loading')}</Hint></SectionCard>;
  if (flag.enabled !== true) {
    return (
      <SectionCard id="st-card-ssh-hosts" title={t('st.ssh.hostsTitle')}>
        <div data-ssh-flag-off className="space-y-3">
          <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.ssh.flagOff')}</p>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void navigate('/settings/ssh#st-card-exp-ssh', { replace: true }); }}>
            {t('st.ssh.openLabs')}
          </button>
        </div>
      </SectionCard>
    );
  }
  return <SshHostsSettings />;
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
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'write-back'; host: SshHost } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowFeedback, setRowFeedback] = useState<{ id: string; feedback: Feedback } | null>(null);

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

  return (
    <>
      <SectionCard id="st-card-ssh-hosts" title={t('st.ssh.hostsTitle')}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="mr-auto max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.ssh.intro')}</p>
            <button type="button" data-ssh-add-host className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
              onClick={() => { setForm({ kind: 'create' }); }}>
              <Icon name="plus" size={12} />
              {t('st.ssh.addHost')}
            </button>
          </div>

          {hostsQuery.isLoading ? <Hint>{t('st.ssh.loading')}</Hint> : null}
          {hostsQuery.isError ? <InlineError error={hostsQuery.error} /> : null}

          {empty ? (
            <div data-ssh-empty className="rounded-lg border border-dashed border-hairline-strong px-4 py-5">
              <p className="text-[13px] font-medium text-ink">{t('st.ssh.emptyTitle')}</p>
              <p className="mt-1 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.ssh.emptyBody')}</p>
            </div>
          ) : null}

          {kikiHosts.length > 0 ? (
            <HostGroup
              id="kiki"
              label={t('st.ssh.group.kiki')}
              note={t('st.ssh.group.kikiNote')}
              hosts={kikiHosts}
              statusFor={statusFor}
              busy={busy}
              feedbackFor={(id) => (rowFeedback?.id === id ? rowFeedback.feedback : null)}
              overridden={overridden}
              onEdit={(host) => { setForm({ kind: 'edit', host }); }}
              onDelete={(host) => { setConfirm({ kind: 'delete', host }); }}
              onWriteBack={(host) => { setConfirm({ kind: 'write-back', host }); }}
              onDisconnect={(host) => void run(host, () => sshApi(client).disconnect(host.id), t('st.ssh.disconnected'))}
            />
          ) : null}

          {configHosts.length > 0 ? (
            <HostGroup
              id="ssh-config"
              label={t('st.ssh.group.config')}
              note={t('st.ssh.group.configNote')}
              hosts={configHosts}
              statusFor={statusFor}
              busy={busy}
              feedbackFor={(id) => (rowFeedback?.id === id ? rowFeedback.feedback : null)}
              overridden={overridden}
              onOverride={(host) => { setForm({ kind: 'override', host }); }}
              onDisconnect={(host) => void run(host, () => sshApi(client).disconnect(host.id), t('st.ssh.disconnected'))}
            />
          ) : null}

          {discoveredQuery.isError ? (
            <p role="alert" className="text-[12px] leading-4 text-danger">{t('st.ssh.discoverFailed', { detail: errorText(locale, discoveredQuery.error) })}</p>
          ) : null}
        </div>
      </SectionCard>

      <ConnectionCard listed={hosts} discovered={discovered} discoveredReady={discoveredQuery.isSuccess && hostsQuery.isSuccess} />

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
      <ConfirmDialog
        open={confirm?.kind === 'write-back'}
        tone="default"
        title={t('st.ssh.writeBackTitle', { alias: confirm?.host.id ?? '' })}
        body={t('st.ssh.writeBackBody')}
        confirmLabel={t('st.ssh.writeBack')}
        overlayId="ssh-write-back"
        busy={busy !== null}
        onCancel={() => { setConfirm(null); }}
        onConfirm={() => {
          const host = confirm!.host;
          setConfirm(null);
          void run(host, () => sshApi(client).writeBack(host.id), t('st.ssh.writtenBack', { alias: host.id }));
        }}
      />
    </>
  );
}

function HostGroup({
  id, label, note, hosts, statusFor, busy, feedbackFor, overridden,
  onEdit, onDelete, onWriteBack, onOverride, onDisconnect,
}: {
  id: 'kiki' | 'ssh-config';
  label: string;
  note: string;
  hosts: readonly SshHost[];
  statusFor: (id: string) => SshHostStatus | undefined;
  busy: string | null;
  feedbackFor: (id: string) => Feedback;
  overridden: ReadonlySet<string>;
  onEdit?: (host: SshHost) => void;
  onDelete?: (host: SshHost) => void;
  onWriteBack?: (host: SshHost) => void;
  onOverride?: (host: SshHost) => void;
  onDisconnect: (host: SshHost) => void;
}) {
  return (
    <div data-ssh-group={id}>
      <p className="flex h-7 items-baseline gap-1.5 text-[12px]">
        <span className="font-medium text-ink-soft">{label}</span>
        <span className="text-ink-faint tabular-nums">{hosts.length}</span>
        <span className="ml-1 truncate text-ink-faint">{note}</span>
      </p>
      <div className="mt-0.5 overflow-hidden rounded-lg border border-hairline bg-panel">
        {hosts.map((host) => (
          <HostRow
            key={host.id}
            host={host}
            status={statusFor(host.id)}
            busy={busy === host.id}
            feedback={feedbackFor(host.id)}
            overridesConfig={overridden.has(host.id)}
            onEdit={onEdit}
            onDelete={onDelete}
            onWriteBack={onWriteBack}
            onOverride={onOverride}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </div>
  );
}

function HostRow({
  host, status, busy, feedback, overridesConfig, onEdit, onDelete, onWriteBack, onOverride, onDisconnect,
}: {
  host: SshHost;
  status: SshHostStatus | undefined;
  busy: boolean;
  feedback: Feedback;
  overridesConfig: boolean;
  onEdit?: (host: SshHost) => void;
  onDelete?: (host: SshHost) => void;
  onWriteBack?: (host: SshHost) => void;
  onOverride?: (host: SshHost) => void;
  onDisconnect: (host: SshHost) => void;
}) {
  const { t } = useI18n();
  const state = visibleState(status);
  const target = sshTargetLabel(host);
  const fromConfig = host.source === 'ssh-config';
  const secondLine = target ?? (fromConfig ? t('st.ssh.row.resolvedBySsh') : t('st.ssh.row.aliasOnly', { alias: host.id }));
  const connected = state === 'ready' || state === 'connecting';
  const writable = canWriteBack(host);

  return (
    <details
      data-ssh-host-row={host.id}
      data-ssh-source={host.source}
      className="group/ssh border-b border-hairline last:border-b-0 [&[open]]:bg-paper"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{host.name}</span>
            {host.name !== host.id ? <span className="hidden truncate font-mono text-[12px] text-ink-faint sm:inline">{host.id}</span> : null}
          </span>
          <span className={`block truncate text-[12px] leading-4 text-ink-faint ${target !== undefined ? 'font-mono' : ''}`}>
            {secondLine}
          </span>
        </span>
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
          <dd className="min-w-0 break-all font-mono text-ink-soft">
            {host.roots !== undefined && host.roots.length > 0 ? host.roots.join('\n') : <span className="font-sans text-ink-faint">{t('st.ssh.detail.rootsDefault')}</span>}
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
            <span className="flex items-start justify-between gap-3">
              <span>{t('st.ssh.detail.hostKeyPolicy')}</span>
              <ComingSoonTag />
            </span>
            <span className="mt-0.5 block text-ink-faint">{t('st.ssh.detail.hostKeyPending')}</span>
          </dd>
        </dl>

        <div className="flex flex-wrap items-center gap-1 pt-1">
          {onEdit !== undefined ? (
            <button type="button" data-ssh-edit className={ROW_ACTION} disabled={busy} onClick={() => { onEdit(host); }}>
              <Icon name="edit" size={12} />{t('st.ssh.edit')}
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

/**
 * Two instant-apply switches. Config sync has a PUT but no GET, so its
 * current value is inferred from the lists; when nothing can be observed the
 * switch still works and the hint says the value is unknown.
 */
function ConnectionCard({ listed, discovered, discoveredReady }: {
  listed: readonly SshHost[];
  discovered: readonly SshHost[];
  discoveredReady: boolean;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const approvalQuery = useQuery({
    queryKey: sshKeys.approval(),
    queryFn: () => sshApi(client).connectionApproval(),
    staleTime: 30_000,
  });
  const [syncOverride, setSyncOverride] = useState<boolean | undefined>(undefined);
  const inferred = discoveredReady ? inferConfigSync(listed, discovered) : undefined;
  const sync = syncOverride ?? inferred;
  const [saving, setSaving] = useState<'sync' | 'approval' | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<Feedback>(null);
  const [approvalFeedback, setApprovalFeedback] = useState<Feedback>(null);
  const [syncSaved, pingSync] = useSavedTick();
  const [approvalSaved, pingApproval] = useSavedTick();
  const [pendingSkip, setPendingSkip] = useState<boolean | undefined>(undefined);
  const skipApproval = pendingSkip ?? (approvalQuery.data === undefined ? false : !approvalQuery.data.enabled);

  const setSync = async (next: boolean) => {
    const previous = syncOverride;
    setSyncOverride(next);
    setSaving('sync');
    setSyncFeedback(null);
    try {
      await sshApi(client).setConfigSync(next);
      await queryClient.invalidateQueries({ queryKey: sshKeys.hosts() });
      pingSync();
    } catch (error) {
      setSyncOverride(previous);
      setSyncFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
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
      <div className="space-y-4">
        <div data-settings-field data-ssh-sync className="space-y-0.5 py-1">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Toggle layout="row" label={t('st.ssh.syncToggle')} checked={sync ?? true} disabled={saving === 'sync'}
                onChange={(checked) => void setSync(checked)} />
            </div>
            <SavedTick show={syncSaved} />
          </div>
          <Hint>{sync === undefined && syncOverride === undefined ? t('st.ssh.syncUnknown') : t('st.ssh.syncHint')}</Hint>
          <FeedbackLine feedback={syncFeedback} />
        </div>

        <div data-settings-field data-ssh-approval className="space-y-0.5 py-1">
          {approvalQuery.isError ? <InlineError error={approvalQuery.error} /> : (
            <>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Toggle layout="row" label={t('st.ssh.approvalToggle')} checked={skipApproval}
                    disabled={approvalQuery.data === undefined || saving === 'approval'}
                    onChange={(checked) => void setSkip(checked)} />
                </div>
                <SavedTick show={approvalSaved} />
              </div>
              {/* Stated next to the switch on purpose: it decides whether turning it on is safe. */}
              <Hint>{t('st.ssh.approvalHint')}</Hint>
            </>
          )}
          <FeedbackLine feedback={approvalFeedback} />
        </div>
      </div>
    </SectionCard>
  );
}
