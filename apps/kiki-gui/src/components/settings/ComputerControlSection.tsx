/**
 * Settings → 电脑控制. Three flat blocks in the order a person decides:
 *
 *   A  which server this drives (its real platform/arch) and a re-check
 *   B  whether the open-source executor is installed, with the install plan
 *   C  the existing computer MCP connections — list, then one editor
 *
 * Nothing here is predicted: the machine line is the connected server's own
 * `platform`/`arch`, the readiness line is the capability service's state, and
 * the configuration block reads and writes the same global MCP plane the MCP
 * page uses. "Installed" means the pinned executor files verified — it is not
 * a claim that the desktop is being controlled or that it is idle.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import type { CapabilityStatus } from '../../lib/client';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import { ComputerConnectionCard } from './computerControl/ComputerConnectionCard';
import { platformDisplay } from './computerControl/computerMcp';

const CAPABILITY_ID = 'kiki-computer';

/**
 * Step ids the capability reports, in the state words the capability UIs
 * already use (`st.plugins.runtimeStepState.*`). An id this page does not know
 * is printed as the service sent it rather than swallowed.
 */
const STEP_KEYS: Readonly<Record<string, I18nKey>> = {
  binary: 'st.computer.step.binary',
  mcp: 'st.computer.step.mcp',
  'desktop-access': 'st.computer.step.desktopAccess',
  permissions: 'st.computer.step.permissions',
  runtime: 'st.computer.step.runtime',
};

const STATE_KEYS: Readonly<Record<CapabilityStatus['state'], I18nKey>> = {
  not_installed: 'st.computer.state.notInstalled',
  partial: 'st.computer.state.partial',
  ready: 'st.computer.state.installed',
  unsupported: 'st.computer.state.unsupported',
};

export function ComputerControlSection() {
  const { client, klient, scopeId, sshLabel } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();

  const envQuery = useQuery({
    queryKey: ['computer-control-env', scopeId],
    queryFn: () => klient.global.env(),
    staleTime: Infinity,
  });
  const capabilityQuery = useQuery({
    queryKey: ['capability', CAPABILITY_ID, scopeId],
    queryFn: () => client.getCapability(CAPABILITY_ID),
    refetchInterval: (result) => result.state.data?.install.running === true ? 1_000 : false,
  });

  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const capability = capabilityQuery.data;
  const platform = envQuery.data?.platform;
  const serverFacts = [platformDisplay(platform), envQuery.data?.arch]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');

  const reportFailure = (error: unknown) => {
    setFeedback({ tone: 'error', text: errorText(locale, error) });
  };

  const check = async () => {
    setChecking(true);
    setFeedback(null);
    try {
      await capabilityQuery.refetch();
    } catch (error) {
      reportFailure(error);
    } finally {
      setChecking(false);
    }
  };

  const install = async (status: CapabilityStatus) => {
    const digest = status.plan?.artifact.sha256;
    setConfirmingInstall(false);
    if (digest === undefined) return;
    setInstalling(true);
    setFeedback(null);
    try {
      const next = await client.installCapability(status.id, digest);
      queryClient.setQueryData(['capability', CAPABILITY_ID, scopeId], next);
      // A completed install registers the global connection itself, so the
      // configuration block below has to re-read rather than keep its list.
      await queryClient.invalidateQueries({ queryKey: ['computer-control-mcp', scopeId] });
      setFeedback({ tone: 'success', text: t('st.computer.installDone', { version: status.plan?.artifact.version ?? '' }) });
    } catch (error) {
      reportFailure(error);
    } finally {
      setInstalling(false);
    }
  };

  const installError = capability?.install.error;
  const optionalUnchecked = capability?.steps.some((step) => step.optional === true && step.state !== 'ok') === true;

  return (
    <div className="space-y-6" data-settings-computer-control>
      {/* A — the machine this drives, and how to re-check it */}
      <SectionCard id="st-card-computer-machine" title={t('st.computer.title')}>
        <div className="space-y-3">
          <SettingField label={t('st.computer.machineLabel')} labelId="computer-machine-label">
            <span className="font-mono text-[12px] text-ink" data-computer-platform>
              {serverFacts === '' ? t('st.computer.machineUnknown') : serverFacts}
            </span>
            <button type="button" className={SECONDARY_BUTTON} data-computer-check-btn
              disabled={checking}
              onClick={() => { void check(); }}>
              {checking ? t('st.computer.checking') : t('st.computer.recheckButton')}
            </button>
          </SettingField>
          <Hint>
            {sshLabel === null
              ? t('st.computer.machineHint')
              : t('st.computer.machineHintSsh', { label: sshLabel })}
          </Hint>
          {envQuery.isError ? <InlineError error={envQuery.error} /> : null}
        </div>
      </SectionCard>

      {/* B — executor installation: one state line, details folded */}
      <SectionCard id="st-card-computer-setup" title={t('st.computer.setupTitle')}>
        <div className="space-y-3">
          {capabilityQuery.isPending ? (
            <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-state="detecting">
              <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
              {t('st.computer.state.detecting')}
            </p>
          ) : capabilityQuery.isError || capability === undefined ? (
            <div className="space-y-2" data-computer-state="failed">
              <p className="text-[12px] text-danger" role="alert">{t('st.computer.state.failed')}</p>
              <InlineError error={capabilityQuery.error} />
              <button type="button" className={SECONDARY_BUTTON} data-computer-retry
                onClick={() => { void check(); }}>
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <>
              <SettingField label={t('st.computer.statusLabel')} labelId="computer-state-label">
                <span className="text-[13px] text-ink" data-computer-state={capability.state}>
                  {t(STATE_KEYS[capability.state])}
                </span>
                {capability.version !== undefined ? (
                  <span className="font-mono text-[11px] text-ink-faint" data-computer-version>v{capability.version}</span>
                ) : null}
                {capability.state !== 'ready' && !capability.install.running && capability.plan !== undefined ? (
                  <button type="button" className={PRIMARY_BUTTON} data-computer-install-btn
                    disabled={installing}
                    onClick={() => { setConfirmingInstall(true); }}>
                    {installing ? t('st.computer.installing') : installError === undefined ? t('st.computer.installButton') : t('st.computer.retryInstall')}
                  </button>
                ) : null}
              </SettingField>

              {capability.state === 'ready' ? <Hint>{t('st.computer.installedHint')}</Hint> : null}
              {capability.state === 'ready' && optionalUnchecked ? <Hint>{t('st.computer.optionalUnverified')}</Hint> : null}
              {capability.state === 'ready' && platform === 'darwin' ? <Hint>{t('st.computer.macPermissions')}</Hint> : null}

              {capability.install.running ? (
                <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-installing>
                  <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
                  {capability.install.step ?? t('st.computer.installing')}
                  {capability.install.percent === undefined ? null : ` · ${Math.round(capability.install.percent)}%`}
                </p>
              ) : null}
              {installError !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: installError }} /> : null}
              {capability.install.note !== undefined ? (
                <p className="text-[11px] text-ink-soft" data-computer-install-note>{capability.install.note}</p>
              ) : null}

              {capability.steps.length > 0 ? (
                <AdvancedDetails summary={t('st.computer.details')} data-computer-steps>
                  <ul className="space-y-1">
                    {capability.steps.map((step) => (
                      <li className="text-[11px] text-ink-soft" key={step.id} data-computer-step={step.id}
                        data-computer-step-kind={step.optional === true ? 'optional' : 'required'}>
                        {(STEP_KEYS[step.id] === undefined ? step.id : t(STEP_KEYS[step.id]!))}
                        {' · '}
                        {step.optional === true ? `${t('st.plugins.optional')} · ` : ''}
                        {t(`st.plugins.runtimeStepState.${step.state}`)}
                        {step.detail === undefined ? '' : ` · ${step.detail}`}
                      </li>
                    ))}
                  </ul>
                </AdvancedDetails>
              ) : null}
            </>
          )}

          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      {/* C / D / E — the connections themselves */}
      <SectionCard id="st-card-computer-mcp" title={t('st.computer.connectionsTitle')}>
        <div className="space-y-3">
          <Hint>{t('st.computer.connectionsHint')}</Hint>
          <ComputerConnectionCard
            platform={platform}
            planBinary={capability?.plan?.destination}
          />
        </div>
      </SectionCard>

      {confirmingInstall && capability?.plan !== undefined ? (
        <ConfirmDialog
          open
          overlayId="confirm-computer-install"
          title={t('st.computer.installConfirmTitle')}
          body={t('st.computer.installConfirmBody')}
          consequences={[
            `v${capability.plan.artifact.version} · ${capability.plan.artifact.url}`,
            `SHA-256 ${capability.plan.artifact.sha256}`,
            capability.plan.destination,
            capability.plan.note,
          ]}
          confirmLabel={t('st.computer.installButton')}
          tone="default"
          busy={installing}
          onCancel={() => { setConfirmingInstall(false); }}
          onConfirm={() => { void install(capability); }}
        />
      ) : null}
    </div>
  );
}
