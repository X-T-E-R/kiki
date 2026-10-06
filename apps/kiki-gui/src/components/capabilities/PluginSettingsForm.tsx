/**
 * Plugin detail → Settings: the form a plugin declares in its manifest
 * (`kiki.settings`), stored under `[plugin_settings.<id>]`. Plain values are
 * read back; secret values are only reported as set, and are edited through
 * the shared SecretField without a reveal route.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PluginSettingsResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, Toggle, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../settings/SecretField';
import { SettingsDraftFooter } from '../settings/SettingsPrimitives';
import { useSavedTick } from '../settings/useSavedTick';

interface Property {
  readonly type: 'string' | 'boolean' | 'number';
  readonly title?: string;
  readonly description?: string;
  readonly secret?: boolean;
  readonly default?: string | number | boolean;
}

interface SettingsSchema {
  readonly schema: { readonly properties: Readonly<Record<string, Property>>; readonly required?: readonly string[] };
}

type Draft = Record<string, string | boolean | SecretDraft>;

function schemaOf(view: PluginSettingsResponse | undefined): SettingsSchema | undefined {
  const schema = view?.schema as SettingsSchema | undefined;
  return schema?.schema?.properties === undefined ? undefined : schema;
}

function draftOf(view: PluginSettingsResponse, schema: SettingsSchema): Draft {
  const draft: Draft = {};
  for (const [key, property] of Object.entries(schema.schema.properties)) {
    if (property.secret) { draft[key] = KEEP_SECRET; continue; }
    const stored = view.values[key];
    if (property.type === 'boolean') draft[key] = typeof stored === 'boolean' ? stored : property.default === true;
    else draft[key] = stored === undefined ? '' : String(stored);
  }
  return draft;
}

type Issue = { readonly key: string; readonly text: string };

/** Only changed keys; an emptied plain value or a cleared secret is sent as null. */
function patchOf(draft: Draft, baseline: Draft, schema: SettingsSchema, t: ReturnType<typeof useI18n>['t']): { values?: Record<string, string | number | boolean | null>; issue?: Issue } {
  const values: Record<string, string | number | boolean | null> = {};
  const required = new Set(schema.schema.required ?? []);
  for (const [key, property] of Object.entries(schema.schema.properties)) {
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
    if (text === '' && required.has(key) && property.default === undefined) return { issue: { key, text: t('cap.settings.required') } };
    if (text === (baseline[key] as string).trim()) continue;
    if (text === '') { values[key] = null; continue; }
    if (property.type === 'number') {
      const value = Number(text);
      if (!Number.isFinite(value)) return { issue: { key, text: t('cap.settings.number') } };
      values[key] = value;
    } else values[key] = text;
  }
  return { values };
}

export function PluginSettingsForm({ pluginId }: { readonly pluginId: string }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = ['plugin-settings', pluginId] as const;
  const query = useQuery({ queryKey, queryFn: () => client.getPluginSettings(pluginId) });
  const view = query.data;
  const schema = schemaOf(view);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const dirty = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  useDirtyReporter(`plugin-settings:${pluginId}`, dirty);

  useEffect(() => {
    if (view === undefined || schema === undefined || dirty || saving) return;
    const next = draftOf(view, schema);
    setDraft(next);
    setBaseline(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- schema derives from view
  }, [view, dirty, saving]);

  if (query.isError) return <InlineError error={query.error} />;
  // A plugin without a settings form shows nothing here.
  if (view === undefined || schema === undefined || draft === null || baseline === null) return null;
  const entries = Object.entries(schema.schema.properties);
  if (entries.length === 0) return null;
  const secrets = new Set(view.secretsConfigured);

  const save = async () => {
    const built = patchOf(draft, baseline, schema, t);
    if (built.values === undefined) { setIssue(built.issue ?? null); return; }
    setIssue(null);
    if (Object.keys(built.values).length === 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.setPluginSettings(pluginId, built.values);
      queryClient.setQueryData(queryKey, echoed);
      const next = draftOf(echoed, schemaOf(echoed) ?? schema);
      setDraft(next);
      setBaseline(next);
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-plugin-settings={pluginId} className="space-y-4">
      {/* The form names itself wherever it renders: on this plugin's own page
          it is the subject, not a block inside something else's heading. */}
      <h2 className="text-[13px] font-medium text-ink">{t('cap.settings.title')}</h2>
      <fieldset disabled={saving} className="min-w-0 space-y-5 disabled:opacity-60">
        {entries.map(([key, property]) => {
          const label = property.title ?? key;
          const help = property.description === undefined ? null
            : <p className="text-[12px] leading-snug text-ink-faint">{property.description}</p>;
          const fieldId = `plugin-setting-${pluginId}-${key}`;
          if (property.secret) {
            const secret = draft[key] as SecretDraft;
            const stored = secrets.has(key);
            // Write-only: no reveal route, so the field only takes a new value;
            // removing the stored one is a separate, staged action.
            return (
              <div key={key} data-plugin-setting={key} className="flex max-w-md flex-wrap items-start gap-2">
                <div className="min-w-0 flex-[1_1_18rem]">
                  <SecretField
                    id={fieldId}
                    label={label}
                    source={stored ? 'kiki' : 'none'}
                    draft={secret}
                    disabled={secret.mode === 'clear'}
                    onChange={(next) => { setDraft({ ...draft, [key]: next }); }}
                    placeholder={t(stored ? 'cap.settings.secretReplace' : 'st.secret.newPlaceholder')}
                    sourceText={t(secret.mode === 'clear' ? 'cap.settings.secretRemovePending' : stored ? 'cap.settings.secretSet' : 'cap.settings.secretUnset')}
                    hint={property.description}
                  />
                </div>
                {stored ? (
                  <button type="button" className={`${SECONDARY_BUTTON} mt-[1.625rem] h-8`} data-plugin-secret-remove={key}
                    onClick={() => { setDraft({ ...draft, [key]: secret.mode === 'clear' ? KEEP_SECRET : { mode: 'clear' } }); }}>
                    {t(secret.mode === 'clear' ? 'st.secret.undoClear' : 'cap.settings.secretRemove')}
                  </button>
                ) : null}
              </div>
            );
          }
          if (property.type === 'boolean') {
            return (
              <div key={key} data-plugin-setting={key} className="max-w-md space-y-1">
                <Toggle layout="row" label={label} checked={draft[key] as boolean}
                  onChange={(checked) => { setDraft({ ...draft, [key]: checked }); }} />
                {help}
              </div>
            );
          }
          return (
            <div key={key} data-plugin-setting={key} className="max-w-md space-y-1">
              <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink">{label}</label>
              <input id={fieldId} className={`${INPUT} ${property.type === 'number' ? 'font-mono' : ''} ${issue?.key === key ? 'border-danger' : ''}`}
                inputMode={property.type === 'number' ? 'decimal' : undefined}
                aria-invalid={issue?.key === key}
                placeholder={property.default === undefined ? undefined : String(property.default)}
                value={draft[key] as string}
                onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }); setIssue(null); }} />
              {issue?.key === key ? <p role="alert" className="text-[12px] text-danger">{issue.text}</p> : null}
              {help}
            </div>
          );
        })}
      </fieldset>
      <SettingsDraftFooter saved={justSaved} id={`plugin-settings-${pluginId}`} dirty={dirty} saving={saving}
        onSave={() => void save()}
        onDiscard={() => { setDraft(baseline); setIssue(null); setFeedback(null); }} />
      <FeedbackLine feedback={feedback} />
    </section>
  );
}
