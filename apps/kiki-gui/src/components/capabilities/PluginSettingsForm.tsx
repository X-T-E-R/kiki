/**
 * The form a plugin declares in its manifest (`kiki.settings`), stored under
 * `[plugin_settings.<id>]`. Plain values are read back; secret values are only
 * reported as set, and are edited through the shared SecretField.
 *
 * Layout follows the reader, not the schema:
 *   - ungrouped fields are ordinary setting rows (label left, control right);
 *   - each `group` (one provider, one source) is a row of its own: its name, a
 *     one-line summary, and its `<group>__enabled` switch when it has one.
 *     Pressing the row opens that group's fields under it; the switch is the
 *     only thing that turns the group on or off;
 *   - a removed group (`<group>__removed`) is a quiet row with Restore;
 *   - `advanced` fields fold away, inside their group or at the bottom.
 * One save bar covers the whole form.
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
import { Icon } from '../icons';
import { INPUT, INPUT_BOX, SECONDARY_BUTTON } from '../ui';
import { SettingField } from '../settings/fields';
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
type Entry = readonly [string, Property];

/** A hidden boolean whose key is the engine's removed tombstone. The raw key stays off the page; a true value is a Restore. */
function isRemovedTombstone(key: string, property: Property): boolean {
  return property.hidden === true && property.type === 'boolean' && key.endsWith('__removed');
}

function isGroupSwitch(key: string, property: Property): boolean {
  return property.group !== undefined && property.type === 'boolean' && key.endsWith('__enabled');
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

interface Group {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly Entry[];
  readonly switchKey?: string;
  readonly tombstoneKey?: string;
}

function groupsOf(entries: readonly Entry[], locale: string): readonly Group[] {
  const order: string[] = [];
  const byId = new Map<string, { title: string; fields: Entry[]; switchKey?: string; tombstoneKey?: string }>();
  for (const [key, property] of entries) {
    if (property.group === undefined) continue;
    let group = byId.get(property.group);
    if (group === undefined) {
      group = { title: property.group, fields: [] };
      byId.set(property.group, group);
      order.push(property.group);
    }
    const localized = localizeSettingText(property, locale).groupTitle;
    if (localized !== undefined && group.title === property.group) group.title = localized;
    if (isRemovedTombstone(key, property)) group.tombstoneKey = key;
    else if (property.hidden === true) continue;
    else if (isGroupSwitch(key, property) && group.switchKey === undefined) group.switchKey = key;
    else group.fields.push([key, property]);
  }
  return order.map((id) => ({ id, ...byId.get(id)! }));
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
  const [openGroup, setOpenGroup] = useState<string | null>(null);
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

  const none = showEmptyNote ? (
    <p className="text-[13px] text-ink-faint" data-plugin-settings-none>{t('cap.settings.none')}</p>
  ) : null;
  if (query.isError) return <InlineError error={query.error} />;
  if (view === undefined) return null;
  if (schema === undefined) return none;
  if (draft === null || baseline === null) return null;
  const entries: readonly Entry[] = Object.entries(schema.schema.properties);
  const secrets = new Set(view.secretsConfigured);
  const groups = groupsOf(entries, locale);
  const ungrouped = entries.filter(([key, property]) => property.group === undefined
    && (property.hidden !== true || (isRemovedTombstone(key, property) && draft[key] === true)));
  const plain = ungrouped.filter(([, property]) => property.advanced !== true);
  const advanced = ungrouped.filter(([, property]) => property.advanced === true);
  if (plain.length === 0 && advanced.length === 0 && groups.length === 0) return none;
  const edit = (key: string, value: Draft[string]) => { setDraft({ ...draft, [key]: value }); setIssue(null); };

  const save = async () => {
    const built = patchOf(draft, baseline, schema, t);
    if (built.values === undefined) {
      setIssue(built.issue ?? null);
      const owner = built.issue === undefined ? undefined : schema.schema.properties[built.issue.key]?.group;
      if (owner !== undefined) setOpenGroup(owner);
      return;
    }
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

  /** A plain-language line for a closed group row: what it is set to now. */
  const groupSummary = (group: Group): string => {
    const parts: string[] = [];
    for (const [key, property] of group.fields) {
      if (property.advanced === true) continue;
      if (property.secret) { if (secrets.has(key)) parts.push(t('cap.settings.summary.secretSet', { name: localizeSettingText(property, locale).title ?? key })); continue; }
      const value = draft[key];
      if (typeof value === 'string' && value.trim() !== '') {
        const isConnection = key.endsWith('__connectionId') || key.endsWith('__connection');
        const provider = isConnection ? providers.find((item) => item.id === value) : undefined;
        parts.push((provider as { name?: string } | undefined)?.name ?? value);
      }
    }
    return parts.length === 0 ? t('cap.settings.summary.empty') : parts.slice(0, 3).join(' · ');
  };

  const renderControl = (key: string, property: Property, fieldId: string, label: string) => {
    const invalid = issue?.key === key;
    const currentText = (draft[key] as string) ?? '';
    const isConnectionField = property.type === 'string' && (key === 'connectionId' || key.endsWith('__connectionId') || key === 'connection' || key.endsWith('__connection'));
    const choices = property.type === 'string' && property.enum !== undefined && property.enum.length > 0 ? property.enum : undefined;
    const border = invalid ? 'border-danger' : '';
    if (isConnectionField && providers.length > 0) {
      return (
        <select id={fieldId} data-plugin-setting-connection={key} className={`${INPUT_BOX} h-8 w-64 py-1 ${border}`} aria-invalid={invalid}
          value={currentText} onChange={(event) => { edit(key, event.target.value); }}>
          <option value="">{t('cap.media.connection.selfManaged')}</option>
          {currentText !== '' && !providers.some((item) => item.id === currentText) ? <option value={currentText}>{currentText}</option> : null}
          {providers.map((item) => {
            const customName = (item as { name?: string }).name;
            return (
              <option key={item.id} value={item.id}>
                {customName !== undefined && customName !== '' ? customName : item.id}
                {item.has_api_key || item.oauth?.signed_in === true ? ` · ${tp('cap.media.connection.hasCredential', 1)}` : ''}
              </option>
            );
          })}
        </select>
      );
    }
    if (choices !== undefined) {
      return (
        <select id={fieldId} className={`${INPUT_BOX} h-8 w-64 py-1 ${border}`} aria-invalid={invalid}
          value={currentText} onChange={(event) => { edit(key, event.target.value); }}>
          <option value="">{property.default === undefined ? t('cap.media.setting.notSet') : String(property.default)}</option>
          {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      );
    }
    if (property.multiline === true) {
      return (
        <textarea id={fieldId} rows={3} aria-label={label} className={`${INPUT} min-h-[4.5rem] w-full py-1 ${border}`} aria-invalid={invalid}
          placeholder={property.default === undefined ? undefined : String(property.default)}
          value={currentText} onChange={(event) => { edit(key, event.target.value); }} />
      );
    }
    return (
      <input id={fieldId} className={`${INPUT_BOX} h-8 w-64 py-1 ${property.type === 'number' ? 'font-mono' : ''} ${border}`}
        inputMode={property.type === 'number' ? 'decimal' : undefined} aria-invalid={invalid}
        placeholder={property.default === undefined ? undefined : String(property.default)}
        value={currentText} onChange={(event) => { edit(key, event.target.value); }} />
    );
  };

  const renderField = (key: string, property: Property) => {
    const { title, description, groupTitle } = localizeSettingText(property, locale);
    const label = title ?? key;
    const fieldId = `plugin-setting-${pluginId}-${key}`;
    if (isRemovedTombstone(key, property)) {
      return (
        <div key={key} data-plugin-setting={key} className="flex flex-wrap items-center gap-2 py-1">
          <p className="min-w-0 flex-1 text-[13px] text-ink-soft">{t('cap.settings.removed', { name: groupTitle ?? label })}</p>
          <button type="button" className={`${SECONDARY_BUTTON} h-8`} data-plugin-setting-restore={key} onClick={() => { edit(key, false); }}>
            {t('menu.restore')}
          </button>
        </div>
      );
    }
    if (property.secret) {
      const secret = draft[key] as SecretDraft;
      const stored = secrets.has(key);
      return (
        <div key={key} data-plugin-setting={key} className="flex flex-wrap items-start gap-2 py-1">
          <div className="min-w-0 flex-[1_1_18rem]">
            <SecretField id={fieldId} label={label} source={stored ? 'kiki' : 'none'} draft={secret}
              disabled={secret.mode === 'clear'} onChange={(next) => { edit(key, next); }}
              placeholder={t(stored ? 'cap.settings.secretReplace' : 'st.secret.newPlaceholder')}
              sourceText={t(secret.mode === 'clear' ? 'cap.settings.secretRemovePending' : stored ? 'cap.settings.secretSet' : 'cap.settings.secretUnset')}
              hint={description} />
          </div>
          {stored ? (
            <button type="button" className={`${SECONDARY_BUTTON} mt-[1.625rem] h-8`} data-plugin-secret-remove={key}
              onClick={() => { edit(key, secret.mode === 'clear' ? KEEP_SECRET : { mode: 'clear' }); }}>
              {t(secret.mode === 'clear' ? 'st.secret.undoClear' : 'cap.settings.secretRemove')}
            </button>
          ) : null}
        </div>
      );
    }
    if (property.type === 'boolean') {
      return (
        <div key={key} data-plugin-setting={key}>
          <SettingField label={label} htmlFor={fieldId} help={description}>
            <Toggle id={fieldId} layout="bare" label={label} checked={draft[key] as boolean} onChange={(checked) => { edit(key, checked); }} />
          </SettingField>
        </div>
      );
    }
    return (
      <div key={key} data-plugin-setting={key}>
        <SettingField label={label} htmlFor={fieldId} help={description} layout={property.multiline === true ? 'stack' : 'row'}>
          {renderControl(key, property, fieldId, label)}
          {issue?.key === key ? <p role="alert" className="basis-full text-[12px] text-danger">{issue.text}</p> : null}
        </SettingField>
      </div>
    );
  };

  const advancedFold = (fields: readonly Entry[], attr?: string) => fields.length === 0 ? null : (
    <details data-plugin-settings-advanced={attr ?? ''} className="group/adv pt-1">
      <summary className="flex cursor-pointer list-none items-center gap-1 py-1 text-[12px] text-ink-soft hover:text-ink">
        <Icon name="chevron" size={12} className="transition-transform group-open/adv:rotate-90" />
        {t('st.advanced.disclosure')}
      </summary>
      <div className="mt-1 divide-y divide-hairline">{fields.map(([key, property]) => renderField(key, property))}</div>
    </details>
  );

  const renderGroup = (group: Group) => {
    const removed = group.tombstoneKey !== undefined && draft[group.tombstoneKey] === true;
    if (removed) {
      const [key, property] = entries.find(([candidate]) => candidate === group.tombstoneKey)!;
      return <li key={group.id} data-plugin-setting-group={group.id} data-plugin-setting-group-removed className="px-3">{renderField(key, property)}</li>;
    }
    const open = openGroup === group.id;
    const on = group.switchKey === undefined ? undefined : draft[group.switchKey] === true;
    const hasIssue = issue !== null && group.fields.some(([key]) => key === issue.key);
    return (
      <li key={group.id} data-plugin-setting-group={group.id} data-open={open ? 'true' : undefined}>
        <div className="flex min-h-12 items-center gap-3 px-3">
          <button type="button" aria-expanded={open} data-plugin-setting-group-open={group.id}
            onClick={() => { setOpenGroup(open ? null : group.id); }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink">
            <Icon name="chevron" size={12} className={`shrink-0 text-ink-faint transition-transform duration-[var(--kiki-motion-quick)] ${open ? 'rotate-90' : ''}`} />
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13px] ${on === false ? 'text-ink-soft' : 'text-ink'}`} data-plugin-setting-group-title>{group.title}</span>
              {open ? null : (
                <span className={`block truncate text-[12px] ${hasIssue ? 'text-danger' : 'text-ink-faint'}`} data-plugin-setting-group-summary>
                  {hasIssue ? issue.text : on === false ? t('cap.settings.summary.off') : groupSummary(group)}
                </span>
              )}
            </span>
          </button>
          {group.switchKey !== undefined ? (
            <span className="shrink-0" data-plugin-setting-group-switch={group.id}>
              <Toggle layout="bare" label={t('cap.settings.groupEnabled', { name: group.title })} checked={on === true}
                onChange={(checked) => { edit(group.switchKey!, checked); }} />
            </span>
          ) : null}
        </div>
        {open ? (
          <div className="anim-enter border-t border-hairline bg-paper/60 px-3 pb-2 pl-8" data-plugin-setting-group-panel={group.id}>
            <div className="divide-y divide-hairline">
              {group.fields.filter(([, property]) => property.advanced !== true).map(([key, property]) => renderField(key, property))}
            </div>
            {advancedFold(group.fields.filter(([, property]) => property.advanced === true), group.id)}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section data-plugin-settings={pluginId} className="space-y-3">
      <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
        {plain.length > 0 ? (
          <div data-plugin-settings-global className="divide-y divide-hairline">{plain.map(([key, property]) => renderField(key, property))}</div>
        ) : null}
        {groups.length > 0 ? (
          <ul data-plugin-setting-groups className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-panel">
            {groups.map(renderGroup)}
          </ul>
        ) : null}
        {advancedFold(advanced)}
      </fieldset>
      <div className="sticky bottom-0 z-10 bg-paper/95 backdrop-blur-[2px]" data-plugin-settings-sticky-footer>
        <SettingsDraftFooter saved={justSaved} id={`plugin-settings-${pluginId}`} dirty={dirty} saving={saving}
          onSave={() => void save()}
          onDiscard={() => { setDraft(baseline); setIssue(null); setFeedback(null); }} />
        <FeedbackLine feedback={feedback} />
      </div>
    </section>
  );
}
