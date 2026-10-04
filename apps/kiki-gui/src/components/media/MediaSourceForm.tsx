/**
 * One provider's own settings form — the same draft contract every other Kiki
 * settings form uses, so "save" and "discard" mean here what they mean
 * everywhere else.
 *
 * The semantics are borrowed deliberately rather than reinvented:
 *
 *  - A secret is write-only. The field takes a new value or nothing; there is
 *    no reveal route, so the row says "set" or "not set" and offers removal as
 *    a *staged* action with an undo, because a mis-click must not delete a
 *    working key before the form is saved. A cleared secret is sent as `null`
 *    only when the whole form is saved, and its value is never read back,
 *    echoed into a log, or shown in a preview.
 *  - Only changed keys are sent. A value set to the empty string is sent as
 *    `null` (remove it); an unsent key is kept by the host.
 *  - The save is per-package, and the read-back is the host's echo. A draft
 *    that fails to save keeps everything the reader typed; the error appears
 *    under the form, not in place of it.
 *
 * A provider may declare that one of its plain string settings names a
 * *connection* rather than a value of its own (`connectionSetting` on the
 * provider definition). When it does, that one field is drawn as a picker over
 * the connections the reader already has, instead of asking for a base URL and
 * a key this app already stores. Everything else in the form is unchanged, and
 * a provider that declares nothing gets an ordinary text field — a script that
 * manages its own environment or its own key file is a legitimate author, and
 * an empty `apiKey` is never treated as "this provider is broken".
 *
 * What the form does *not* do is discover anything. No model list, no voice
 * list, no capability probe fires while it is on screen: those are asked for on
 * the detail view, per provider, when the reader actually wants them. A form
 * that fires nine requests the moment it opens is a form that can cost a paid
 * provider money by accident.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import type { MediaSettingProperty, MediaSourceSettings } from '../../lib/mediaSources';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../settings/SecretField';
import { SettingsDraftFooter } from '../settings/SettingsPrimitives';
import { useSavedTick } from '../settings/useSavedTick';

type Draft = Record<string, string | boolean | SecretDraft>;

function draftOf(settings: MediaSourceSettings): Draft {
  const draft: Draft = {};
  for (const [key, property] of Object.entries(settings.schema.schema.properties)) {
    if (property.secret) { draft[key] = KEEP_SECRET; continue; }
    const stored = settings.values[key];
    if (property.type === 'boolean') draft[key] = typeof stored === 'boolean' ? stored : property.default === true;
    else draft[key] = stored === undefined ? '' : String(stored);
  }
  return draft;
}

type Issue = { readonly key: string; readonly text: string };

/**
 * Only changed keys; an emptied plain value or a cleared secret is `null`.
 *
 * `usingConnection` is the whole point of the second argument. A provider that
 * declares a `connectionSetting` has two legitimate ways to authenticate and
 * they are alternatives, not a checklist: either it borrows a connection the
 * reader already has, or it is configured in its own right. When a connection
 * is selected the package's own required key and endpoint are *not* required —
 * asking for both would mean entering a credential that is not being used, and
 * would report a ready provider as unconfigured.
 *
 * With no connection selected the declared `required` fields stay required,
 * exactly as the package declared them. The rule is read off the form, never
 * from a list of vendor names.
 */
function patchOf(
  draft: Draft,
  baseline: Draft,
  settings: MediaSourceSettings,
  t: ReturnType<typeof useI18n>['t'],
  usingConnection = false,
): { readonly values?: Record<string, string | number | boolean | null>; readonly issue?: Issue } {
  const values: Record<string, string | number | boolean | null> = {};
  const required = new Set(usingConnection ? [] : (settings.schema.schema.required ?? []));
  for (const [key, property] of Object.entries(settings.schema.schema.properties)) {
    const next = draft[key];
    if (property.secret) {
      const secret = next as SecretDraft;
      if (secret.mode === 'set') values[key] = secret.value;
      else if (secret.mode === 'clear') values[key] = null;
      continue;
    }
    if (property.type === 'boolean') {
      if (next !== baseline[key]) values[key] = next as boolean;
      continue;
    }
    const text = (next as string).trim();
    if (text === '' && required.has(key) && property.default === undefined) {
      return { issue: { key, text: t('cap.settings.required') } };
    }
    if (text === (baseline[key] as string).trim()) continue;
    if (text === '') { values[key] = null; continue; }
    if (property.enum !== undefined && !property.enum.includes(text)) {
      return { issue: { key, text: t('cap.media.setting.choice') } };
    }
    if (property.type === 'number') {
      const value = Number(text);
      if (!Number.isFinite(value)) return { issue: { key, text: t('cap.settings.number') } };
      values[key] = value;
    } else values[key] = text;
  }
  return { values };
}

/** Whether this form is currently borrowing a connection rather than its own values. */
function connectionInUse(draft: Draft, connectionSetting: string | undefined): boolean {
  if (connectionSetting === undefined) return false;
  const value = draft[connectionSetting];
  return typeof value === 'string' && value.trim() !== '';
}

export function MediaSourceForm({
  provider,
  settings,
  connectionSetting,
  onSave,
  onReload,
  saving,
}: {
  /** `<pluginId>/<adapterId>`, used for the form's identity and ids. */
  readonly provider: string;
  readonly settings: MediaSourceSettings;
  /**
   * The one setting key that names a connection the reader already has, when
   * the provider's definition declares it. `undefined` for a provider that
   * manages its own credentials, which is a normal way to write one.
   */
  readonly connectionSetting?: string;
  /** The host's per-key write. The form then reads back through `onReload`
      rather than trusting the write's return value. */
  readonly onSave: (values: Record<string, string | number | boolean | null>) => Promise<void>;
  /** Read the stored values back — the honest check that a save landed. */
  readonly onReload: () => Promise<MediaSourceSettings>;
  readonly saving?: boolean;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const dirty = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  // A selected connection and a package's own required fields are alternatives.
  // These two flags are what keep the form from demanding both, and what let
  // the fields the connection covers read as met instead of outstanding.
  const usingConnection = draft !== null && connectionInUse(draft, connectionSetting);
  const connectionSettingKeys = new Set(connectionSetting === undefined ? [] : [connectionSetting]);
  useDirtyReporter(`media-source:${provider}`, dirty);

  // Re-seed only when the host's stored values actually change underneath, and
  // never over a draft the reader is still editing.
  useEffect(() => {
    if (dirty || busy) return;
    const next = draftOf(settings);
    setDraft(next);
    setBaseline(next);
  }, [settings, dirty, busy]);

  const entries = Object.entries(settings.schema.schema.properties);
  if (entries.length === 0) return null;

  const save = async () => {
    if (draft === null || baseline === null) return;
    const built = patchOf(draft, baseline, settings, t, connectionInUse(draft, connectionSetting));
    if (built.values === undefined) { setIssue(built.issue ?? null); return; }
    setIssue(null);
    if (Object.keys(built.values).length === 0) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onSave(built.values);
      // Read back rather than trusting the write: a host that accepted a key
      // and stored a different value must be visible, not papered over.
      const echoed = await onReload();
      const next = draftOf(echoed);
      setDraft(next);
      setBaseline(next);
      setFeedback({ tone: 'success', text: t('cap.media.setting.saved') });
      pingSaved();
    } catch (failure) {
      // The draft stays exactly as typed. A failed save must not cost the
      // reader the values they just entered.
      setFeedback({ tone: 'error', text: errorText(locale, failure) });
    } finally {
      setBusy(false);
    }
  };

  if (draft === null || baseline === null) return null;
  const secrets = new Set(settings.secretsConfigured);
  const disabled = busy || saving === true;

  return (
    <section data-media-source-settings={provider} className="min-w-0 space-y-4">
      <fieldset disabled={disabled} className="min-w-0 space-y-5 disabled:opacity-60">
        {entries.map(([key, property]) => (
          <SettingField
            key={key}
            fieldKey={key}
            provider={provider}
            property={property}
            value={draft[key]}
            baseline={baseline[key]}
            secretStored={secrets.has(key)}
            issue={issue?.key === key ? issue.text : undefined}
            {...(key === connectionSetting
              ? { connection: true, connectionSelected: usingConnection }
              : usingConnection && !connectionSettingKeys.has(key)
                ? { satisfiedByConnection: true }
                : {})}
            onChange={(next) => { setDraft({ ...draft, [key]: next }); setIssue(null); }}
          />
        ))}
      </fieldset>
      <SettingsDraftFooter
        saved={justSaved}
        id={`media-source-${provider}`}
        dirty={dirty}
        saving={busy}
        onSave={() => { void save(); }}
        onDiscard={() => { setDraft(baseline); setIssue(null); setFeedback(null); }}
      />
      <FeedbackLine feedback={feedback} />
    </section>
  );
}

function SettingField({
  fieldKey,
  provider,
  property,
  value,
  secretStored,
  issue,
  connection,
  connectionSelected,
  satisfiedByConnection,
  onChange,
}: {
  readonly fieldKey: string;
  readonly provider: string;
  readonly property: MediaSettingProperty;
  readonly value: string | boolean | SecretDraft | undefined;
  readonly baseline: string | boolean | SecretDraft | undefined;
  readonly secretStored: boolean;
  readonly issue?: string;
  /** This field names a connection the reader already has. */
  readonly connection?: boolean;
  /** That connection is the one currently chosen. */
  readonly connectionSelected?: boolean;
  /**
   * The chosen connection covers this field. It is drawn, not hidden: a reader
   * who is about to switch back to their own key needs to see what it was, and
   * a provider that manages its own credentials needs to be able to say so.
   */
  readonly satisfiedByConnection?: boolean;
  readonly onChange: (next: string | boolean | SecretDraft) => void;
}) {
  const { t } = useI18n();
  const label = property.title ?? fieldKey;
  const help = property.description === undefined ? null
    : <p className="text-[12px] leading-snug text-ink-faint">{property.description}</p>;
  const fieldId = `media-setting-${provider}-${fieldKey}`;

  // The one field a provider may declare as naming a connection the reader
  // already has. Drawn as a picker over the existing connection list — the
  // same list the Connections page manages, with the same stored credentials —
  // so choosing one does not create a second account anywhere and never shows
  // a key. A provider that does not declare it falls through to the ordinary
  // string field below, which is the correct shape for a script that brings
  // its own endpoint or reads its own environment.
  if (connection === true) {
    return (
      <ConnectionSettingField
        fieldKey={fieldKey}
        provider={provider}
        property={property}
        value={(value as string) ?? ''}
        issue={issue}
        help={help}
        selected={connectionSelected === true}
        onChange={onChange}
      />
    );
  }

  if (property.secret) {
    const secret = value as SecretDraft;
    return (
      <div data-media-setting={fieldKey} className="flex max-w-md flex-wrap items-start gap-2">
        <div className="min-w-0 flex-[1_1_18rem]">
          <SecretField
            id={fieldId}
            label={label}
            source={secretStored ? 'kiki' : 'none'}
            draft={secret}
            disabled={secret.mode === 'clear'}
            onChange={(next) => { onChange(next); }}
            placeholder={t(secretStored ? 'cap.settings.secretReplace' : 'st.secret.newPlaceholder')}
            sourceText={t(secret.mode === 'clear' ? 'cap.settings.secretRemovePending' : secretStored ? 'cap.settings.secretSet' : 'cap.settings.secretUnset')}
            hint={property.description}
          />
          {satisfiedByConnection === true ? <CoveredNote /> : null}
        </div>
        {secretStored ? (
          <button
            type="button"
            className={`${SECONDARY_BUTTON} mt-[1.625rem] h-8`}
            data-media-secret-remove={fieldKey}
            onClick={() => { onChange(secret.mode === 'clear' ? KEEP_SECRET : { mode: 'clear' }); }}
          >
            {t(secret.mode === 'clear' ? 'st.secret.undoClear' : 'cap.settings.secretRemove')}
          </button>
        ) : null}
      </div>
    );
  }

  if (property.type === 'boolean') {
    return (
      <div data-media-setting={fieldKey} className="max-w-md space-y-1">
        <Toggle layout="row" label={label} checked={value as boolean} onChange={(checked) => { onChange(checked); }} />
        {help}
      </div>
    );
  }

  // A declared fixed choice is a select, not a free text field: a reader who
  // types "2K" into a field the package declared as ["768P","2K"] has made a
  // typo the host would reject three layers down.
  if (property.enum !== undefined && property.enum.length > 0) {
    return (
      <div data-media-setting={fieldKey} className="max-w-md space-y-1">
        <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink">{label}</label>
        <select
          id={fieldId}
          className={`${INPUT} ${issue !== undefined ? 'border-danger' : ''}`}
          value={(value as string) ?? ''}
          aria-invalid={issue !== undefined}
          onChange={(event) => { onChange(event.target.value); }}
        >
          <option value="">{t('cap.media.setting.notSet')}</option>
          {property.enum.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {issue !== undefined ? <p role="alert" className="text-[12px] text-danger">{issue}</p> : null}
        {help}
      </div>
    );
  }

  return (
    <div data-media-setting={fieldKey} className="max-w-md space-y-1">
      <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink">{label}</label>
      <input
        id={fieldId}
        className={`${INPUT} ${property.type === 'number' ? 'font-mono' : ''} ${issue !== undefined ? 'border-danger' : ''}`}
        inputMode={property.type === 'number' ? 'decimal' : undefined}
        aria-invalid={issue !== undefined}
        placeholder={property.default === undefined ? undefined : String(property.default)}
        value={(value as string) ?? ''}
        onChange={(event) => { onChange(event.target.value); }}
      />
      {issue !== undefined ? <p role="alert" className="text-[12px] text-danger">{issue}</p> : null}
      {help}
    </div>
  );
}

/**
 * A field that names one of the reader's existing connections.
 *
 * The list is the ordinary connection catalog (`client.listProviders()`), the
 * same one the Connections page manages — not a second account store and not a
 * filtered "media only" view, because a connection is a connection and having
 * two lists of them is how a reader ends up unsure which one a request used.
 *
 * What each row says is only what is true without asking anything: the id, the
 * kind, and whether a credential is stored. No header value, no key, no token
 * — those are never read into the browser for this, and never written back out.
 *
 * The empty choice is a real choice: it means "this provider manages its own
 * credentials", which is how a script that brings its own environment or its
 * own key file is meant to work. It is not a validation error, and a provider
 * with no connection chosen is not reported as broken.
 */
function ConnectionSettingField({
  fieldKey,
  provider,
  property,
  value,
  issue,
  help,
  selected,
  onChange,
}: {
  readonly fieldKey: string;
  readonly provider: string;
  readonly property: MediaSettingProperty;
  readonly value: string;
  readonly issue?: string;
  readonly help: ReactNode;
  /** A connection is chosen, so this package's own key is not being used. */
  readonly selected: boolean;
  readonly onChange: (next: string) => void;
}) {
  const { client } = useConnection();
  const { t, tp } = useI18n();
  const query = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const connections = query.data?.items ?? [];
  const fieldId = `media-setting-${provider}-${fieldKey}`;
  const label = property.title ?? fieldKey;

  return (
    <div data-media-setting={fieldKey} data-media-setting-kind="connection" className="max-w-md space-y-1">
      <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink">{label}</label>
      {connections.length === 0 && !query.isPending ? (
        <>
          <p className="text-[12px] text-ink-faint" data-media-connection-empty>{t('cap.media.connection.none')}</p>
          <input
            id={fieldId}
            className={`${INPUT} font-mono`}
            value={value}
            placeholder={property.default === undefined ? undefined : String(property.default)}
            onChange={(event) => { onChange(event.target.value); }}
          />
        </>
      ) : (
        <select
          id={fieldId}
          className={`${INPUT} ${issue !== undefined ? 'border-danger' : ''}`}
          value={value}
          aria-invalid={issue !== undefined}
          data-media-connection-select
          onChange={(event) => { onChange(event.target.value); }}
        >
          <option value="">{t('cap.media.connection.selfManaged')}</option>
          {connections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} · {t(`st.connections.kind.${item.type === 'account' ? 'account' : 'api'}` as Parameters<typeof t>[0])}
              {item.has_api_key || item.oauth?.signed_in === true ? ` · ${tp('cap.media.connection.hasCredential', 1)}` : ''}
            </option>
          ))}
        </select>
      )}
      {issue !== undefined ? <p role="alert" className="text-[12px] text-danger">{issue}</p> : null}
      {selected ? (
        <p className="text-[12px] leading-snug text-ink-soft" data-media-connection-active>
          {t('cap.media.connection.active')}
        </p>
      ) : (
        <p className="max-w-[52ch] text-[12px] leading-snug text-ink-faint" data-media-connection-hint>{t('cap.media.connection.hint')}</p>
      )}
      {help}
    </div>
  );
}

/**
 * "The connection you chose covers this." One quiet line, attached to the
 * fields it applies to, so a reader can see the alternative is real without
 * the form pretending their own key is filled in — the value is untouched and
 * comes back the moment they switch back.
 */
function CoveredNote() {
  const { t } = useI18n();
  return (
    <p className="mt-1 text-[11px] leading-4 text-ink-faint" data-media-covered-by-connection>
      {t('cap.media.connection.covers')}
    </p>
  );
}
