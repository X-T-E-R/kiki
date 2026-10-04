/**
 * One provider's detail — the sub-view a row opens, and the only place a
 * hundred-row list ever becomes a form.
 *
 * Four things live here, in the order a reader needs them:
 *
 *  1. What it is and whether it works (name, package, modalities, health).
 *  2. Which modality it is the default for — a per-modality control, because
 *     images and video rarely go to the same place, and "make default" is the
 *     decision a reader actually comes here to make.
 *  3. What it needs from this machine — its key and its endpoint. Loaded on
 *     open, saved as one draft with the shared save/discard footer, and read
 *     back after the write rather than assumed.
 *  4. What it can do — models, constraints, and (for speech) voices. Asked on
 *     demand, per provider, and never on page open: a voice list runs to
 *     thousands and a capability probe can cost a paid provider money.
 *
 * It does not generate. A generation needs an owner session and an agent, and
 * 506 has deliberately not built a session-less path; the button that starts
 * one belongs on the session's tool row, not on a management page.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  MEDIA_DEFAULTS_PLUGIN_ID,
  currentDefault,
  defaultSettingKey,
  mediaSourceStatus,
  statusKey,
  schemaOf,
  useMediaSourceSettings,
  type MediaKind,
  type MediaSourceEntry,
} from '../../lib/mediaSources';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { Disclosure, FactList, QUIET_BUTTON, StatusDot, Tag } from '../capabilities/primitives';
import { MediaSourceForm } from './MediaSourceForm';
import { MediaKindGlyph } from './MediaKindGlyph';
import { MediaCapabilityList, MediaVoicePicker } from './MediaProviderInfo';

export function MediaSourceDetail({
  entry,
  providers,
  onReloadProviders,
  onBack,
  onOpenPlugin,
}: {
  readonly entry: MediaSourceEntry;
  /** The whole list, so a default can be taken from whichever provider held it. */
  readonly providers: readonly MediaSourceEntry[];
  /** Re-read the provider list after a default was written. */
  readonly onReloadProviders: () => void;
  readonly onBack: () => void;
  /** Open this provider's package on the ordinary plugin detail. */
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [savingDefaults, setSavingDefaults] = useState<MediaKind | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const status = mediaSourceStatus(entry, false);
  const settings = useMediaSourceSettings(client, status === 'broken' ? undefined : entry.pluginId);

  /**
   * Handing a modality's default to this provider moves one setting on the
   * media entry package — one per-key write through the route every other
   * plugin setting uses. The previous holder is overwritten rather than
   * cleared separately, because the value is a single pointer: two providers
   * cannot both be the default for one modality, and a half-applied pair would
   * leave the tools choosing between them.
   */
  const setDefault = async (kind: MediaKind, makeDefault: boolean) => {
    setSavingDefaults(kind);
    setDefaultsError(null);
    try {
      await client.setPluginSettings(MEDIA_DEFAULTS_PLUGIN_ID, {
        [defaultSettingKey(kind)]: makeDefault ? entry.provider : null,
      });
      onReloadProviders();
    } catch (failure) {
      setDefaultsError(errorText(locale, failure));
    } finally {
      setSavingDefaults(null);
    }
  };

  return (
    <div className="min-w-0" data-media-source-detail={entry.provider}>
      <button type="button" onClick={onBack} className={`${QUIET_BUTTON} -ml-1 px-1`} data-media-source-back>
        <Icon name="arrowLeft" size={14} />
        {t('cap.detail.back')}
      </button>

      <header className="mt-3 flex min-w-0 flex-wrap items-start gap-3">
        <span className="mt-1 flex shrink-0 items-center gap-1">
          {entry.definition.kinds.map((kind) => (
            <MediaKindGlyph key={kind} kind={kind} className="h-5 w-5 text-ink-soft" />
          ))}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 flex-wrap items-center gap-2 font-display text-[20px] leading-7 text-ink">
            <span className="truncate">{entry.displayName}</span>
            <StatusDot state={status === 'ready' || status === 'default' ? 'ok' : status === 'broken' ? 'error' : 'waiting'} label={t(statusKey(status))} />
            {status === 'default' ? <Tag tone="accent">{t(statusKey(status))}</Tag> : null}
            {status === 'needs-config' ? <Tag tone="warn">{t(statusKey(status))}</Tag> : null}
            {status === 'broken' ? <Tag tone="danger">{t(statusKey(status))}</Tag> : null}
          </h1>
          <p className="mt-0.5 truncate font-mono text-[12px] text-ink-faint">{entry.provider}</p>
          {status === 'broken' ? (
            <p role="alert" className="mt-1 text-[12px] text-danger" data-media-source-problem>
              {entry.problem ?? t('cap.media.row.unavailable', { plugin: entry.pluginId })}
            </p>
          ) : null}
        </div>
        {onOpenPlugin !== undefined ? (
          <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} data-media-source-open-plugin={entry.pluginId} onClick={() => { onOpenPlugin(entry.pluginId); }}>
            {t('cap.media.detail.package')}
          </button>
        ) : null}
      </header>

      <div className="mt-5" data-media-source-defaults>
        <p className="text-[13px] font-medium text-ink">{t('cap.media.detail.defaults')}</p>
        <p className="mt-0.5 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('cap.media.detail.defaultsHint')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {entry.definition.kinds.map((kind) => {
            const isDefault = currentDefault(providers, kind) === entry.provider;
            return (
              <button
                key={kind}
                type="button"
                role="switch"
                aria-checked={isDefault}
                disabled={savingDefaults !== null || status === 'broken'}
                data-media-default={kind}
                data-media-default-on={isDefault ? 'true' : 'false'}
                onClick={() => { void setDefault(kind, !isDefault); }}
                className={`inline-flex min-h-9 items-center gap-2 rounded-[10px] px-3 text-[13px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 ${
                  isDefault ? 'bg-ink/[0.08] font-medium text-ink' : 'bg-ink/[0.04] text-ink-soft hover:bg-ink/[0.07] hover:text-ink'
                }`}
              >
                <MediaKindGlyph kind={kind} className="h-4 w-4" />
                {t(`cap.media.kind.${kind}` as Parameters<typeof t>[0])}
                <span className="text-[11px] text-ink-faint">{isDefault ? t('cap.media.default.on') : t('cap.media.default.off')}</span>
              </button>
            );
          })}
        </div>
        {defaultsError !== null ? <p role="alert" className="mt-1 text-[12px] text-danger">{defaultsError}</p> : null}
      </div>

      {status === 'broken' ? null : (
        <div className="mt-6 min-w-0 space-y-6">
          {settings.isPending ? (
            <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
          ) : settings.isError ? (
            <InlineError error={settings.error} />
          ) : (
            // A package that declares no settings has nothing to fill in. Saying so
            // is the honest section; an empty heading under "What this source
            // needs" reads as a form that failed to load.
            Object.keys(settings.data.schema.schema.properties).length === 0 ? (
              <p className="text-[12px] leading-4 text-ink-faint" data-media-source-self-managed>
                {t('cap.media.detail.selfManaged')}
              </p>
            ) : (
            <div data-media-source-settings-section>
              <h2 className="mb-3 text-[13px] font-medium text-ink">{t('cap.media.detail.settings')}</h2>
              <MediaSourceForm
                provider={entry.provider}
                settings={settings.data}
                {...(entry.definition.connectionSetting === undefined ? {} : { connectionSetting: entry.definition.connectionSetting })}
                onSave={async (values) => { await client.setPluginSettings(entry.pluginId, values); }}
                onReload={async () => {
                  const view = await client.getPluginSettings(entry.pluginId);
                  return { schema: schemaOf(view.schema), values: view.values, secretsConfigured: view.secretsConfigured };
                }}
                saving={settings.isFetching}
              />
            </div>
            )
          )}

          <MediaCapabilityList provider={entry.provider} kinds={entry.definition.kinds} />
          {entry.definition.kinds.includes('tts') ? <MediaVoicePicker provider={entry.provider} /> : null}
        </div>
      )}

      <div className="mt-8 border-t border-hairline pt-4">
        <Disclosure label={t('cap.advanced')} open={false} onToggle={() => {}} dataAttrs={{ 'data-media-source-advanced': '' }}>
          <FactList
            items={[
              { label: t('cap.detail.id'), value: entry.provider, mono: true },
              { label: t('cap.media.detail.adapter'), value: entry.definition.id, mono: true },
              { label: t('cap.media.detail.package'), value: entry.pluginId, mono: true },
              ...(entry.version === undefined ? [] : [{ label: t('cap.detail.version'), value: entry.version, mono: true }]),
              { label: t('cap.media.detail.kinds'), value: entry.definition.kinds.map((kind) => t(`cap.media.kind.${kind}` as Parameters<typeof t>[0])).join(' · ') },
              { label: t('cap.media.detail.resumeVersion'), value: String(entry.definition.resumeVersion), mono: true },
            ]}
          />
        </Disclosure>
      </div>
    </div>
  );
}
