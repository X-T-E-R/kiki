/**
 * Recovering a document preview that is missing its renderer.
 *
 * The user is looking at one document, so the fix is scoped to that: make the
 * one Office plugin that renders this format work, and retry. It deliberately
 * does NOT route through the Work mode setup — a user who never enabled a mode,
 * or who removed it, must still be able to see their file, and they should not
 * be offered a set of packages they did not ask for.
 *
 * What has to happen depends on the state of that one plugin, and the server
 * reports it (`recovery.plugin_state`) instead of leaving the GUI to guess from
 * a failed request:
 *
 * - `not-installed` — the plugin is absent, so its bytes have to be fetched and
 *   installed. The user sees the real install plan and its permissions first
 *   and consents once, because this is the step that brings outside code in.
 *   The plan's fingerprint pins exactly the candidate that was shown.
 * - `disabled` — the user has the plugin but turned it off. Nothing is
 *   installed; the consent says so in as many words, and the action turns it
 *   back on.
 * - `enabled` — everything is in place except the program that draws the page,
 *   so only that one program is installed.
 *
 * Each path then installs the declared prerequisite (OfficeCLI) and reloads the
 * document in place. A failure keeps the steps that already succeeded and offers
 * a retry where it left off, rather than making the user start over or go
 * looking through settings.
 */

import { useCallback, useEffect, useState } from 'react';

import type { PluginInstallPlan } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { API_CODES, ApiError } from '@kiki/session-core/transport';

import { useI18n } from '../../i18n';
import type { KikiClient, PluginMarketplaceEntry } from '../../lib/client';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

export type RendererPluginState = 'not-installed' | 'disabled' | 'enabled';

/**
 * `planning` and `consent` only exist for a plugin that has to be installed;
 * the other two states go straight from the offer to the work.
 */
type Phase =
  | { readonly kind: 'ask' }
  | { readonly kind: 'planning' }
  | { readonly kind: 'consent'; readonly plan: PluginInstallPlan; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: 'working'; readonly step: string }
  | { readonly kind: 'failed'; readonly step: string; readonly message: string };

export interface RendererInstallProps {
  readonly client: KikiClient | undefined;
  /** The plugin that declares the prerequisite, from the recovery contract. */
  readonly pluginId: string;
  /** The program to install, e.g. `officecli`. */
  readonly prerequisiteId: string;
  /** That plugin's real state on this home, from the recovery contract. */
  readonly pluginState: RendererPluginState;
  /** The document the user was trying to read, named in the copy. */
  readonly fileName: string;
  /** Reloads the document once the renderer is in place. */
  readonly onInstalled: () => void;
}

export function RendererInstall({ client, pluginId, prerequisiteId, pluginState, fileName, onInstalled }: RendererInstallProps) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });

  const fail = useCallback((step: string, reason: unknown) => {
    setPhase({
      kind: 'failed',
      step,
      message: reason instanceof ApiError && reason.code === API_CODES.TIMEOUT
        ? t('preview.installTimedOut')
        : errorText(locale, reason),
    });
  }, [locale, t]);

  /** The one program that draws the page, once the plugin itself is in place. */
  const installPrerequisite = useCallback(async () => {
    setPhase({ kind: 'working', step: prerequisiteId });
    await client!.installPluginPrerequisite(pluginId, prerequisiteId);
  }, [client, pluginId, prerequisiteId]);

  /** Show the real plan and let the user agree to exactly that candidate. */
  const planInstall = useCallback(async () => {
    if (client === undefined) return;
    setPhase({ kind: 'planning' });
    try {
      const entry = await findCatalogEntry(client, pluginId);
      if (entry === undefined) {
        fail(pluginId, new Error(t('preview.pluginUnavailable', { name: pluginId })));
        return;
      }
      setPhase({ kind: 'consent', plan: await client.previewPlugin(entry.source, entry.sha256), entry });
    } catch (error) {
      fail(pluginId, error);
    }
  }, [client, fail, pluginId, t]);

  const recover = useCallback(async (step: string, run: () => Promise<void>) => {
    if (client === undefined) return;
    setPhase({ kind: 'working', step });
    try {
      await run();
      onInstalled();
    } catch (error) {
      fail(step, error);
    }
  }, [client, fail, onInstalled]);

  const start = useCallback(() => {
    if (pluginState === 'not-installed') { void planInstall(); return; }
    if (pluginState === 'disabled') {
      void recover(pluginId, async () => {
        await client!.setPluginEnabled(pluginId, true);
        await installPrerequisite();
      });
      return;
    }
    void recover(prerequisiteId, installPrerequisite);
  }, [client, installPrerequisite, planInstall, pluginId, pluginState, prerequisiteId, recover]);

  const confirmInstall = useCallback((entry: { readonly source: string; readonly sha256?: string }, plan: PluginInstallPlan) => {
    void recover(pluginId, async () => {
      await client!.installPreviewedPlugin({
        source: entry.source,
        sha256: entry.sha256,
        fingerprint: plan.fingerprint,
        consent: true,
      });
      // A new plugin lands disabled; the user just asked for this format, so
      // it goes on now rather than leaving them to find a second switch.
      await client!.setPluginEnabled(pluginId, true);
      await installPrerequisite();
    });
  }, [client, installPrerequisite, pluginId, recover]);

  // A different document is a different question, and its plan belongs to it.
  useEffect(() => { setPhase({ kind: 'ask' }); }, [fileName, pluginId, pluginState, prerequisiteId]);

  return (
    <div className="flex flex-col items-start gap-2.5" data-preview-renderer-install data-plugin-state={pluginState}>
      {phase.kind === 'ask' ? (
        <>
          <p className="max-w-[34rem] text-[12px] leading-[1.55] text-ink-soft" data-renderer-ask>
            {pluginState === 'not-installed'
              ? t('preview.installOfficePluginConsent', { name: pluginId, program: prerequisiteId })
              : pluginState === 'disabled'
                ? t('preview.enableOfficePluginConsent', { name: pluginId, program: prerequisiteId })
                : t('preview.rendererShared', { name: prerequisiteId })}
          </p>
          <button
            type="button"
            onClick={start}
            className={PRIMARY_BUTTON}
            data-install-dependency
            data-prerequisite={prerequisiteId}
          >
            {pluginState === 'not-installed'
              ? t('preview.installOfficePlugin', { name: pluginId })
              : pluginState === 'disabled'
                ? t('preview.enableOfficePlugin', { name: pluginId })
                : t('preview.installRenderer', { name: prerequisiteId })}
          </button>
        </>
      ) : null}

      {phase.kind === 'planning' ? (
        <p className="text-[12px] text-ink-soft" role="status" data-planning>
          {t('preview.planningInstall', { name: pluginId })}
        </p>
      ) : null}

      {phase.kind === 'consent' ? (
        <div className="flex max-w-[34rem] flex-col gap-2" data-install-consent>
          <p className="text-[12px] leading-[1.55] text-ink" data-consent-summary>
            {phase.plan.consentRequired
              ? t('preview.installOfficePluginPlan', { name: pluginId, program: prerequisiteId })
              : t('preview.installOfficePluginPlanNoConsent', { name: pluginId, program: prerequisiteId })}
          </p>
          {describePermissions(phase.plan.permissions) !== undefined ? (
            <p className="text-[12px] leading-[1.55] text-ink-soft" data-consent-permissions>
              {t('preview.installOfficePluginPermissions', { permissions: describePermissions(phase.plan.permissions)! })}
            </p>
          ) : null}
          {phase.plan.contributions.length > 0 ? (
            <p className="text-[12px] leading-[1.55] text-ink-soft" data-consent-contributions>
              {t('preview.installOfficePluginAdds', { count: String(phase.plan.contributions.length) })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              data-install-confirm
              onClick={() => { confirmInstall(phase.entry, phase.plan); }}
            >
              {t('preview.installOfficePluginConfirm', { name: pluginId })}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setPhase({ kind: 'ask' }); }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'working' ? (
        <p className="text-[12px] text-ink-soft" role="status" data-installing={phase.step}>
          {t('preview.installing', { name: phase.step })}
        </p>
      ) : null}

      {phase.kind === 'failed' ? (
        <div className="flex flex-col items-start gap-1.5" role="alert">
          <p className="text-[11.5px] leading-[1.5] text-danger" data-install-error>{phase.message}</p>
          <button type="button" className={SECONDARY_BUTTON} data-retry-install onClick={start}>
            {t('preview.tryAgain')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The install source for this home's copy of the plugin, taken from the
 * server's own catalog rather than a URL typed into the GUI. A home whose
 * catalog does not offer this plugin is told so, and is never handed a
 * substitute.
 */
async function findCatalogEntry(client: KikiClient, pluginId: string) {
  const catalog = await client.listPluginMarketplace();
  return catalog.entries.find((entry) => entry.id === pluginId);
}

/** The plan's permissions in the user's terms, or nothing when it has none. */
function describePermissions(permissions: PluginInstallPlan['permissions']): string | undefined {
  if (permissions === undefined) return undefined;
  const parts: string[] = [];
  if (permissions.fs !== undefined) parts.push(permissions.fs);
  if (permissions.net !== undefined && permissions.net.length > 0) parts.push(...permissions.net);
  if (permissions.exec !== undefined && permissions.exec.length > 0) parts.push(...permissions.exec);
  if (permissions.secrets === true) parts.push('secrets');
  if (permissions.uiPanel === true) parts.push('panel');
  return parts.length > 0 ? parts.join(', ') : undefined;
}
