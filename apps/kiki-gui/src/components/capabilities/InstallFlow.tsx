/**
 * Install consent — preview first, consent only when it matters, then install.
 *
 * The contract (`POST /plugins:preview` → `POST /plugins`) never runs plugin
 * code before consent and pins the exact candidate by fingerprint. The sheet
 * stays light: a plugin with no permissions (a theme pack) installs with one
 * click; one that declares permissions lists what it will be able to do in
 * the user's terms and asks once. A declared prerequisite binary (Office's
 * OfficeCLI) is named up front and installed as its own, separate consent
 * after the plugin itself — installing the plugin never downloads it.
 *
 * A new plugin lands disabled on the server; this flow enables it right after
 * install because the user just asked for it.
 */

import { useEffect, useRef, useState } from 'react';

import type { PluginInstallPlan } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { PluginMarketplaceEntry } from '../../lib/client';
import { hasAnyPermission, planContributionGroups, pluginPrerequisites, type PluginPermissionsView, type PluginPrerequisiteView } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { Icon, Spinner } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { CapabilityIcon } from './CapabilityIcon';
import { Disclosure, FactList } from './primitives';
import { PermissionList } from './PermissionList';
import { useInvalidatePlugins } from './usePlugins';

export interface InstallRequest {
  readonly source: string;
  readonly sha256?: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly entry?: PluginMarketplaceEntry;
  /** Prerequisites already known from the catalog/detail, shown in the sheet. */
  readonly prerequisites?: readonly PluginPrerequisiteView[];
}

type Phase =
  | { readonly kind: 'previewing' }
  | { readonly kind: 'ready'; readonly plan: PluginInstallPlan }
  | { readonly kind: 'installing'; readonly plan: PluginInstallPlan }
  | { readonly kind: 'failed'; readonly message: string; readonly plan?: PluginInstallPlan }
  | { readonly kind: 'done'; readonly pluginId: string; readonly plan: PluginInstallPlan; readonly prerequisites: readonly PluginPrerequisiteView[] };

export function InstallFlow({
  request,
  onClose,
  onInstalled,
}: {
  readonly request: InstallRequest;
  readonly onClose: () => void;
  readonly onInstalled?: (pluginId: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const invalidate = useInvalidatePlugins();
  const [phase, setPhase] = useState<Phase>({ kind: 'previewing' });
  const [advanced, setAdvanced] = useState(false);
  const [prereq, setPrereq] = useState<{ id: string; state: 'idle' | 'running' | 'done' | 'failed'; message?: string } | null>(null);
  const revision = useRef(0);

  const runPreview = async () => {
    const current = ++revision.current;
    setPhase({ kind: 'previewing' });
    try {
      const plan = await client.previewPlugin(request.source, request.sha256);
      if (revision.current === current) setPhase({ kind: 'ready', plan });
    } catch (error) {
      if (revision.current === current) setPhase({ kind: 'failed', message: errorText(locale, error) });
    }
  };

  useEffect(() => {
    void runPreview();
    return () => { revision.current++; };
    // A new request opens a new sheet; the preview runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (plan: PluginInstallPlan) => {
    setPhase({ kind: 'installing', plan });
    try {
      const installed = await client.installPreviewedPlugin({
        source: request.source,
        sha256: request.sha256,
        fingerprint: plan.fingerprint,
        consent: plan.consentRequired,
      });
      await client.setPluginEnabled(installed.id, true);
      await invalidate();
      // The preview plan does not carry prerequisites; the installed manifest does.
      const info = await client.getPlugin(installed.id).catch(() => undefined);
      const declared = info === undefined ? [] : pluginPrerequisites(info, info.manifest as Readonly<Record<string, unknown>> | undefined);
      setPhase({ kind: 'done', pluginId: installed.id, plan, prerequisites: declared.filter((item) => item.kind === 'executable') });
      onInstalled?.(installed.id);
    } catch (error) {
      setPhase({ kind: 'failed', message: errorText(locale, error), plan });
    }
  };

  const installPrerequisite = async (pluginId: string, id: string) => {
    setPrereq({ id, state: 'running' });
    try {
      await client.installPluginPrerequisite(pluginId, id);
      await invalidate();
      setPrereq({ id, state: 'done' });
    } catch (error) {
      setPrereq({ id, state: 'failed', message: errorText(locale, error) });
    }
  };

  const plan = phase.kind === 'previewing' ? undefined : phase.plan;
  const permissions: PluginPermissionsView | undefined = plan?.permissions;
  const needsConsent = plan?.consentRequired === true;
  const prerequisites = (request.prerequisites ?? []).filter((item) => item.kind === 'executable');
  const busy = phase.kind === 'installing';
  const title = t('cap.install.title', { name: request.displayName });

  return (
    <Dialog
      onClose={() => { if (!busy) onClose(); }}
      ariaLabel={title}
      overlayId="capability-install"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm} max-h-[min(92vh,760px)] overflow-y-auto`}
      overlayData={{ 'data-install-flow': phase.kind }}
    >
      <div className="flex items-start gap-3">
        <CapabilityIcon icon={request.icon} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[18px] leading-6 text-ink">{title}</h2>
          <p className="mt-0.5 truncate text-[12px] text-ink-faint">
            {plan?.version !== undefined ? `v${plan.version} · ` : ''}
            {request.entry?.tier === 'official' ? t('cap.tier.official')
              : request.entry?.tier === 'curated' ? t('cap.tier.curated')
                : t('cap.tier.thirdParty')}
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-5 text-[13px]">
        {phase.kind === 'previewing' ? (
          <p className="flex items-center gap-2 text-ink-soft" role="status">
            <Spinner label={t('cap.install.previewing')} />
            {t('cap.install.previewing')}
          </p>
        ) : null}

        {plan !== undefined && phase.kind !== 'done' ? (
          <>
            <div data-install-contributes>
              <p className="text-[12px] font-medium text-ink-soft">{t('cap.install.adds')}</p>
              <ul className="mt-1.5 space-y-1">
                {planContributionGroups(plan.contributions).map((group) => (
                  <li key={group.kind} className="flex gap-2 text-ink">
                    <span className="text-ink-faint"><Icon name="dot" size={12} /></span>
                    <span className="min-w-0">
                      {contributionLabel(t, group.kind, group.names.length)}
                      {group.names.some((name) => name !== '') ? (
                        <span className="text-ink-faint"> · <span className="font-mono text-[12px]">{group.names.filter((name) => name !== '').join(', ')}</span></span>
                      ) : null}
                    </span>
                  </li>
                ))}
                {plan.contributions.length === 0 ? <li className="text-ink-faint">{t('cap.install.addsNothing')}</li> : null}
              </ul>
            </div>

            {hasAnyPermission(permissions) ? (
              <div data-install-permissions>
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.install.canDo')}</p>
                <PermissionList permissions={permissions!} className="mt-1.5" />
              </div>
            ) : (
              <p className="text-ink-soft" data-install-no-permissions>{t('cap.install.noPermissions')}</p>
            )}

            {prerequisites.length > 0 ? (
              <div data-install-prerequisites>
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.install.needs')}</p>
                <ul className="mt-1.5 space-y-1">
                  {prerequisites.map((item) => (
                    <li key={item.id} className="text-ink">
                      <span className="font-mono text-[12px]">{item.id}</span>
                      {item.version !== undefined ? <span className="text-ink-faint"> {item.version}</span> : null}
                      <span className="text-ink-faint"> · {t('cap.install.needsLater')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {plan.changes.length > 0 ? (
              <div data-install-changes>
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.install.changes')}</p>
                <ul className="mt-1.5 space-y-0.5 font-mono text-[12px] text-ink-soft">
                  {plan.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
              </div>
            ) : null}

            <Disclosure label={t('cap.advanced')} open={advanced} onToggle={() => { setAdvanced((value) => !value); }} dataAttrs={{ 'data-install-advanced': '' }}>
              <FactList
                items={[
                  { label: t('cap.detail.source'), value: request.source, mono: true },
                  { label: t('cap.install.fingerprint'), value: plan.fingerprint.slice(0, 16), mono: true },
                  { label: t('cap.install.context'), value: t('cap.install.contextValue', { count: plan.contextTokens }) },
                  ...(plan.unsupported.length > 0
                    ? [{ label: t('cap.install.unsupported'), value: plan.unsupported.join(', '), mono: true }]
                    : []),
                ]}
              />
              <p className="mt-2 text-[12px] leading-4 text-ink-faint">{t('cap.install.approvalNote')}</p>
            </Disclosure>
          </>
        ) : null}

        {phase.kind === 'done' ? (
          <div className="space-y-4" data-install-done>
            <p className="flex items-center gap-2 text-ink" role="status">
              <span className="text-success"><Icon name="check" size={14} /></span>
              {t('cap.install.done', { name: request.displayName })}
            </p>
            {(phase.prerequisites.length > 0 ? phase.prerequisites : prerequisites).map((item) => (
              <div key={item.id} className="rounded-lg bg-ink/[0.03] px-3 py-3" data-install-prerequisite={item.id}>
                <p className="text-ink">{t('cap.prereq.title', { id: item.id })}</p>
                <p className="mt-1 text-[12px] leading-4 text-ink-faint">
                  {t('cap.prereq.body', { id: item.id, version: item.version ?? '' })}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {prereq?.id === item.id && prereq.state === 'done' ? (
                    <span className="text-[12px] text-ink-soft" role="status">{t('cap.prereq.done')}</span>
                  ) : (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={prereq?.state === 'running'}
                      data-install-prerequisite-action={item.id}
                      onClick={() => { void installPrerequisite(phase.pluginId, item.id); }}
                    >
                      {prereq?.id === item.id && prereq.state === 'running'
                        ? t('cap.prereq.installing')
                        : t('cap.prereq.action', { id: item.id })}
                    </button>
                  )}
                </div>
                {prereq?.id === item.id && prereq.state === 'failed' ? (
                  <p role="alert" className="mt-2 text-[12px] text-danger">{prereq.message}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {phase.kind === 'failed' ? (
          <p role="alert" className="text-[13px] text-danger" data-install-error>{phase.message}</p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {phase.kind === 'done' ? (
          <button type="button" className={PRIMARY_BUTTON} data-autofocus onClick={onClose}>{t('cap.install.finish')}</button>
        ) : (
          <>
            <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
            {phase.kind === 'failed' && phase.plan === undefined ? (
              <button type="button" className={PRIMARY_BUTTON} onClick={() => { void runPreview(); }}>{t('common.retry')}</button>
            ) : (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                data-autofocus
                data-install-confirm
                disabled={plan === undefined || busy}
                onClick={() => { if (plan !== undefined) void install(plan); }}
              >
                {busy ? t('cap.install.installing') : needsConsent ? t('cap.install.allow') : t('cap.install.confirm')}
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function contributionLabel(t: ReturnType<typeof useI18n>['t'], kind: string, count: number): string {
  switch (kind) {
    case 'tool': return t('cap.contrib.tools', { count });
    case 'panel': return t('cap.contrib.panels', { count });
    case 'command': return t('cap.contrib.commands', { count });
    case 'theme': return t('cap.contrib.themes', { count });
    case 'skill': return t('cap.contrib.skills', { count });
    case 'mcp': return t('cap.contrib.mcp', { count });
    case 'hook': return t('cap.contrib.hooks', { count });
    case 'provider': return t('cap.contrib.providers', { count });
    case 'agent': return t('cap.contrib.agents', { count });
    case 'settings': return t('cap.contrib.settings');
    default: return kind;
  }
}

export { contributionLabel };
