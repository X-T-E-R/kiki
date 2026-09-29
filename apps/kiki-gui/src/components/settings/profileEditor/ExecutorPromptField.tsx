import { useEffect, useState } from 'react';

import type { ExecutorCatalogItem, ExecutorPromptPreviewResponse } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { Icon } from '../../icons';
import { INPUT, SMALL_INPUT } from '../../ui';
import { SettingsSegmented } from '../SettingsPrimitives';
import {
  actualDelivery, CONTEXT_BLOCKS, DELIVERIES, deliveredBlocks, FIELD_ID_PATTERN, FIELD_WILDCARDS, resolvedSection,
  type ExecutorPromptDelivery, type ExecutorPromptDraft, type ExecutorPromptSection,
} from './executorPromptDraft';
import { Field } from './fields';

const WILDCARD_KEY: Record<(typeof FIELD_WILDCARDS)[number], I18nKey> = {
  'system.*': 'st.executorPrompt.block.system',
  'delegation.*': 'st.executorPrompt.block.delegation',
};

/**
 * `executor_prompt`: how this profile reaches an external engine. One scope
 * at a time — all engines, or one engine's override — so the controls never
 * double up; the preview below always answers for the engine the profile
 * runs on. Delivery choices come from the engine's declared
 * `prompt_deliveries`; an unsupported request stays selectable (it is what
 * the file says) and the preview names the fallback the server will use.
 */
export function ExecutorPromptField({ value, onChange, engineId, engineLabel, catalog, profileBody, disabled,
  profileName, workspaceId, previewEnabled }: {
  value: ExecutorPromptDraft | null;
  onChange: (next: ExecutorPromptDraft | null) => void;
  /** The engine the profile runs on ('' = native). */
  engineId: string;
  engineLabel: string;
  catalog: readonly ExecutorCatalogItem[];
  profileBody: string;
  disabled: boolean;
  profileName: string;
  workspaceId?: string;
  previewEnabled: boolean;
}) {
  const { t } = useI18n();
  const external = engineId !== '';
  const overrideIds = Object.keys(value?.per_engine ?? {});
  const [scope, setScope] = useState<string>(() => external && overrideIds.includes(engineId) ? engineId : '');
  const scopeIds = [...new Set([...(external ? [engineId] : []), ...overrideIds])];
  const labelOf = (id: string) => catalog.find((item) => item.id === id)?.label ?? id;
  const supportOf = (id: string) => catalog.find((item) => item.id === id)?.capabilities?.prompt_deliveries;
  const activeScope = scope !== '' && !scopeIds.includes(scope) ? '' : scope;
  const override = activeScope === '' ? undefined : value?.per_engine?.[activeScope];
  const editingOverride = activeScope !== '' && override !== undefined;
  const section: ExecutorPromptSection = activeScope === '' ? (value ?? {}) : (override ?? {});

  const writeSection = (patch: Partial<ExecutorPromptSection>) => {
    const base = value ?? {};
    if (activeScope === '') {
      onChange({ ...base, ...patch });
      return;
    }
    onChange({ ...base, per_engine: { ...base.per_engine, [activeScope]: { ...base.per_engine?.[activeScope], ...patch } } });
  };
  const addOverride = () => {
    const base = value ?? {};
    // Start from what the engine resolves today so the override begins equal.
    onChange({ ...base, per_engine: { ...base.per_engine, [activeScope]: { include: [...(base.include ?? [])] } } });
  };
  const removeOverride = () => {
    const base = value ?? {};
    const rest = Object.fromEntries(Object.entries(base.per_engine ?? {}).filter(([id]) => id !== activeScope));
    const { per_engine: _drop, ...others } = base;
    onChange(Object.keys(rest).length > 0 ? { ...others, per_engine: rest } : others);
  };
  const include = section.include ?? [];
  const toggle = (id: string, on: boolean) => {
    writeSection({ include: on ? [...include.filter((entry) => entry !== id), id] : include.filter((entry) => entry !== id) });
  };
  const supported = activeScope === '' ? (external ? supportOf(engineId) : undefined) : supportOf(activeScope);
  const scopeLabel = activeScope === '' ? engineLabel : labelOf(activeScope);

  return <div data-executor-prompt className="space-y-4">
    {!external ? <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.executorPrompt.nativeNote')}</p> : null}
    {scopeIds.length > 0 ? <Field label={t('st.executorPrompt.scope')} dataField="executorPromptScope">
      <SettingsSegmented<string> ariaLabel={t('st.executorPrompt.scope')} value={activeScope} disabled={false}
        dataAttr="data-executor-prompt-scope" onChange={(next) => setScope(next)}
        choices={[{ value: '', label: t('st.executorPrompt.scopeAll') }, ...scopeIds.map((id) => ({ value: id, label: labelOf(id) }))]} />
    </Field> : null}
    {activeScope !== '' && !editingOverride ? <div data-executor-prompt-inherit className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="text-[12px] text-ink-soft">{t('st.executorPrompt.inherits', { engine: scopeLabel })}</p>
      <button type="button" disabled={disabled} data-executor-prompt-add-override onClick={addOverride}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">
        <Icon name="plus" size={12} />{t('st.executorPrompt.addOverride', { engine: scopeLabel })}
      </button>
    </div> : <SectionControls section={section} editingOverride={editingOverride} supported={supported} scopeLabel={scopeLabel}
      disabled={disabled} include={include} onToggle={toggle} onPatch={writeSection} onRemove={removeOverride} />}
    {external ? <PromptPreview value={value} engineId={engineId} engineLabel={engineLabel} supported={supportOf(engineId)}
      steer={catalog.find((item) => item.id === engineId)?.capabilities?.steer} profileBody={profileBody}
      profileName={profileName} workspaceId={workspaceId} previewEnabled={previewEnabled} />
      : <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.executorPrompt.pickEngine')}</p>}
  </div>;
}

function Checkbox({ checked, disabled, label, onChange, dataBlock, mono = false }: {
  checked: boolean; disabled: boolean; label: string; onChange: (on: boolean) => void; dataBlock: string; mono?: boolean;
}) {
  return <label data-executor-prompt-block={dataBlock} data-checked={checked ? 'true' : undefined}
    className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[12.5px] text-ink hover:bg-ink/[0.03] ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
    <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" checked={checked} disabled={disabled}
      onChange={(event) => onChange(event.target.checked)} />
    <span className={`min-w-0 truncate ${mono ? 'font-mono text-[12px]' : ''}`}>{label}</span>
  </label>;
}

function SectionControls({ section, editingOverride, supported, scopeLabel, disabled, include, onToggle, onPatch, onRemove }: {
  section: ExecutorPromptSection;
  editingOverride: boolean;
  supported: readonly ExecutorPromptDelivery[] | undefined;
  scopeLabel: string;
  disabled: boolean;
  include: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  onPatch: (patch: Partial<ExecutorPromptSection>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [fieldId, setFieldId] = useState('');
  const delivery = section.delivery;
  const shownDelivery: '' | ExecutorPromptDelivery = delivery ?? (editingOverride ? ''
    : supported?.includes('replace') && !supported.includes('append') ? 'replace'
      : supported?.includes('append') ? 'append' : 'preamble');
  const specific = include.filter((id) => !(CONTEXT_BLOCKS as readonly string[]).includes(id) && !(FIELD_WILDCARDS as readonly string[]).includes(id));
  const fieldValid = FIELD_ID_PATTERN.test(fieldId.trim());
  const addField = () => {
    const id = fieldId.trim();
    if (!FIELD_ID_PATTERN.test(id) || include.includes(id)) return;
    onToggle(id, true);
    setFieldId('');
  };
  const choices = [
    ...(editingOverride ? [{ value: '' as const, label: t('st.executorPrompt.deliveryInherit') }] : []),
    ...DELIVERIES.map((value) => ({ value, label: t(`st.executorPrompt.delivery.${value}`) })),
  ];
  return <>
    <Field label={t('st.executorPrompt.delivery')} dataField="executorPromptDelivery"
      hint={<>
        {shownDelivery !== '' ? <span className="block">{t(`st.executorPrompt.deliveryHint.${shownDelivery}`)}</span> : null}
        {supported !== undefined ? <span data-executor-prompt-supported className="block">{t('st.executorPrompt.supports', {
          engine: scopeLabel, list: supported.map((value) => t(`st.executorPrompt.delivery.${value}`)).join(', '),
        })}</span> : null}
      </>}>
      <SettingsSegmented<'' | ExecutorPromptDelivery> ariaLabel={t('st.executorPrompt.delivery')} value={shownDelivery} disabled={disabled}
        dataAttr="data-executor-prompt-delivery"
        onChange={(next) => onPatch({ delivery: next === '' ? undefined : next })} choices={choices} />
    </Field>
    <fieldset className="min-w-0 space-y-2" data-executor-prompt-include>
      <legend className="mb-1 text-[12px] font-medium text-ink-soft">{t('st.executorPrompt.include')}</legend>
      <p className="text-[11.5px] text-ink-faint">{t('st.executorPrompt.groupContext')}</p>
      <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
        {CONTEXT_BLOCKS.map((id) => <Checkbox key={id} dataBlock={id} checked={include.includes(id)} disabled={disabled}
          label={t(`st.executorPrompt.block.${id}`)} onChange={(on) => onToggle(id, on)} />)}
      </div>
      <p className="pt-1 text-[11.5px] text-ink-faint">{t('st.executorPrompt.groupFields')}</p>
      <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
        {FIELD_WILDCARDS.map((id) => <Checkbox key={id} dataBlock={id} checked={include.includes(id)} disabled={disabled}
          label={t(WILDCARD_KEY[id])} onChange={(on) => onToggle(id, on)} />)}
        {specific.map((id) => <div key={id} className="sm:col-span-2"><Checkbox dataBlock={id} mono checked disabled={disabled} label={id} onChange={(on) => onToggle(id, on)} /></div>)}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pt-1">
        <input aria-label={t('st.executorPrompt.fieldId')} data-executor-prompt-field-id value={fieldId} disabled={disabled}
          placeholder="system.<id>" spellCheck={false} onChange={(event) => setFieldId(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addField(); } }}
          aria-invalid={fieldId.trim() !== '' && !fieldValid}
          className={`${SMALL_INPUT} min-w-0 flex-1 font-mono ${fieldId.trim() !== '' && !fieldValid ? 'border-amber-ink/50' : ''}`} />
        <button type="button" disabled={disabled || !fieldValid} onClick={addField}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">
          <Icon name="plus" size={12} />{t('st.executorPrompt.addField')}
        </button>
      </div>
      {fieldId.trim() !== '' && !fieldValid ? <p className="text-[11.5px] text-amber-ink">{t('st.executorPrompt.fieldIdInvalid')}</p> : null}
    </fieldset>
    <Field label={t('st.executorPrompt.body')} htmlFor="executor-prompt-body" hint={t('st.executorPrompt.bodyHint')} dataField="executorPromptBody">
      <textarea id="executor-prompt-body" rows={4} spellCheck={false} disabled={disabled} value={section.body ?? ''}
        onChange={(event) => onPatch({ body: event.target.value === '' ? undefined : event.target.value })}
        className={`${INPUT} min-h-20 font-mono text-[12px] leading-[1.6]`} />
    </Field>
    <Field label={t('st.executorPrompt.append')} htmlFor="executor-prompt-append" hint={t('st.executorPrompt.appendHint')} dataField="executorPromptAppend">
      <textarea id="executor-prompt-append" rows={3} spellCheck={false} disabled={disabled} value={section.append ?? ''}
        onChange={(event) => onPatch({ append: event.target.value === '' ? undefined : event.target.value })}
        className={`${INPUT} min-h-16 font-mono text-[12px] leading-[1.6]`} />
    </Field>
    {editingOverride ? <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.executorPrompt.overrideNote')}</p>
      <button type="button" disabled={disabled} data-executor-prompt-remove-override onClick={onRemove}
        className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">
        {t('st.executorPrompt.removeOverride', { engine: scopeLabel })}
      </button>
    </div> : null}
  </>;
}
function excerpt(text: string): string {
  const lines = text.trim().split('\n');
  const head = lines.slice(0, 4).join('\n');
  return lines.length > 4 || head.length > 360 ? `${head.slice(0, 360)}…` : head;
}

function PromptPreview({ value, engineId, engineLabel, supported, steer, profileBody,
  profileName, workspaceId, previewEnabled }: {
  value: ExecutorPromptDraft | null;
  engineId: string;
  engineLabel: string;
  supported: readonly ExecutorPromptDelivery[] | undefined;
  steer: 'native' | 'next_turn_preamble' | undefined;
  profileBody: string;
  profileName: string;
  workspaceId?: string;
  previewEnabled: boolean;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [loaded, setLoaded] = useState<{ engine: string; data: ExecutorPromptPreviewResponse } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (!previewEnabled || workspaceId === undefined || typeof client.previewExecutorPrompt !== 'function') return;
    void (async () => {
      try {
        const data = await client.previewExecutorPrompt(profileName, workspaceId, engineId);
        if (!cancelled) setLoaded({ engine: engineId, data });
      } catch {
        if (!cancelled) setLoaded(null);
      }
    })();
    return () => { cancelled = true; };
  }, [client, profileName, workspaceId, engineId, previewEnabled]);
  const preview = previewEnabled && loaded?.engine === engineId ? loaded.data : null;
  const resolved = resolvedSection(value, engineId);
  const requested = value?.per_engine?.[engineId]?.delivery ?? value?.delivery ??
    (supported?.includes('replace') && !supported.includes('append') ? 'replace'
      : supported?.includes('append') ? 'append' : 'preamble');
  const actual = preview?.delivery.actual ?? actualDelivery(requested, supported);
  const downgraded = preview?.delivery.downgraded ?? requested !== actual;
  const blocks = deliveredBlocks(resolved.include);
  const bodyText = resolved.body ?? profileBody;
  const parts: { key: string; title: string; mono?: boolean; text?: string; pending?: boolean; empty?: boolean }[] = preview !== null
    ? preview.blocks.map((block) => ({ key: block.id, title: block.id === 'body'
      ? t('st.executorPrompt.previewBody') : block.id === 'append'
        ? t('st.executorPrompt.previewAppend') : `## ${block.id}`, text: block.text, mono: block.id !== 'body' && block.id !== 'append' }))
    : [
      { key: 'body', title: resolved.body !== undefined ? t('st.executorPrompt.previewOverride') : t('st.executorPrompt.previewBody'),
        text: bodyText.trim() === '' ? undefined : excerpt(bodyText), empty: bodyText.trim() === '' },
      ...(resolved.append !== undefined ? [{ key: 'append', title: t('st.executorPrompt.previewAppend'), text: excerpt(resolved.append) }] : []),
      ...blocks.context.map((id) => ({ key: id, title: `## ${id}`, mono: true, pending: true })),
      ...blocks.fields.map((id) => ({ key: id, title: `## ${id}`, mono: true, pending: true })),
    ];
  return <div data-executor-prompt-preview data-preview-engine={engineId} data-preview-delivery={actual}
    data-preview-source={preview === null ? 'plan' : 'server'}
    className="space-y-2 rounded-lg border border-hairline bg-paper px-3 py-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <p className="text-[12px] font-medium text-ink">{t('st.executorPrompt.preview', { engine: engineLabel })}</p>
      <p className="text-[11.5px] text-ink-faint">{t('st.executorPrompt.previewAs', { delivery: t(`st.executorPrompt.delivery.${actual}`) })}</p>
    </div>
    {downgraded ? <p data-executor-prompt-downgrade className="flex gap-1.5 text-[11.5px] leading-snug text-amber-ink">
      <Icon name="warning" size={12} className="mt-px shrink-0" />
      {t('st.executorPrompt.downgrade', {
        engine: engineLabel, requested: t(`st.executorPrompt.delivery.${preview?.delivery.requested ?? requested}`), actual: t(`st.executorPrompt.delivery.${actual}`),
      })}
    </p> : null}
    <ol className="space-y-1.5">
      {parts.map((part, index) => <li key={part.key} data-preview-part={part.key} className="min-w-0 border-l-2 border-hairline pl-2.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11.5px]">
          <span className="shrink-0 tabular-nums text-ink-faint">{index + 1}</span>
          <span className={`min-w-0 break-all text-ink-soft ${part.mono === true ? 'font-mono' : 'font-medium'}`}>{part.title}</span>
          {part.pending === true ? <span className="shrink-0 text-ink-faint">· {t('st.executorPrompt.previewResolved')}</span> : null}
        </p>
        {part.text !== undefined ? <pre className={`mt-0.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.55] text-ink-faint ${preview === null ? 'line-clamp-4' : 'max-h-64 overflow-auto'}`}>{part.text}</pre> : null}
        {part.empty === true ? <p className="mt-0.5 text-[11.5px] text-ink-faint">{t('st.executorPrompt.previewEmptyBody')}</p> : null}
      </li>)}
    </ol>
    {preview === null ? <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.executorPrompt.previewNoText')}</p> : null}
    {steer !== undefined ? <p data-executor-prompt-steer className="border-t border-hairline pt-2 text-[11.5px] leading-snug text-ink-faint">
      {t('st.executorPrompt.steer', { mode: t(`st.executorPrompt.steerMode.${steer}`) })} {t('st.executorPrompt.steerLimit')}
    </p> : null}
  </div>;
}
