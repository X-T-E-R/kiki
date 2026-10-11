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
 * A new plugin lands with the master switch on, and where it is *available* is
 * a second, explicit choice, because "installed" and "on everywhere" are
 * different facts and a reader who wanted one cannot undo the other by
 * accident. The sheet offers the global default they want:
 *
 *   Everywhere    on by default in every workspace and conversation.
 *   Decide later  global default off, master still on, so the plugin is
 *                 installed and usable the moment any scope turns it on.
 *
 * Arrive from a workspace and a third option joins them: install with the
 * global default off and write a workspace `on`, so no other workspace moves.
 * That follow-up is a *usage* write rather than a second install, and it is
 * recorded on its own: a failed enable retries only the enable, never the
 * install.
 *
 * An update (`request.update`) reuses the same sheet: it lists what changed,
 * asks again only when the preview says consent is required, and leaves every
 * switch exactly as it was.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

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
import { PermissionBoundary, PermissionList } from './PermissionList';
import { useInvalidatePlugins } from './usePlugins';

export interface InstallRequest {
  readonly source: string;
  readonly sha256?: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly entry?: PluginMarketplaceEntry;
  /** Prerequisites already known from the catalog/detail, shown in the sheet. */
  readonly prerequisites?: readonly PluginPrerequisiteView[];
  /** The workspace this install is being made on behalf of, when it was
   *  opened from one. It adds "this workspace only" to the choice; a surface
   *  with no workspace to speak of (the rail, the market) never offers it. */
  readonly scope?: {
    readonly kind: 'workspace';
    readonly target: { readonly workspace_id: string };
    /** Server's own name for it, so the option can name it. */
    readonly name: string;
  };
  /** Set when this replaces an installed copy. */
  readonly update?: {
    readonly fromVersion?: string;
    /** A moved GitHub branch: its name and new head, when versions do not differ. */
    readonly branch?: { readonly name: string; readonly commit: string };
    /** The switch state to keep; an update never turns a plugin on. */
    readonly enabled: boolean;
  };
}

/**
 * What an install leaves behind. `later` and `workspace` both leave the global
 * default off; only `workspace` then writes a `on`, and only for one workspace.
 * The master switch is on for all three, which is what makes "decide later" a
 * deferral rather than a refusal.
 */
export type InstallScopeChoice = 'global' | 'later' | 'workspace';

/** Where a post-install enable still has to land, so a retry never reinstalls. */
interface InstalledOutcome {
  readonly pluginId: string;
  readonly pendingEnable?: { readonly workspaceId: string };
}

type Phase =
  | { readonly kind: 'previewing' }
  | { readonly kind: 'ready'; readonly plan: PluginInstallPlan }
  | { readonly kind: 'installing'; readonly plan: PluginInstallPlan }
  | { readonly kind: 'failed'; readonly message: string; readonly plan?: PluginInstallPlan }
  | { readonly kind: 'done'; readonly installed: InstalledOutcome; readonly plan: PluginInstallPlan; readonly choice: InstallScopeChoice; readonly prerequisites: readonly PluginPrerequisiteView[] }
  /** Installed, but the workspace `on` that should have followed it did not land. */
  | { readonly kind: 'enableFailed'; readonly installed: InstalledOutcome; readonly plan: PluginInstallPlan; readonly choice: InstallScopeChoice; readonly message: string };

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
  // The choice is the reader's, never inferred from where they came from:
  // arriving from a workspace offers it as an option, not as the default.
  const [choice, setChoice] = useState<InstallScopeChoice>('global');
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

  const install = async (plan: PluginInstallPlan, chosen: InstallScopeChoice) => {
    setPhase({ kind: 'installing', plan });
    // The installed id is captured the moment it exists, because everything
    // after that point is a different job: the sheet has to be able to say
    // "installed, but the switch did not land" instead of inviting a second
    // install of a plugin that is already here.
    let installedId: string | undefined;
    try {
      const installed = await client.installPreviewedPlugin({
        source: request.source,
        sha256: request.sha256,
        fingerprint: plan.fingerprint,
        consent: plan.consentRequired,
        // The master switch is on either way; the global default is the only
        // thing the choice decides. An update carries no choice, so it sends
        // none and leaves every switch as it was.
        ...(request.update === undefined ? { defaultEnabled: chosen === 'global' } : {}),
      });
      installedId = installed.id;
      await invalidate({ code: true });
      // The preview plan does not carry prerequisites; the installed manifest does.
      const info = await client.getPlugin(installed.id).catch(() => undefined);
      const declared = info === undefined ? [] : pluginPrerequisites(info, info.manifest as Readonly<Record<string, unknown>> | undefined);
      const prerequisites = declared.filter((item) => item.kind === 'executable');
      // Only a workspace scope leaves an `on` to write, and only for itself. A
      // rail or market install never writes one.
      const pendingEnable = chosen === 'workspace' && request.scope !== undefined
        ? { workspaceId: request.scope.target.workspace_id }
        : undefined;
      const outcome: InstalledOutcome = {
        pluginId: installed.id,
        ...(pendingEnable !== undefined ? { pendingEnable } : {}),
      };
      setPhase({ kind: 'done', installed: outcome, plan, choice: chosen, prerequisites });
      onInstalled?.(installed.id);
      if (pendingEnable !== undefined) await enableInWorkspace(installed.id, pendingEnable.workspaceId, outcome, plan, chosen);
    } catch (error) {
      // An id in hand means the plugin IS installed and only the switch failed,
      // which is recoverable without touching the installer again.
      if (installedId !== undefined) {
        setPhase({ kind: 'enableFailed', installed: { pluginId: installedId }, plan, choice: chosen, message: errorText(locale, error) });
        return;
      }
      setPhase({ kind: 'failed', message: errorText(locale, error), plan });
    }
  };

  /**
   * Turn the freshly installed plugin on for the workspace this sheet was
   * opened from. Kept apart from `install` on purpose: at this point the plugin
   * is already installed, so a failure here is a failed enable and nothing
   * else, and the sheet says exactly that instead of offering to reinstall.
   */
  const enableInWorkspace = async (
    pluginId: string,
    workspaceId: string,
    outcome: InstalledOutcome,
    plan: PluginInstallPlan,
    chosen: InstallScopeChoice,
  ) => {
    try {
      await client.setPluginUsage({ target: { workspace_id: workspaceId }, plugin_id: pluginId, override: 'on' });
      await invalidate();
      // A retry that works returns the sheet to its finished state, so the
      // reader is not left staring at an error for something already fixed.
      setPhase((current) => current.kind === 'enableFailed' && current.installed.pluginId === pluginId
        ? { kind: 'done', installed: current.installed, plan: current.plan, choice: current.choice, prerequisites: [] }
        : current);
    } catch (error) {
      setPhase({ kind: 'enableFailed', installed: outcome, plan, choice: chosen, message: errorText(locale, error) });
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
  /**
   * The preview's own answer to "is this an app service": a plugin that runs as
   * one home-level background service rather than a process per workspace. It
   * is a fact the plan carries (`activation: 'app'`), not something deduced
   * here, and it is false for every ordinary plugin.
   */
  const appService = plan?.appService === true;
  const permissions: PluginPermissionsView | undefined = plan?.permissions;
  const needsConsent = plan?.consentRequired === true;
  const prerequisites = (request.prerequisites ?? []).filter((item) => item.kind === 'executable');
  const busy = phase.kind === 'installing';
  const updating = request.update !== undefined;
  const title = updating ? t('cap.update.title', { name: request.displayName }) : t('cap.install.title', { name: request.displayName });
  const workspaceName = request.scope?.name ?? '';
  // Three options, never two-and-a-guess: the global default is the reader's
  // decision, and a workspace scope adds the one option that is about *here*.
  const scopeOptions = useMemo<readonly { value: InstallScopeChoice; label: string; hint: string }[]>(() => [
    { value: 'global', label: t('cap.install.scope.global'), hint: t('cap.install.scope.globalHint') },
    { value: 'later', label: t('cap.install.scope.later'), hint: t('cap.install.scope.laterHint') },
    ...(request.scope !== undefined
      ? [{ value: 'workspace' as const, label: t('cap.install.scope.workspace'), hint: t('cap.install.scope.workspaceHint', { workspace: workspaceName }) }]
      : []),
  ], [t, request.scope, workspaceName]);

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
            {request.update?.branch !== undefined
              ? `${t('cap.update.branch', { branch: request.update.branch.name, version: request.update.branch.commit })}${request.entry !== undefined ? ' · ' : ''}`
              : updating && request.update?.fromVersion !== undefined && plan?.version !== undefined && request.update.fromVersion !== plan.version
                ? `v${request.update.fromVersion} → v${plan.version} · `
                : plan?.version !== undefined ? `v${plan.version} · ` : ''}
            {request.entry?.tier === 'official' ? t('cap.tier.official')
              : request.entry?.tier === 'curated' ? t('cap.tier.curated')
                // An update of something the catalog does not list: its origin is already on the row.
                : request.entry?.tier === 'third-party' || !updating ? t('cap.tier.thirdParty') : ''}
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

        {plan !== undefined && phase.kind !== 'done' && phase.kind !== 'enableFailed' ? (
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
                <PermissionBoundary className="mt-2" />
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

            {updating && plan.changes.length === 0 ? (
              <p className="text-ink-soft" data-install-no-changes>{t('cap.update.noChanges')}</p>
            ) : null}
            {plan.changes.length > 0 ? (
              <div data-install-changes>
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.install.changes')}</p>
                <ul className="mt-1.5 space-y-0.5 font-mono text-[12px] text-ink-soft">
                  {plan.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
              </div>
            ) : null}

            {/* Only a fresh install decides where it lands. An update carries no
                choice: every switch it had stays exactly as it was. */}
            {!updating ? (
              <fieldset className="border-t border-hairline pt-4" data-install-scope={choice}>
                <legend className="text-[12px] font-medium text-ink-soft">{t('cap.install.scope.title')}</legend>
                <div className="mt-2 space-y-1">
                  {scopeOptions.map((option) => (
                    <label
                      key={option.value}
                      className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-ink/[0.04] ${choice === option.value ? 'bg-ink/[0.04]' : ''}`}
                      data-install-scope-option={option.value}
                    >
                      <input
                        type="radio"
                        name="install-scope"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-ink)]"
                        checked={choice === option.value}
                        disabled={busy}
                        onChange={() => { setChoice(option.value); }}
                      />
                      <span className="min-w-0">
                        <span className="block text-ink">{option.label}</span>
                        <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">{option.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {/* One line, and only when the plan says so: an app service is
                    shared at the home scope, so none of the three choices above
                    starts a per-workspace copy — and "decide later" installs it
                    without starting it, which its own hint does not say. */}
                {appService ? (
                  <p className="mt-2 max-w-[62ch] text-[12px] leading-4 text-ink-faint" data-install-app-service>
                    {t('cap.install.appServiceHint')}
                  </p>
                ) : null}
              </fieldset>
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
            </Disclosure>
          </>
        ) : null}

        {phase.kind === 'done' ? (
          <div className="space-y-4" data-install-done={updating ? 'update' : phase.choice}>
            <p className="flex items-center gap-2 text-ink" role="status">
              <span className="text-success"><Icon name="check" size={14} /></span>
              {updating
                ? t('cap.update.done', { name: request.displayName })
                : phase.choice === 'global'
                  ? t('cap.install.done', { name: request.displayName })
                  : phase.choice === 'workspace'
                    ? t('cap.install.done.workspace', { plugin: request.displayName, workspace: workspaceName })
                    : t('cap.install.done.later', { plugin: request.displayName })}
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
                      onClick={() => { void installPrerequisite(phase.installed.pluginId, item.id); }}
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

        {phase.kind === 'enableFailed' ? (
          <div className="space-y-3" data-install-enable-failed>
            <p role="alert" className="text-[13px] text-danger">{phase.message}</p>
            <p className="text-ink-soft" data-install-enable-note>{t('cap.install.usageFailed', { plugin: request.displayName })}</p>
            {phase.installed.pendingEnable !== undefined ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-install-retry-enable
                onClick={() => { void enableInWorkspace(phase.installed.pluginId, phase.installed.pendingEnable!.workspaceId, phase.installed, phase.plan, phase.choice); }}
              >
                {t('cap.install.retryUsage')}
              </button>
            ) : null}
          </div>
        ) : null}

        {phase.kind === 'failed' ? (
          <p role="alert" className="text-[13px] text-danger" data-install-error>{phase.message}</p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {phase.kind === 'done' ? (
          <button type="button" className={PRIMARY_BUTTON} data-autofocus onClick={onClose}>{t('cap.install.finish')}</button>
        ) : phase.kind === 'enableFailed' ? (
          // Nothing is left to install: the only honest footer is the way out.
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
                onClick={() => { if (plan !== undefined) void install(plan, choice); }}
              >
                {updating
                  ? busy ? t('cap.update.installing') : needsConsent ? t('cap.update.allow') : t('cap.update.confirm')
                  : busy ? t('cap.install.installing') : needsConsent ? t('cap.install.allow') : t('cap.install.confirm')}
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
