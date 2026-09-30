/**
 * SSH approvals in the tray. The gate (agent-core sshConnectionGateService)
 * raises three kinds, all carrying a non-secret top-level `ssh` field:
 *
 *   login (first)    connection permission + optional sign-in
 *   login + prompts  one keyboard-interactive round (e.g. a 2FA code)
 *   host_key         first-seen host key: algorithm + SHA256 fingerprint
 *
 * Answers go through the SSH-only route (`klient.rest.ssh.submitApproval`);
 * the generic approval route refuses SSH requests. Secrets never touch
 * `feedback`, `selected_option_id`, a URL, a log or the query cache: they
 * live in this component's state until the POST and are cleared after it.
 * A changed host key never reaches this card — the engine refuses it and
 * the tool call fails with the reason.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { ApprovalRequest, SshApprovalSubmit, SshCredential } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { SettingsSegmented } from '../settings/SettingsPrimitives';
import { INPUT } from '../ui';

export type SshApprovalInfo = NonNullable<ApprovalRequest['ssh']>;
type Decision = SshApprovalSubmit['decision'];
type LoginMethod = 'agent' | 'password' | 'keyFile' | 'keyText';
type SaveScope = NonNullable<SshCredential['save']>;

const PRIMARY =
  'inline-flex min-h-8 items-center rounded-md bg-accent px-3 text-[13px] font-semibold text-primary-foreground transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint';
const SECONDARY =
  'inline-flex min-h-8 items-center rounded-md px-3 text-[13px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-60';
const LABEL = 'block text-[12px] font-medium text-ink-soft';

/** "Connect SSH host <name> (<id>)" → { name, id }; other SSH actions → the host id. */
export function sshHostFromAction(action: string): { name: string; id: string } | undefined {
  const connect = /^Connect SSH host (.+) \(([^()]+)\)$/.exec(action);
  if (connect !== null) return { name: connect[1]!, id: connect[2]! };
  const other = /^(?:Trust SSH host key|SSH authentication for) (.+)$/.exec(action);
  if (other !== null) return { name: other[1]!, id: other[1]! };
  return undefined;
}

export type SshCardKind = 'connect' | 'prompts' | 'host_key';

export function sshCardKind(ssh: SshApprovalInfo): SshCardKind {
  if (ssh.kind === 'host_key') return 'host_key';
  return ssh.prompts !== undefined && ssh.prompts.length > 0 ? 'prompts' : 'connect';
}

export function sshTitleKey(ssh: SshApprovalInfo) {
  const kind = sshCardKind(ssh);
  return kind === 'host_key' ? 'ia.ssh.hostKeyTitle' as const
    : kind === 'prompts' ? 'ia.ssh.promptsTitle' as const
    : 'ia.ssh.title' as const;
}

/** Resolved target rows, shared by all three kinds. */
function TargetRows({ ssh }: { ssh: SshApprovalInfo }) {
  const { t } = useI18n();
  const rows: { label: string; value: string }[] = [
    { label: t('ia.ssh.user'), value: ssh.user },
    { label: t('ia.ssh.target'), value: `${ssh.hostname}:${ssh.port}` },
  ];
  if (ssh.proxyJump !== undefined && ssh.proxyJump !== '') rows.push({ label: t('ia.ssh.via'), value: ssh.proxyJump });
  if (ssh.proxyCommand !== undefined && ssh.proxyCommand !== '') rows.push({ label: t('ia.ssh.proxyCommand'), value: ssh.proxyCommand });
  return (
    <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-ink/[0.04] px-3 py-2 text-[12px] leading-[18px]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-ink-faint">{row.label}</dt>
          <dd className="min-w-0 break-all font-mono text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SshApprovalBody({
  ssh,
  action,
  toolName,
  busy,
  failed,
  onSubmit,
}: {
  ssh: SshApprovalInfo;
  action: string;
  toolName: string;
  busy: Decision | null;
  failed: boolean;
  onSubmit: (body: SshApprovalSubmit) => void;
}) {
  const { t } = useI18n();
  const host = sshHostFromAction(action);
  const kind = sshCardKind(ssh);
  return (
    <div data-ssh-approval={kind} data-ssh-host={host?.id}>
      <p className="mt-1 min-w-0 text-[14px] leading-snug text-ink">
        {t(kind === 'host_key' ? 'ia.ssh.hostKeyFor' : kind === 'prompts' ? 'ia.ssh.promptsFor' : 'ia.ssh.connectTo')}{' '}
        <span className="font-medium">{host?.name ?? ssh.hostname}</span>
        {host !== undefined && host.name !== host.id ? <span className="font-mono text-[13px] text-ink-faint"> {host.id}</span> : null}
      </p>
      <TargetRows ssh={ssh} />
      {kind === 'host_key' ? (
        <HostKeyForm ssh={ssh} busy={busy} failed={failed} onSubmit={onSubmit} />
      ) : kind === 'prompts' ? (
        <PromptsForm ssh={ssh} busy={busy} failed={failed} onSubmit={onSubmit} />
      ) : (
        <ConnectForm ssh={ssh} toolName={toolName} busy={busy} failed={failed} onSubmit={onSubmit} />
      )}
    </div>
  );
}

function Actions({ busy, failed, primaryLabel, primaryDisabled = false, onReject, rejectLabel }: {
  busy: Decision | null;
  failed: boolean;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onReject: () => void;
  rejectLabel: string;
}) {
  const { t } = useI18n();
  // In the tray's bounded scroll region the row pins to its bottom edge (offset
  // by the region's bottom padding), so a long sign-in form never pushes the
  // buttons out of reach.
  return (
    <div
      data-ssh-actions
      className="mt-3 [[data-tray-current]_&]:sticky [[data-tray-current]_&]:-bottom-3 [[data-tray-current]_&]:z-[1] [[data-tray-current]_&]:-mx-1 [[data-tray-current]_&]:-mb-3 [[data-tray-current]_&]:px-1 [[data-tray-current]_&]:border-t [[data-tray-current]_&]:border-hairline [[data-tray-current]_&]:bg-panel [[data-tray-current]_&]:pt-2 [[data-tray-current]_&]:pb-3"
      aria-busy={busy !== null}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <button type="submit" data-ssh-submit className={PRIMARY} disabled={busy !== null || primaryDisabled}>
          {busy === 'approved' ? t('ia.approving') : primaryLabel}
        </button>
        <button type="button" data-ssh-reject className={SECONDARY} disabled={busy !== null} onClick={onReject}>
          {busy === 'rejected' ? t('ia.rejecting') : rejectLabel}
        </button>
      </div>
      {failed ? <p role="alert" className="mt-2 text-[12px] text-danger">{t('ia.sendFailed')}</p> : null}
    </div>
  );
}

/**
 * First login card: connect, optionally with a sign-in. "Use my SSH setup"
 * (agent / key files from ssh config) sends no credential at all.
 */
function ConnectForm({ ssh, toolName, busy, failed, onSubmit }: {
  ssh: SshApprovalInfo;
  toolName: string;
  busy: Decision | null;
  failed: boolean;
  onSubmit: (body: SshApprovalSubmit) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const [method, setMethod] = useState<LoginMethod>('agent');
  const [password, setPassword] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [keyText, setKeyText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [save, setSave] = useState<SaveScope>('workspace');
  // Secrets leave component state as soon as a submission starts.
  const clear = () => { setPassword(''); setKeyText(''); setPassphrase(''); };
  useEffect(() => clear, []);

  const missing = method === 'password' ? password === ''
    : method === 'keyFile' ? keyPath.trim() === ''
    : method === 'keyText' ? keyText.trim() === ''
    : false;

  const credential = (): SshCredential | undefined => {
    if (method === 'agent') return undefined;
    const withPass = passphrase === '' ? {} : { passphrase };
    if (method === 'password') return { password, save };
    if (method === 'keyFile') return { privateKeyPath: keyPath.trim(), ...withPass, save };
    return { privateKeyContents: keyText, ...withPass, save };
  };

  const submit = () => {
    if (missing) return;
    const body: SshApprovalSubmit = { decision: 'approved', ...(credential() === undefined ? {} : { credential: credential()! }) };
    clear();
    onSubmit(body);
  };

  return (
    <form className="mt-3 space-y-3" autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="space-y-1.5">
        <p id={`${uid}-method`} className={LABEL}>{t('ia.ssh.signInWith')}</p>
        <SettingsSegmented<LoginMethod>
          ariaLabelledBy={`${uid}-method`}
          value={method}
          onChange={setMethod}
          dataAttr="data-ssh-method"
          choices={[
            { value: 'agent', label: t('ia.ssh.method.agent') },
            { value: 'password', label: t('ia.ssh.method.password') },
            { value: 'keyFile', label: t('ia.ssh.method.keyFile') },
            { value: 'keyText', label: t('ia.ssh.method.keyText') },
          ]}
        />
        {method === 'agent' ? <p className="text-[12px] leading-4 text-ink-faint">{t('ia.ssh.method.agentHint')}</p> : null}
      </div>

      {method === 'password' ? (
        <div>
          <label htmlFor={`${uid}-password`} className={LABEL}>{t('ia.ssh.passwordFor', { target: `${ssh.user}@${ssh.hostname}` })}</label>
          <input id={`${uid}-password`} data-ssh-password type="password" autoComplete="off" data-autofocus
            className={`${INPUT} mt-1.5 max-w-sm`} value={password} onChange={(event) => { setPassword(event.target.value); }} />
        </div>
      ) : null}
      {method === 'keyFile' ? (
        <div>
          <label htmlFor={`${uid}-keypath`} className={LABEL}>{t('ia.ssh.keyPath')}</label>
          <input id={`${uid}-keypath`} data-ssh-key-path spellCheck={false} className={`${INPUT} mt-1.5 max-w-md font-mono`}
            placeholder="~/.ssh/id_ed25519" value={keyPath} onChange={(event) => { setKeyPath(event.target.value); }} />
        </div>
      ) : null}
      {method === 'keyText' ? (
        <div>
          <label htmlFor={`${uid}-keytext`} className={LABEL}>{t('ia.ssh.keyText')}</label>
          <textarea id={`${uid}-keytext`} data-ssh-key-text rows={3} spellCheck={false} autoComplete="off"
            className={`${INPUT} mt-1.5 resize-y font-mono leading-5`} placeholder={t('ia.ssh.keyTextPlaceholder')}
            value={keyText} onChange={(event) => { setKeyText(event.target.value); }} />
        </div>
      ) : null}
      {method === 'keyFile' || method === 'keyText' ? (
        <div>
          <label htmlFor={`${uid}-pass`} className={LABEL}>{t('ia.ssh.passphrase')}</label>
          <input id={`${uid}-pass`} data-ssh-passphrase type="password" autoComplete="off" className={`${INPUT} mt-1.5 max-w-sm`}
            value={passphrase} onChange={(event) => { setPassphrase(event.target.value); }} />
        </div>
      ) : null}

      {method !== 'agent' ? (
        <div className="space-y-1.5">
          <p id={`${uid}-save`} className={LABEL}>{t('ia.ssh.saveTo')}</p>
          <SettingsSegmented<SaveScope>
            ariaLabelledBy={`${uid}-save`}
            value={save}
            onChange={setSave}
            dataAttr="data-ssh-save"
            choices={[
              { value: 'workspace', label: t('ia.ssh.save.workspace') },
              { value: 'global', label: t('ia.ssh.save.global') },
              { value: 'session', label: t('ia.ssh.save.session') },
            ]}
          />
          <p className="text-[12px] leading-4 text-ink-faint">
            {save === 'session' ? t('ia.ssh.save.sessionHint') : t('ia.ssh.save.storedHint')}
          </p>
        </div>
      ) : null}

      <p className="text-[12px] leading-4 text-ink-faint">{t('ia.ssh.afterApprove', { tool: toolName })}</p>
      <Actions
        busy={busy}
        failed={failed}
        primaryLabel={method === 'agent' ? t('ia.ssh.approve') : t('ia.ssh.signInConnect')}
        primaryDisabled={missing}
        rejectLabel={t('ia.reject')}
        onReject={() => { clear(); onSubmit({ decision: 'rejected' }); }}
      />
    </form>
  );
}

/** One keyboard-interactive round: an answer per prompt, in order. */
function PromptsForm({ ssh, busy, failed, onSubmit }: {
  ssh: SshApprovalInfo;
  busy: Decision | null;
  failed: boolean;
  onSubmit: (body: SshApprovalSubmit) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const prompts = ssh.prompts ?? [];
  const [answers, setAnswers] = useState<string[]>(() => prompts.map(() => ''));
  const firstRef = useRef<HTMLInputElement>(null);
  const missing = prompts.some((_, index) => (answers[index] ?? '') === '');

  return (
    <form className="mt-3 space-y-3" autoComplete="off" onSubmit={(event) => {
      event.preventDefault();
      if (missing) return;
      const body: SshApprovalSubmit = { decision: 'approved', credential: { answers: prompts.map((_, index) => answers[index] ?? '') } };
      setAnswers(prompts.map(() => ''));
      onSubmit(body);
    }}>
      <p className="text-[12px] leading-4 text-ink-faint">{t('ia.ssh.promptsHint')}</p>
      {prompts.map((prompt, index) => (
        <div key={`${index}-${prompt.prompt}`}>
          <label htmlFor={`${uid}-${index}`} className="block font-mono text-[12px] text-ink">{prompt.prompt.trim()}</label>
          <input
            ref={index === 0 ? firstRef : undefined}
            id={`${uid}-${index}`}
            data-ssh-prompt={index}
            data-autofocus={index === 0 ? '' : undefined}
            type={prompt.echo ? 'text' : 'password'}
            autoComplete={prompt.echo ? 'one-time-code' : 'off'}
            inputMode={prompt.echo ? 'numeric' : undefined}
            spellCheck={false}
            className={`${INPUT} mt-1.5 max-w-xs font-mono ${prompt.echo ? 'tabular-nums tracking-[0.12em]' : ''}`}
            value={answers[index] ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setAnswers((current) => current.map((answer, i) => (i === index ? value : answer)));
            }}
          />
        </div>
      ))}
      <Actions busy={busy} failed={failed} primaryLabel={t('ia.ssh.sendAnswer')} primaryDisabled={missing}
        rejectLabel={t('ia.ssh.cancelSignIn')} onReject={() => { onSubmit({ decision: 'rejected' }); }} />
    </form>
  );
}

/** First-seen key. No credential fields; trusting appends to known_hosts. */
function HostKeyForm({ ssh, busy, failed, onSubmit }: {
  ssh: SshApprovalInfo;
  busy: Decision | null;
  failed: boolean;
  onSubmit: (body: SshApprovalSubmit) => void;
}) {
  const { t } = useI18n();
  const fingerprint = ssh.fingerprint ?? '';
  const shown = fingerprint.startsWith('SHA256:') ? fingerprint : `SHA256:${fingerprint}`;
  return (
    <form className="mt-2" onSubmit={(event) => { event.preventDefault(); onSubmit({ decision: 'approved' }); }}>
      <div data-ssh-fingerprint className="rounded-md border border-hairline px-3 py-2">
        <p className="text-[12px] text-ink-faint">{t('ia.ssh.keyFirstSeen', { algorithm: ssh.algorithm ?? '' })}</p>
        <p className="mt-0.5 break-all font-mono text-[13px] leading-5 text-ink">{shown}</p>
      </div>
      <p className="mt-1.5 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('ia.ssh.keyCheckHint')}</p>
      <Actions busy={busy} failed={failed} primaryLabel={t('ia.ssh.trustKey')} rejectLabel={t('ia.ssh.dontTrust')}
        onReject={() => { onSubmit({ decision: 'rejected' }); }} />
    </form>
  );
}
