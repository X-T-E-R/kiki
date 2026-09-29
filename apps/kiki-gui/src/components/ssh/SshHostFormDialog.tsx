/**
 * Add / edit one SSH host. The same dialog serves Settings › SSH hosts and the
 * composer's ＋ › SSH hosts › New host, so a host created mid-conversation is
 * the same record as one created in settings. Only fields the host store
 * accepts are editable; sign-in and per-host approval are drawn disabled
 * until the server can take them.
 */

import { useId, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { SSH_HOSTNAME_PATTERN, SSH_HOST_ID_PATTERN, sshHostInput, type SshHost, type SshHostInput } from '../../lib/ssh';
import { Toggle } from '../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { FieldIssue, FORM_LABEL } from '../settings/SettingsPrimitives';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { ComingSoonTag } from './SshBits';

export type SshHostFormMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly host: SshHost }
  /** A `~/.ssh/config` alias saved as a Kiki host with the same id. */
  | { readonly kind: 'override'; readonly host: SshHost };

interface Draft {
  id: string;
  name: string;
  hostname: string;
  user: string;
  port: string;
  identityFile: string;
  roots: string;
  description: string;
  offered: boolean;
}

function initialDraft(mode: SshHostFormMode): Draft {
  if (mode.kind === 'create') {
    return { id: '', name: '', hostname: '', user: '', port: '', identityFile: '', roots: '', description: '', offered: true };
  }
  const { host } = mode;
  return {
    id: host.id,
    name: host.name === host.id ? '' : host.name,
    hostname: host.hostname ?? '',
    user: host.user ?? '',
    port: host.port === undefined ? '' : String(host.port),
    identityFile: host.identityFile ?? '',
    roots: (host.roots ?? []).join('\n'),
    description: host.description ?? '',
    offered: host.agentAccess !== 'hidden',
  };
}

type Issues = Partial<Record<'id' | 'hostname' | 'port' | 'roots', string>>;

function validate(draft: Draft, t: ReturnType<typeof useI18n>['t']): Issues {
  const issues: Issues = {};
  if (draft.id.trim() === '') issues.id = t('st.ssh.form.aliasRequired');
  else if (!SSH_HOST_ID_PATTERN.test(draft.id.trim())) issues.id = t('st.ssh.form.aliasInvalid');
  if (draft.hostname.trim() !== '' && !SSH_HOSTNAME_PATTERN.test(draft.hostname.trim())) {
    issues.hostname = t('st.ssh.form.hostnameInvalid');
  }
  const port = draft.port.trim();
  if (port !== '' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    issues.port = t('st.ssh.form.portInvalid');
  }
  const badRoot = draft.roots.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line !== '' && (!line.startsWith('/') || line.includes('\\')));
  if (badRoot !== undefined) issues.roots = t('st.ssh.form.rootsInvalid', { path: badRoot });
  return issues;
}

export function SshHostFormDialog({
  mode,
  onClose,
  onSubmit,
}: {
  mode: SshHostFormMode;
  onClose: () => void;
  /** Persist the host; resolve with the saved record, reject to show the error. */
  onSubmit: (id: string, input: SshHostInput) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const uid = useId();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(mode));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const issues = touched ? validate(draft, t) : {};
  const idLocked = mode.kind !== 'create';
  const set = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); setServerError(null); };

  const title = mode.kind === 'create'
    ? t('st.ssh.form.addTitle')
    : mode.kind === 'override'
      ? t('st.ssh.form.overrideTitle', { alias: mode.host.id })
      : t('st.ssh.form.editTitle', { name: mode.host.name });
  const submitLabel = mode.kind === 'create'
    ? t('st.ssh.addHost')
    : mode.kind === 'override' ? t('st.ssh.form.saveOverride') : t('st.ssh.form.saveChanges');

  const submit = async () => {
    setTouched(true);
    if (Object.keys(validate(draft, t)).length > 0) return;
    const id = draft.id.trim();
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit(id, sshHostInput({ ...draft, name: draft.name.trim() === '' ? id : draft.name }));
    } catch (error) {
      setServerError(errorText(locale, error));
      setSaving(false);
    }
  };

  const field = (key: keyof Draft) => `${uid}-${key}`;
  const issueId = (key: keyof Issues) => (issues[key] === undefined ? undefined : `${field(key)}-issue`);

  return (
    <Dialog
      onClose={() => { if (!saving) onClose(); }}
      ariaLabel={title}
      overlayId="ssh-host-form"
      stacked
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-32px)] overflow-y-auto`}
    >
      <form
        data-ssh-host-form={mode.kind}
        noValidate
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <h2 className="font-display text-[18px] leading-6 text-ink">{title}</h2>
        <p className="mt-1 max-w-[62ch] text-[12px] leading-4 text-ink-faint">
          {mode.kind === 'override' ? t('st.ssh.form.overrideHint') : t('st.ssh.form.intro')}
        </p>

        <fieldset disabled={saving} className="mt-5 grid min-w-0 gap-x-4 gap-y-4 sm:grid-cols-2">
          <div>
            <label htmlFor={field('id')} className={FORM_LABEL}>{t('st.ssh.form.alias')}</label>
            <input
              id={field('id')}
              data-autofocus={idLocked ? undefined : ''}
              className={`${INPUT} mt-1.5 font-mono`}
              value={draft.id}
              readOnly={idLocked}
              aria-readonly={idLocked}
              aria-invalid={issues.id !== undefined}
              aria-describedby={issueId('id')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="dev"
              onChange={(event) => { set({ id: event.target.value }); }}
            />
            <FieldIssue id={`${field('id')}-issue`} text={issues.id ?? null} />
          </div>
          <div>
            <label htmlFor={field('name')} className={FORM_LABEL}>{t('st.ssh.form.name')}</label>
            <input
              id={field('name')}
              data-autofocus={idLocked ? '' : undefined}
              className={`${INPUT} mt-1.5`}
              value={draft.name}
              placeholder={draft.id.trim() === '' ? t('st.ssh.form.namePlaceholder') : draft.id.trim()}
              onChange={(event) => { set({ name: event.target.value }); }}
            />
          </div>

          <div className="sm:col-span-2 grid gap-x-4 gap-y-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_6rem]">
            <div>
              <label htmlFor={field('hostname')} className={FORM_LABEL}>{t('st.ssh.form.hostname')}</label>
              <input
                id={field('hostname')}
                className={`${INPUT} mt-1.5 font-mono`}
                value={draft.hostname}
                aria-invalid={issues.hostname !== undefined}
                aria-describedby={issueId('hostname')}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="dev.example.com"
                onChange={(event) => { set({ hostname: event.target.value }); }}
              />
              <FieldIssue id={`${field('hostname')}-issue`} text={issues.hostname ?? null} />
            </div>
            <div>
              <label htmlFor={field('user')} className={FORM_LABEL}>{t('st.ssh.form.user')}</label>
              <input
                id={field('user')}
                className={`${INPUT} mt-1.5 font-mono`}
                value={draft.user}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="deploy"
                onChange={(event) => { set({ user: event.target.value }); }}
              />
            </div>
            <div>
              <label htmlFor={field('port')} className={FORM_LABEL}>{t('st.ssh.form.port')}</label>
              <input
                id={field('port')}
                className={`${INPUT} mt-1.5 font-mono tabular-nums`}
                value={draft.port}
                inputMode="numeric"
                aria-invalid={issues.port !== undefined}
                aria-describedby={issueId('port')}
                placeholder="22"
                onChange={(event) => { set({ port: event.target.value }); }}
              />
              <FieldIssue id={`${field('port')}-issue`} text={issues.port ?? null} />
            </div>
            <p className="-mt-2 text-[12px] leading-4 text-ink-faint sm:col-span-3">{t('st.ssh.form.targetHint')}</p>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={field('identityFile')} className={FORM_LABEL}>{t('st.ssh.form.identityFile')}</label>
            <input
              id={field('identityFile')}
              className={`${INPUT} mt-1.5 font-mono`}
              value={draft.identityFile}
              spellCheck={false}
              placeholder="~/.ssh/id_ed25519"
              aria-describedby={`${field('identityFile')}-hint`}
              onChange={(event) => { set({ identityFile: event.target.value }); }}
            />
            <p id={`${field('identityFile')}-hint`} className="mt-1 text-[12px] leading-4 text-ink-faint">{t('st.ssh.form.identityHint')}</p>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={field('roots')} className={FORM_LABEL}>{t('st.ssh.form.roots')}</label>
            <textarea
              id={field('roots')}
              rows={2}
              className={`${INPUT} mt-1.5 resize-y font-mono leading-5`}
              value={draft.roots}
              spellCheck={false}
              placeholder="/home/deploy/app"
              aria-invalid={issues.roots !== undefined}
              aria-describedby={issues.roots === undefined ? `${field('roots')}-hint` : issueId('roots')}
              onChange={(event) => { set({ roots: event.target.value }); }}
            />
            {issues.roots === undefined
              ? <p id={`${field('roots')}-hint`} className="mt-1 text-[12px] leading-4 text-ink-faint">{t('st.ssh.form.rootsHint')}</p>
              : <FieldIssue id={`${field('roots')}-issue`} text={issues.roots} />}
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={field('description')} className={FORM_LABEL}>{t('st.ssh.form.description')}</label>
            <input
              id={field('description')}
              className={`${INPUT} mt-1.5`}
              value={draft.description}
              placeholder={t('st.ssh.form.descriptionPlaceholder')}
              onChange={(event) => { set({ description: event.target.value }); }}
            />
          </div>

          <div className="sm:col-span-2 space-y-0.5">
            <Toggle layout="row" label={t('st.ssh.form.offered')} checked={draft.offered}
              onChange={(offered) => { set({ offered }); }} />
            <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.ssh.form.offeredHint')}</p>
          </div>
        </fieldset>

        {/* Not wired yet: drawn so the shape of the form is honest about what is coming. */}
        <div data-ssh-form-coming-soon className="mt-5 space-y-2 border-t border-hairline pt-4">
          <div className="flex items-start justify-between gap-4" aria-disabled="true">
            <div className="min-w-0">
              <p className="text-[13px] text-ink-faint">{t('st.ssh.form.signIn')}</p>
              <p className="text-[12px] leading-4 text-ink-faint">{t('st.ssh.form.signInHint')}</p>
            </div>
            <ComingSoonTag />
          </div>
          <div className="flex items-start justify-between gap-4" aria-disabled="true">
            <div className="min-w-0">
              <p className="text-[13px] text-ink-faint">{t('st.ssh.form.alwaysAsk')}</p>
              <p className="text-[12px] leading-4 text-ink-faint">{t('st.ssh.form.alwaysAskHint')}</p>
            </div>
            <ComingSoonTag />
          </div>
        </div>

        {serverError !== null ? (
          <p role="alert" data-ssh-form-error className="mt-4 text-[12px] leading-4 text-danger">{serverError}</p>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" data-ssh-form-submit className={PRIMARY_BUTTON} disabled={saving}>
            {saving ? t('common.saving') : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
