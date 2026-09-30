/**
 * "Use Kiki from other agents": installs the builtin `kiki-as-subagent` skill
 * into another agent host's user skills folder. Two steps, never one: the
 * preview names the exact file and whether it already exists; only the
 * confirm writes, pinned to the previewed `revision`. A target that changed
 * in between comes back as 40001 and the dialog asks for a fresh preview.
 */

import { useEffect, useState } from 'react';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { API_CODES, ApiError, type HostSkillInstallPreview, type HostSkillTarget } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { Hint } from '../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { Icon, Spinner } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';

const HOSTS: readonly { readonly id: HostSkillTarget; readonly name: I18nKey; readonly folder: string }[] = [
  { id: 'claude', name: 'st.hostSkill.host.claude', folder: '~/.claude/skills' },
  { id: 'codex', name: 'st.hostSkill.host.codex', folder: '~/.codex/skills' },
  { id: 'grok', name: 'st.hostSkill.host.grok', folder: '~/.grok/skills' },
  { id: 'agents', name: 'st.hostSkill.host.agents', folder: '~/.agents/skills' },
];

type Phase =
  | { readonly kind: 'previewing' }
  | { readonly kind: 'ready'; readonly preview: HostSkillInstallPreview }
  | { readonly kind: 'installing'; readonly preview: HostSkillInstallPreview }
  /** `stale`: the target changed after the preview; only a new preview can continue. */
  | { readonly kind: 'failed'; readonly message: string; readonly stale: boolean; readonly preview?: HostSkillInstallPreview };

export function HostSkillInstallCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState<HostSkillTarget | null>(null);
  const [installed, setInstalled] = useState<Partial<Record<HostSkillTarget, string>>>({});
  return (
    <SectionCard id="st-card-host-skill" title={t('st.hostSkill.title')}>
      <div className="space-y-3" data-host-skill-card>
        <Hint>{t('st.hostSkill.intro')}</Hint>
        <div className="space-y-1">
          {HOSTS.map((host) => (
            <SettingField
              key={host.id}
              label={t(host.name)}
              help={installed[host.id] !== undefined ? (
                <span className="inline-flex min-w-0 items-center gap-1" data-host-skill-installed={host.id}>
                  <Icon name="check" size={12} className="shrink-0 text-success" />
                  <span className="truncate font-mono text-[11px]" title={installed[host.id]}>{installed[host.id]}</span>
                </span>
              ) : <span className="font-mono text-[11px]">{host.folder}</span>}
            >
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-host-skill-preview={host.id}
                aria-label={t('st.hostSkill.previewNamed', { host: t(host.name) })}
                onClick={() => { setOpen(host.id); }}
              >
                {installed[host.id] !== undefined ? t('st.hostSkill.reinstall') : t('st.hostSkill.preview')}
              </button>
            </SettingField>
          ))}
        </div>
      </div>
      {open !== null ? (
        <HostSkillInstallDialog
          host={open}
          hostName={t(HOSTS.find((host) => host.id === open)!.name)}
          onClose={() => { setOpen(null); }}
          onInstalled={(result) => {
            setInstalled((current) => ({ ...current, [open]: result.path }));
            setOpen(null);
          }}
        />
      ) : null}
    </SectionCard>
  );
}
function HostSkillInstallDialog({ host, hostName, onClose, onInstalled }: {
  readonly host: HostSkillTarget;
  readonly hostName: string;
  readonly onClose: () => void;
  readonly onInstalled: (result: HostSkillInstallPreview) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'previewing' });

  const preview = async () => {
    setPhase({ kind: 'previewing' });
    try {
      setPhase({ kind: 'ready', preview: await client.previewHostSkillInstall(host) });
    } catch (error) {
      setPhase({ kind: 'failed', message: errorText(locale, error), stale: false });
    }
  };
  useEffect(() => {
    void preview();
    // One preview per opened dialog; a re-preview is an explicit button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (target: HostSkillInstallPreview) => {
    setPhase({ kind: 'installing', preview: target });
    try {
      onInstalled(await client.installHostSkill(host, target.revision));
    } catch (error) {
      const stale = error instanceof ApiError && error.code === API_CODES.REQUEST_INVALID;
      setPhase({ kind: 'failed', message: stale ? t('st.hostSkill.stale') : errorText(locale, error), stale, preview: target });
    }
  };

  const shown = phase.kind === 'previewing' ? undefined : phase.preview;
  const busy = phase.kind === 'installing';
  const title = t('st.hostSkill.dialogTitle', { host: hostName });
  return (
    <Dialog
      onClose={() => { if (!busy) onClose(); }}
      ariaLabel={title}
      overlayId="host-skill-install"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm}`}
      overlayData={{ 'data-host-skill-dialog': phase.kind }}
    >
      <h2 className="font-display text-[18px] leading-6 text-ink">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-5 text-ink-soft">{t('st.hostSkill.dialogBody')}</p>

      <div className="mt-5 min-h-[88px] text-[13px]">
        {phase.kind === 'previewing' ? (
          <p className="flex items-center gap-2 text-ink-soft" role="status">
            <Spinner label={t('st.hostSkill.previewing')} />
            {t('st.hostSkill.previewing')}
          </p>
        ) : null}
        {shown !== undefined ? (
          <dl className="space-y-3" data-host-skill-target>
            <div>
              <dt className="text-[12px] font-medium text-ink-soft">{t('st.hostSkill.file')}</dt>
              <dd className="mt-1 break-all rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] leading-5 text-ink" data-host-skill-path>{shown.path}</dd>
            </div>
            <div>
              <dt className="sr-only">{t('st.hostSkill.existing')}</dt>
              <dd
                className={`flex items-start gap-1.5 leading-5 ${shown.overwrites ? 'text-amber-ink' : 'text-ink-soft'}`}
                data-host-skill-overwrites={shown.overwrites ? 'true' : 'false'}
              >
                {shown.overwrites ? <Icon name="warning" size={12} className="mt-[4px] shrink-0" /> : null}
                {shown.overwrites ? t('st.hostSkill.overwrites') : t('st.hostSkill.creates')}
              </dd>
            </div>
          </dl>
        ) : null}
        {phase.kind === 'failed' ? (
          <p role="alert" className="mt-3 text-[13px] leading-5 text-danger" data-host-skill-error={phase.stale ? 'stale' : 'failed'}>{phase.message}</p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        {phase.kind === 'failed' && (phase.stale || phase.preview === undefined) ? (
          <button type="button" className={PRIMARY_BUTTON} data-autofocus data-host-skill-repreview onClick={() => { void preview(); }}>
            {t('st.hostSkill.previewAgain')}
          </button>
        ) : (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            data-autofocus
            data-host-skill-confirm
            disabled={shown === undefined || busy}
            onClick={() => { if (shown !== undefined) void install(shown); }}
          >
            {busy ? t('st.hostSkill.installing') : shown?.overwrites === true ? t('st.hostSkill.replace') : t('st.hostSkill.install')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
