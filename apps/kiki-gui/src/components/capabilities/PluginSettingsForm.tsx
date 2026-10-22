/**
 * Plugin detail → Settings: the form a plugin declares in its manifest
 * (`kiki.settings`), stored under `[plugin_settings.<id>]`. Plain values are
 * read back; secret values are only reported as set, and are edited through
 * the shared SecretField without a reveal route.
 *
 * Optional property metadata (`hidden`, `group`, `groupTitle`, `enum`,
 * `multiline`, `advanced`) is the generic layout. A plugin with its own
 * settings panel does not land here; this form is the one every other plugin
 * gets, including a panel the host cannot open.
 *
 * Field text is resolved per language by `localizeSettingText`, the same rule
 * the media source form uses, so a translated property reads the same on every
 * settings route.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PluginSettingsResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { localizeSettingText, type SettingTextSource } from '../../lib/settingText';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, Toggle, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../settings/SecretField';
import { SettingsDraftFooter } from '../settings/SettingsPrimitives';
import { useSavedTick } from '../settings/useSavedTick';

interface Property extends SettingTextSource {
  readonly type: 'string' | 'boolean' | 'number';
  readonly secret?: boolean;
  readonly default?: string | number | boolean;
  readonly hidden?: boolean;
  readonly group?: string;
  readonly enum?: readonly string[];
  readonly multiline?: boolean;
  readonly advanced?: boolean;
}

interface SettingsSchema {
  readonly schema: { readonly properties: Readonly<Record<string, Property>>; readonly required?: readonly string[] };
}

type Draft = Record<string, string | boolean | SecretDraft>;

/** A hidden boolean whose key is the engine's removed tombstone. The raw key stays off the page; a true value is a Restore. */
function isRemovedTombstone(key: string, property: Property): boolean {
  return property.hidden === true && property.type === 'boolean' && key.endsWith('__removed');
}

function schemaOf(view: PluginSettingsResponse | undefined): SettingsSchema | undefined {
  const schema = view?.schema as SettingsSchema | undefined;
  return schema?.schema?.properties === undefined ? undefined : schema;
}

function draftOf(view: PluginSettingsResponse, schema: SettingsSchema): Draft {
  const draft: Draft = {};
  for (const [key, property] of Object.entries(schema.schema.properties)) {
    if (property.hidden === true && !isRemovedTombstone(key, property)) continue;
    if (property.secret) { draft[key] = KEEP_SECRET; continue; }
    const stored = view.values[key];
    if (property.type === 'boolean') draft[key] = typeof stored === 'boolean' ? stored : property.default === true;
    else draft[key] = stored === undefined ? '' : String(stored);
  }
  return draft;
}

type Issue = { readonly key: string; readonly text: string };

/** Only changed keys; an emptied plain value or a cleared secret is sent as null. Hidden tombstones other than Restore are never written. */
function patchOf(draft: Draft, baseline: Draft, schema: SettingsSchema, t: ReturnType<typeof useI18n>['t']): { values?: Record<string, string | number | boolean | null>; issue?: Issue } {
  const values: Record<string, string | number | boolean | null> = {};
  const required = new Set(schema.schema.required ?? []);
  for (const [key, property] of Object.entries(schema.schema.properties)) {
    if (property.hidden === true && !isRemovedTombstone(key, property)) continue;
    const next = draft[key];
    if (next === undefined) continue;
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

interface GroupChip {
  readonly id: string;
  readonly title: string;
}

function groupsOf(schema: SettingsSchema, locale: string): readonly GroupChip[] {
  const groups: GroupChip[] = [];
  for (const property of Object.values(schema.schema.properties)) {
    if (property.group === undefined || groups.some((group) => group.id === property.group)) continue;
    groups.push({ id: property.group, title: localizeSettingText(property, locale).groupTitle ?? property.group });
  }
  return groups;
}

export function PluginSettingsForm({
  pluginId,
  showEmptyNote = false,
}: {
  readonly pluginId: string;
  readonly showEmptyNote?: boolean;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = ['plugin-settings', pluginId] as const;
  const query = useQuery({ queryKey, queryFn: () => client.getPluginSettings(pluginId) });
  const view = query.data;
  const schema = schemaOf(view);
  const hasConnectionFields = schema !== undefined && Object.keys(schema.schema.properties).some(
    (key) => key === 'connectionId' || key.endsWith('__connectionId'),
  );
  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.listProviders(),
    enabled: hasConnectionFields && typeof client.listProviders === 'function',
    staleTime: 60_000,
  });
  const providers = providersQuery.data?.items ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
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
  if (view === undefined) return null;
  if (schema === undefined || Object.keys(schema.schema.properties).length === 0) {
    return showEmptyNote ? (
      <p className="text-[13px] text-ink-faint" data-plugin-settings-none>{t('cap.settings.none')}</p>
    ) : null;
  }
  if (draft === null || baseline === null) return null;
  const entries = Object.entries(schema.schema.properties);
  const secrets = new Set(view.secretsConfigured);
  const groups = groupsOf(schema, locale);
  const selected = groups.some((group) => group.id === groupId) ? groupId : groups[0]?.id;
  const removedGroups = new Set(entries.flatMap(([key, property]) => (
    isRemovedTombstone(key, property) && draft[key] === true && property.group !== undefined ? [property.group] : []
  )));

  const visible = entries.filter(([key, property]) => {
    if (property.hidden === true && !isRemovedTombstone(key, property)) return false;
    if (isRemovedTombstone(key, property)) {
      if (draft[key] !== true) return false;
      if (property.group === undefined) return true;
      return groups.length < 2 || property.group === selected;
    }
    if (property.group !== undefined && removedGroups.has(property.group)) return false;
    if (property.group === undefined) return true;
    return groups.length < 2 || property.group === selected;
  });
  if (visible.length === 0 && groups.length === 0) {
    return showEmptyNote ? (
      <p className="text-[13px] text-ink-faint" data-plugin-settings-none>{t('cap.settings.none')}</p>
    ) : null;
  }
  const ordinary = visible.filter(([, property]) => property.advanced !== true);
  const ungroupedOrdinary = groups.length >= 2
    ? ordinary.filter(([, property]) => property.group === undefined)
    : ordinary;
  const groupedOrdinary = groups.length >= 2
    ? ordinary.filter(([, property]) => property.group !== undefined).sort(([keyA, propA], [keyB, propB]) => {
      const aEnabled = keyA.endsWith('__enabled') && propA.type === 'boolean' ? 0 : 1;
      const bEnabled = keyB.endsWith('__enabled') && propB.type === 'boolean' ? 0 : 1;
      return aEnabled - bEnabled;
    })
    : [];
  const advanced = visible.filter(([, property]) => property.advanced === true);

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

  const renderField = (key: string, property: Property) => {
    const { title, description, groupTitle } = localizeSettingText(property, locale);
    const label = title ?? key;
    const help = description === undefined ? null
      : <p className="text-[12px] leading-snug text-ink-faint">{description}</p>;
    const fieldId = `plugin-setting-${pluginId}-${key}`;
    if (isRemovedTombstone(key, property)) {
      return (
        <div key={key} data-plugin-setting={key} className="flex max-w-xl flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] text-ink">{groupTitle ?? label}</p>
          <button type="button" className={`${SECONDARY_BUTTON} h-8`} data-plugin-setting-restore={key}
            onClick={() => { setDraft({ ...draft, [key]: false }); }}>
            {t('menu.restore')}
          </button>
        </div>
      );
    }
    if (property.secret) {
      const secret = draft[key] as SecretDraft;
      const stored = secrets.has(key);
      return (
        <div key={key} data-plugin-setting={key} className="flex max-w-xl flex-wrap items-start gap-2">
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
              hint={description}
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
        <div key={key} data-plugin-setting={key} className="max-w-xl space-y-1">
          <Toggle layout="row" label={label} checked={draft[key] as boolean}
            onChange={(checked) => { setDraft({ ...draft, [key]: checked }); }} />
          {help}
        </div>
      );
    }
    const isConnectionField = property.type === 'string' && (key === 'connectionId' || key.endsWith('__connectionId') || key === 'connection' || key.endsWith('__connection'));
    const choices = property.type === 'string' && property.enum !== undefined && property.enum.length > 0 ? property.enum : undefined;
    const currentText = (draft[key] as string) ?? '';
    const control = isConnectionField && providers.length > 0 ? (
      <select id={fieldId} data-plugin-setting-connection={key} className={`${INPUT} h-8 py-1 ${issue?.key === key ? 'border-danger' : ''}`}
        aria-invalid={issue?.key === key}
        value={currentText}
        onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }); setIssue(null); }}>
        <option value="">{t('cap.media.connection.selfManaged')}</option>
        {currentText !== '' && !providers.some((item) => item.id === currentText) ? (
          <option value={currentText}>{currentText}</option>
        ) : null}
        {providers.map((item) => {
          const customName = (item as { name?: string }).name;
          return (
            <option key={item.id} value={item.id}>
              {customName && customName !== item.id ? `${customName} (${item.id})` : item.id} · {t(`st.connections.kind.${item.type === 'account' ? 'account' : 'api'}` as Parameters<typeof t>[0])}
              {item.has_api_key || item.oauth?.signed_in === true ? ` · ${tp('cap.media.connection.hasCredential', 1)}` : ''}
            </option>
          );
        })}
      </select>
    ) : choices !== undefined ? (
      <select id={fieldId} className={`${INPUT} h-8 py-1 ${issue?.key === key ? 'border-danger' : ''}`}
        aria-invalid={issue?.key === key}
        value={currentText}
        onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }); setIssue(null); }}>
        <option value="">{property.default === undefined ? t('cap.media.setting.notSet') : String(property.default)}</option>
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    ) : property.multiline === true ? (
      <textarea id={fieldId} rows={3} className={`${INPUT} min-h-[4.5rem] py-1 ${issue?.key === key ? 'border-danger' : ''}`}
        aria-invalid={issue?.key === key}
        placeholder={property.default === undefined ? undefined : String(property.default)}
        value={currentText}
        onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }); setIssue(null); }} />
    ) : (
      <input id={fieldId} className={`${INPUT} h-8 py-1 ${property.type === 'number' || isConnectionField ? 'font-mono' : ''} ${issue?.key === key ? 'border-danger' : ''}`}
        inputMode={property.type === 'number' ? 'decimal' : undefined}
        aria-invalid={issue?.key === key}
        placeholder={property.default === undefined ? undefined : String(property.default)}
        value={currentText}
        onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }); setIssue(null); }} />
    );
    return (
      <div key={key} data-plugin-setting={key} className="max-w-xl space-y-1">
        <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink">{label}</label>
        {control}
        {issue?.key === key ? <p role="alert" className="text-[12px] text-danger">{issue.text}</p> : null}
        {help}
      </div>
    );
  };

  return (
    <section data-plugin-settings={pluginId} className="space-y-4">
      <h2 className="text-[13px] font-medium text-ink">{t('cap.settings.title')}</h2>
      <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
        {ungroupedOrdinary.length > 0 ? (
          <div data-plugin-settings-global className={groups.length >= 2 && ungroupedOrdinary.length > 1 ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-3'}>
            {ungroupedOrdinary.map(([key, property]) => renderField(key, property))}
          </div>
        ) : null}
        {groups.length >= 2 ? (
          <div className="space-y-3 border-t border-hairline pt-3">
            <div className="flex flex-wrap gap-1.5" role="tablist" data-plugin-setting-groups>
              {groups.map((group) => (
                <button key={group.id} type="button" role="tab" aria-selected={group.id === selected}
                  data-plugin-setting-group={group.id}
                  className={`h-7 rounded-md border px-2.5 text-[12px] transition-colors ${group.id === selected ? 'border-ink bg-selected font-medium text-selected-ink' : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'}`}
                  onClick={() => { setGroupId(group.id); }}>
                  {group.title}
                </button>
              ))}
            </div>
            {groupedOrdinary.length > 0 ? (
              <div className="space-y-3 rounded-lg border border-hairline bg-panel/30 p-3.5" data-plugin-setting-group-panel={selected}>
                {groupedOrdinary.map(([key, property]) => renderField(key, property))}
              </div>
            ) : null}
          </div>
        ) : null}
        {advanced.length > 0 ? (
          <details data-plugin-settings-advanced className="border-t border-hairline pt-3">
            <summary className="cursor-pointer text-[12px] font-medium text-ink-soft hover:text-ink">{t('st.advanced.disclosure')}</summary>
            <div className="mt-3 space-y-3">
              {advanced.map(([key, property]) => renderField(key, property))}
            </div>
          </details>
        ) : null}
      </fieldset>
      <div className="sticky bottom-0 z-10 bg-paper/95 py-2 backdrop-blur-[2px]" data-plugin-settings-sticky-footer>
        <SettingsDraftFooter saved={justSaved} id={`plugin-settings-${pluginId}`} dirty={dirty} saving={saving}
          onSave={() => void save()}
          onDiscard={() => { setDraft(baseline); setIssue(null); setFeedback(null); }} />
        <FeedbackLine feedback={feedback} />
      </div>
    </section>
  );
}
