/**
 * One source's detail — the sub-view a row opens, and the only place a
 * thousand-row list ever becomes a form.
 *
 * Four things live here, in the order a reader needs them:
 *
 *  1. What it is and whether it works (name, package, modalities, health).
 *  2. Whether it is in use, and which modalities it is the default for. Both
 *     are per-source choices: this package carries every vendor, so switching
 *     one source off cannot mean switching the others off with it.
 *  3. What it needs from this machine — its key and its endpoint. Loaded on
 *     open, saved as one draft with the shared save/discard footer, and read
 *     back after the write rather than assumed.
 *  4. What it can do — models, constraints, and (for speech) voices. Asked on
 *     demand, per source, and never on page open: a voice list runs to
 *     thousands and a capability probe can cost a paid source money.
 *
 * It does not generate. A generation needs an owner session and an agent, and
 * 506 has deliberately not built a session-less path; the button that starts
 * one belongs on the session's tool row, not on a management page.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n, type Locale } from '../../i18n';
import {
  currentDefault,
  mediaSourceStatus,
  statusKey,
  useMediaDefaultUpdate,
  useMediaSourceSettings,
  useMediaSourceUpdate,
  type MediaKind,
  type MediaSourceEntry,
  type MediaSourceSettings,
  type MediaSourceWriteResult,
} from '../../lib/mediaSources';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { Disclosure, FactList, QUIET_BUTTON, StatusDot, Tag } from '../capabilities/primitives';
import { MediaSourceForm } from './MediaSourceForm';
import { MediaKindGlyph } from './MediaKindGlyph';
import { MediaCapabilityList, MediaVoicePicker } from './MediaProviderInfo';

/** The one setting key that names a connection, when the source declares one. */
function connectionSettingOf(entry: MediaSourceEntry): string | undefined {
  return entry.definitions.find((definition) => definition.connectionSetting !== undefined)?.connectionSetting;
}

/** A host source answer as the form's read model, with no wire layout leaked. */
function formSettingsOf(source: MediaSourceSettings): MediaSourceSettings {
  return {
    schema: source.schema,
    values: source.values,
    secretsConfigured: source.secretsConfigured,
    ...(source.missing === undefined ? {} : { missing: source.missing }),
  };
}

export function MediaSourceDetail({
  entry,
  providers,
  onBack,
  onOpenPlugin,
}: {
  readonly entry: MediaSourceEntry;
  /** The whole list, so a default can be taken from whichever source held it. */
  readonly providers: readonly MediaSourceEntry[];
  readonly onBack: () => void;
  /** Open this source's package on the ordinary plugin detail. */
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  // The advanced fold is real state, because the primitive is strictly
  // controlled: it marks its content `inert` while closed, so a fold wired to
  // a constant `open={false}` makes a script's command, arguments and working
  // directory permanently unreachable rather than merely folded. Open on a
  // source whose detail a reader arrived at to inspect, and closed again when
  // they leave for another one.
  const [advanced, setAdvanced] = useState(entry.custom);
  const status = mediaSourceStatus(entry, false);
  // The form reads *this source's* state, not its package's. A package holds
  // many sources, and a read addressed by the package would hand the form a
  // sibling vendor's keys.
  const settings = useMediaSourceSettings(client, entry.provider);
  const write = useMediaSourceUpdate(client);
  const defaults = useMediaDefaultUpdate(client);
  const savingDefaults = defaults.pending;
  const connectionSetting = connectionSettingOf(entry);

  /**
   * Handing a modality's default to this source moves one setting on the media
   * package — one per-key write through the route every other plugin setting
   * uses. The previous holder is overwritten rather than cleared separately,
   * because the value is a single pointer: two sources cannot both be the
   * default for one modality, and a half-applied pair would leave the tools
   * choosing between them.
   *
   * The write lands the host's own echo in the cache the list reads, so the
   * badge moves here AND on the row behind it the moment it is saved, with no
   * reload and no second fetch. Only a refusal leaves the badge where it was,
   * and it says why.
   */
  const setDefault = async (kind: MediaKind, makeDefault: boolean) => {
    setDefaultsError(null);
    // The outcome is returned rather than read back off the hook afterwards:
    // a value read from a closure after an `await` is not necessarily the one
    // this click produced, and a refused default that prints nothing is the
    // same as a default that silently did not take.
    const outcome = await defaults.update(kind, makeDefault ? entry.provider : undefined);
    if (!outcome.ok) setDefaultsError(errorText(locale, outcome.error));
  };

  /**
   * On, off, and take-out-of-use — three different promises, so three calls.
   *
   * Off keeps everything and stops using it. Removed goes further: the tools
   * stop offering this source, while its configuration, its jobs and its resume
   * handles stay exactly where they are — which is why the removal is
   * reversible here and why the copy says so on the control itself rather than
   * in a dialog whose answer the reader has to guess at.
   *
   * The rejection is swallowed HERE, at the control, rather than in the hook:
   * a refused write leaves this source exactly as it was, so the row the reader
   * is looking at is still true, and the outcome line under the removal control
   * says what happened. Letting it escape would be an unhandled rejection from
   * a click handler.
   */
  const setInUse = (inUse: boolean) => {
    write.update({ provider: entry.provider, ...(inUse ? { enabled: true, removed: false } : { enabled: false }) })
      .catch(() => undefined);
  };

  const setRemoved = (removed: boolean) => {
    write.update({ provider: entry.provider, ...(removed ? { removed: true } : { removed: false, enabled: true }) })
      .catch(() => undefined);
  };

  return (
    <div className="min-w-0" data-media-source-detail={entry.provider}>
      <button type="button" onClick={onBack} className={`${QUIET_BUTTON} -ml-1 px-1`} data-media-source-back>
        <Icon name="arrowLeft" size={14} />
        {t('cap.detail.back')}
      </button>

      <header className="mt-3 flex min-w-0 flex-wrap items-start gap-3">
        <span className="mt-1 flex shrink-0 items-center gap-1">
          {entry.kinds.map((kind) => (
            <MediaKindGlyph key={kind} kind={kind} className="h-5 w-5 text-ink-soft" />
          ))}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 flex-wrap items-center gap-2 font-display text-[20px] leading-7 text-ink">
            <span className="truncate">{entry.displayName}</span>
            <StatusDot state={status === 'ready' || status === 'default' ? 'ok' : status === 'broken' ? 'error' : status === 'off' || status === 'removed' ? 'off' : 'waiting'} label={t(statusKey(status))} />
            {entry.custom ? <Tag tone="faint">{t('cap.media.row.script')}</Tag> : null}
            {status === 'default' ? <Tag tone="accent">{t(statusKey(status))}</Tag> : null}
            {status === 'needs-config' ? <Tag tone="warn">{t(statusKey(status))}</Tag> : null}
            {status === 'off' || status === 'removed' ? <Tag tone="faint">{t(statusKey(status))}</Tag> : null}
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

      {status === 'broken' ? null : (
        <>
          <div className="mt-5 max-w-md" data-media-source-in-use>
            <Toggle
              layout="row"
              label={t('cap.media.detail.inUse')}
              checked={entry.enabled && !entry.removed}
              disabled={write.pending}
              onChange={setInUse}
            />
            <p className="mt-1 text-[12px] leading-4 text-ink-faint">{t('cap.media.detail.inUseHint')}</p>
          </div>

          <div className="mt-5" data-media-source-defaults>
            <p className="text-[13px] font-medium text-ink">{t('cap.media.detail.defaults')}</p>
            <p className="mt-0.5 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('cap.media.detail.defaultsHint')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {entry.kinds.map((kind) => {
                const isDefault = currentDefault(providers, kind) === entry.provider;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="switch"
                    aria-checked={isDefault}
                    disabled={savingDefaults !== null || !entry.enabled || entry.removed}
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
            {defaultsError !== null ? <p role="alert" data-media-defaults-error className="mt-1 text-[12px] text-danger">{defaultsError}</p> : null}
          </div>
        </>
      )}

      {status === 'broken' ? null : (
        <div className="mt-6 min-w-0 space-y-6">
          {settings.isPending ? (
            <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
          ) : settings.isError ? (
            <InlineError error={settings.error} />
          ) : settings.data === undefined ? null : (
            // A source that declares no settings has nothing to fill in. Saying
            // so is the honest section; an empty heading under "What this source
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
                  settings={formSettingsOf(settings.data)}
                  {...(connectionSetting === undefined ? {} : { connectionSetting })}
                  saving={write.pending}
                  // The write carries this source's provider id and only the
                  // keys the reader changed, so nothing here can move a sibling
                  // source's configuration.
                  onSave={(values) => write.update({ provider: entry.provider, values })}
                  onReload={async () => {
                    const api = client.klient.global.media;
                    if (api === undefined) throw new Error('media domain unavailable');
                    return formSettingsOf(await api.sourceSettings({ provider: entry.provider }));
                  }}
                />
              </div>
            )
          )}

          <MediaCapabilityList provider={entry.provider} kinds={entry.kinds} />
          {entry.kinds.includes('tts') ? <MediaVoicePicker provider={entry.provider} /> : null}
        </div>
      )}

      {status === 'broken' ? null : (
        <div className="mt-8 border-t border-hairline pt-4">
          {/* Removal is the one control here that changes what the tools will
              offer, so it states what survives before it is pressed instead of
              asking a question whose answer is already on screen. */}
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={write.pending}
            data-media-source-remove={entry.removed ? 'restore' : 'remove'}
            onClick={() => { setRemoved(!entry.removed); }}
          >
            {t(entry.removed ? 'cap.media.detail.restore' : 'cap.media.detail.remove')}
          </button>
          <p className="mt-1 max-w-[62ch] text-[12px] leading-4 text-ink-faint">
            {t(entry.removed ? 'cap.media.detail.restoreHint' : 'cap.media.detail.removeHint')}
          </p>
          <FeedbackLine feedback={lifecycleFeedback(write.outcome, locale, t)} />
        </div>
      )}

      <div className="mt-8 border-t border-hairline pt-4">
        <Disclosure
          label={t('cap.advanced')}
          open={advanced}
          onToggle={() => { setAdvanced(!advanced); }}
          dataAttrs={{ 'data-media-source-advanced': '' }}
        >
          <FactList
            items={[
              { label: t('cap.detail.id'), value: entry.provider, mono: true },
              { label: t('cap.media.detail.sourceId'), value: entry.sourceId, mono: true },
              { label: t('cap.media.detail.adapters'), value: entry.definitions.map((definition) => definition.id).join(' · '), mono: true },
              { label: t('cap.media.detail.package'), value: entry.pluginId, mono: true },
              { label: t('cap.media.detail.kinds'), value: entry.kinds.map((kind) => t(`cap.media.kind.${kind}` as Parameters<typeof t>[0])).join(' · ') },
              // A script's command is the one thing about it a reader cannot
              // guess, so it is stated rather than left to the row. It is not
              // editable here: a script is what the reader typed when they
              // added it, and a second editor for the same five fields is how
              // two forms of one thing start to disagree.
              ...(entry.custom ? [
                { label: t('cap.media.script.command'), value: scriptFieldOf(entry, 'command') ?? t('cap.media.script.untitled'), mono: true },
                { label: t('cap.media.script.args'), value: scriptArgsOf(entry) ?? t('cap.media.script.noArgs'), mono: true },
                ...(scriptFieldOf(entry, 'cwd') === undefined ? [] : [{ label: t('cap.media.script.cwd'), value: scriptFieldOf(entry, 'cwd')!, mono: true }]),
                { label: t('cap.media.script.protocol'), value: scriptFieldOf(entry, 'protocol') ?? t('cap.media.script.protocolFile'), mono: true },
              ] : []),
              {
                label: t('cap.media.detail.secrets'),
                // Which secrets are stored, never what they are: the host does
                // not send the values and this view does not ask for them.
                value: entry.source.secretsConfigured.length === 0
                  ? t('cap.media.detail.noSecrets')
                  : tp('cap.media.detail.secretCount', entry.source.secretsConfigured.length),
              },
            ]}
          />
        </Disclosure>
      </div>
    </div>
  );
}

/**
 * One of a script source's own stored fields.
 *
 * The host reports a script's command, arguments and output format in the
 * source's own values because that is where the runtime reads them from — so
 * this shows the string the tools will use rather than a reconstruction of it.
 * A malformed value reads as absent rather than throwing inside a detail the
 * reader opened on purpose.
 */
function scriptFieldOf(entry: MediaSourceEntry, key: string): string | undefined {
  const value = entry.source.values[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * A script's arguments, as the list the host stored.
 *
 * Stored as one JSON array, because a command with a flag and a path has two
 * arguments and not two lines of prose. Anything unparseable is shown as
 * "none" rather than a raw parse error: this is a fact about a source, not a
 * report about the reading of it.
 */
function scriptArgsOf(entry: MediaSourceEntry): string | undefined {
  const raw = scriptFieldOf(entry, 'args');
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return undefined;
    return parsed.length === 0 ? undefined : parsed.join(' · ');
  } catch {
    return undefined;
  }
}

/**
 * The one line under the removal control, from the host's own answer.
 */
function lifecycleFeedback(
  outcome: MediaSourceWriteResult | null,
  locale: Locale,
  t: ReturnType<typeof useI18n>['t'],
): Feedback {
  if (outcome === null) return null;
  if (!outcome.ok) return { tone: 'error', text: errorText(locale, outcome.error) };
  return { tone: 'success', text: t(outcome.source.removed ? 'cap.media.detail.removed' : 'cap.media.detail.restored') };
}