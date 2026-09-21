import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { parseNamedAgentTools } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import type { NamedAgentProfile, UpdateNamedAgentProfileRequest } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { FeedbackLine, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

/**
 * Three-way state of one frontmatter tool list. `inherit` writes nothing (the
 * layer does not restrict), `empty` writes an explicit empty list, and `list`
 * writes the parsed names. The engine keeps an absent field and `[]` apart —
 * `parseStringList` returns `undefined` for one and `[]` for the other, and an
 * empty `tools` list forbids every tool — so the editor must round-trip all
 * three instead of collapsing them into "no text".
 */
type ToolFieldMode = 'inherit' | 'empty' | 'list';

interface ToolFieldValue {
  readonly mode: ToolFieldMode;
  readonly text: string;
}

const TOOL_FIELD_MODES: readonly ToolFieldMode[] = ['inherit', 'empty', 'list'];

/** `tools` reads as an allow list: an empty one denies every tool. */
const TOOLS_MODE_LABELS: Readonly<Record<ToolFieldMode, I18nKey>> = {
  inherit: 'st.namedAgents.toolsModeInherit',
  empty: 'st.namedAgents.toolsModeDenyAll',
  list: 'st.namedAgents.toolsModeList',
};

/** `disallowedTools` reads as a deny list: an empty one denies nothing. */
const DISALLOWED_TOOLS_MODE_LABELS: Readonly<Record<ToolFieldMode, I18nKey>> = {
  inherit: 'st.namedAgents.toolsModeInherit',
  empty: 'st.namedAgents.disallowedToolsModeNone',
  list: 'st.namedAgents.disallowedToolsModeDeny',
};

function toolFieldFrom(value: readonly string[] | undefined): ToolFieldValue {
  if (value === undefined) return { mode: 'inherit', text: '' };
  return { mode: value.length === 0 ? 'empty' : 'list', text: value.join(', ') };
}

function toolFieldsEqual(left: ToolFieldValue, right: ToolFieldValue): boolean {
  if (left.mode !== right.mode) return false;
  return left.mode !== 'list' || left.text === right.text;
}

/** `null` deletes the frontmatter field, `[]` writes an empty list. */
function toolFieldBody(field: ToolFieldValue): string[] | null {
  if (field.mode === 'inherit') return null;
  if (field.mode === 'empty') return [];
  return parseNamedAgentTools(field.text) ?? [];
}

/** A list-mode field with no name at all names nothing to allow or deny. */
function toolFieldUnnamed(field: ToolFieldValue): boolean {
  return field.mode === 'list' && parseNamedAgentTools(field.text) === null;
}

/**
 * One frontmatter tool list with its three-way mode picker. The mode carries
 * the meaning the textarea alone cannot: nothing written, an explicit empty
 * list, or the names below.
 */
function ToolListField({
  field,
  fieldKey,
  label,
  labels,
  onChange,
}: {
  field: ToolFieldValue;
  fieldKey: 'tools' | 'disallowedTools';
  label: string;
  labels: Readonly<Record<ToolFieldMode, I18nKey>>;
  onChange: (next: ToolFieldValue) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1" data-tool-field={fieldKey}>
      <label className="block text-[11px] font-medium text-ink-soft">
        {label}
        <select
          data-tool-field-mode={fieldKey}
          className={`${INPUT} mt-1`}
          value={field.mode}
          onChange={(event) => { onChange({ ...field, mode: event.target.value as ToolFieldMode }); }}
        >
          {TOOL_FIELD_MODES.map((mode) => (
            <option key={mode} value={mode}>{t(labels[mode])}</option>
          ))}
        </select>
      </label>
      {field.mode === 'list' ? (
        <textarea
          data-tool-field-list={fieldKey}
          className={`${INPUT} min-h-16 font-mono`}
          value={field.text}
          placeholder={t('st.namedAgents.toolsPlaceholder')}
          onChange={(event) => { onChange({ ...field, text: event.target.value }); }}
        />
      ) : null}
      {fieldKey === 'tools' && toolFieldUnnamed(field) ? (
        <p role="alert" data-tool-field-error="tools" className="text-[10.5px] text-danger">
          {t('st.namedAgents.toolsListRequired')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Dedicated pop-up editor for one named agent profile (main or subagent).
 * Collects every field the structured PATCH contract opens — description,
 * when-to-use, pinned model, thinking effort, service tier, tool lists, and
 * per-route model aliases — and saves them in one shot, replacing the old
 * scattered inline fieldset. Only the fields the user actually touched ride
 * the PATCH: an untouched `tools: []` must stay an empty list (deny every
 * tool) instead of being re-serialized as "no such field". Read-only
 * projections (budgets, spawn constraints, model profiles) stay on the row's
 * technical-details fold; the raw-file editor remains a separate entry.
 */
export function AgentProfileEditorDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile: NamedAgentProfile;
  onClose: () => void;
  /** Called with the server echo after a successful save. */
  onSaved: (profile: NamedAgentProfile) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Frozen opening values: the dirty baseline must not drift if a background
  // refetch replaces the profile prop while the editor is open.
  const [baseline] = useState(() => ({
    description: profile.description ?? '',
    whenToUse: profile.when_to_use ?? '',
    modelAlias: profile.pinned_model_alias ?? '',
    thinkingEffort: profile.thinking_effort ?? '',
    serviceTier: (profile.service_tier ?? '') as NamedAgentProfile['service_tier'] | '',
    tools: toolFieldFrom(profile.tools),
    disallowedTools: toolFieldFrom(profile.disallowed_tools),
    routeAliases: Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])),
  }));
  const [description, setDescription] = useState(baseline.description);
  const [whenToUse, setWhenToUse] = useState(baseline.whenToUse);
  const [modelAlias, setModelAlias] = useState(baseline.modelAlias);
  const [thinkingEffort, setThinkingEffort] = useState(baseline.thinkingEffort);
  const [serviceTier, setServiceTier] = useState(baseline.serviceTier);
  const [tools, setTools] = useState(baseline.tools);
  const [disallowedTools, setDisallowedTools] = useState(baseline.disallowedTools);
  const [routeAliases, setRouteAliases] = useState(baseline.routeAliases);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });

  const changedRoutes = profile.routes.filter((route) =>
    (routeAliases[route.id] ?? '') !== (baseline.routeAliases[route.id] ?? ''));
  const dirty = description !== baseline.description
    || whenToUse !== baseline.whenToUse
    || modelAlias !== baseline.modelAlias
    || thinkingEffort !== baseline.thinkingEffort
    || serviceTier !== baseline.serviceTier
    || !toolFieldsEqual(tools, baseline.tools)
    || !toolFieldsEqual(disallowedTools, baseline.disallowedTools)
    || changedRoutes.length > 0;
  useDirtyReporter(`agent-profile-editor:${profile.source}:${profile.name}`, dirty);

  const canSave = dirty
    && description.trim() !== ''
    && !toolFieldUnnamed(tools)
    && !toolFieldUnnamed(disallowedTools)
    && profile.workspace_id !== undefined;

  const save = async () => {
    if (profile.workspace_id === undefined || !canSave) return;
    setSaving(true);
    setFeedback(null);
    try {
      const body: UpdateNamedAgentProfileRequest = {
        scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
        workspace_id: profile.workspace_id,
        source_file: profile.source_file,
        description: description !== baseline.description ? description.trim() : undefined,
        when_to_use: whenToUse !== baseline.whenToUse
          ? (whenToUse.trim() === '' ? null : whenToUse.trim())
          : undefined,
        pinned_model_alias: modelAlias !== baseline.modelAlias
          ? (modelAlias.trim() === '' ? null : modelAlias.trim())
          : undefined,
        thinking_effort: thinkingEffort !== baseline.thinkingEffort
          ? (thinkingEffort === '' ? null : thinkingEffort)
          : undefined,
        service_tier: serviceTier !== baseline.serviceTier
          ? (serviceTier === '' ? null : serviceTier)
          : undefined,
        tools: toolFieldsEqual(tools, baseline.tools) ? undefined : toolFieldBody(tools),
        disallowed_tools: toolFieldsEqual(disallowedTools, baseline.disallowedTools)
          ? undefined
          : toolFieldBody(disallowedTools),
        routes: changedRoutes.length === 0 ? undefined : changedRoutes.map((route) => ({
          id: route.id,
          model_alias: (routeAliases[route.id] ?? '').trim() === ''
            ? null
            : (routeAliases[route.id] ?? '').trim(),
        })),
      };
      const echoed = await client.updateNamedAgentProfile(profile.name, body);
      onSaved(echoed);
      onClose();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const modelOptions = useMemo<readonly SearchableSelectOption[]>(() => {
    const defaultOption: SearchableSelectOption = {
      value: '',
      label: t('st.namedAgents.inherit'),
      description: t('st.namedAgents.inherit'),
    };
    const catalogOptions = buildCatalogModelOptions(modelsQuery.data?.items ?? [], t);
    return [defaultOption, ...catalogOptions];
  }, [modelsQuery.data?.items, t]);

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('st.namedAgents.editProfileTitle', { name: profile.name })}
      overlayId={`agent-profile-editor:${profile.source}:${profile.name}`}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md}`}
    >
      <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
        {t('st.namedAgents.editProfileTitle', { name: profile.name })}
      </h2>
      <fieldset disabled={saving} className="mt-3 max-h-[70vh] space-y-3 overflow-y-auto pr-1 disabled:opacity-60">
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.description')}
          <textarea data-autofocus className={`${INPUT} mt-1 min-h-20`} value={description} onChange={(event) => { setDescription(event.target.value); }} />
        </label>
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.whenToUse')}
          <textarea className={`${INPUT} mt-1 min-h-16`} value={whenToUse} onChange={(event) => { setWhenToUse(event.target.value); }} />
        </label>
        <div className="space-y-1">
          <label htmlFor="agent-model-alias" className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.modelPin')}
          </label>
          <SearchableSelect
            id="agent-model-alias"
            value={modelAlias}
            options={modelOptions}
            allowCustomValue
            searchPlaceholder="provider/model"
            ariaLabel={t('st.namedAgents.modelPin')}
            emptyText={t('st.namedAgents.inherit')}
            buttonClassName="mt-1 flex w-full items-center justify-between gap-1.5 rounded-lg border border-hairline bg-paper px-2.5 py-2 font-mono text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint"
            onChange={(next) => {
              if (next.trim() !== modelAlias.trim()) setThinkingEffort('');
              setModelAlias(next);
            }}
          />
          <input
            type="text"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-agent-model-alias
            value={modelAlias}
            onChange={(event) => {
              const next = event.target.value;
              if (next.trim() !== modelAlias.trim()) setThinkingEffort('');
              setModelAlias(next);
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.defaultModelThinkingEffort')}
            <select data-agent-thinking-effort className={`${INPUT} mt-1`} value={thinkingEffort} onChange={(event) => { setThinkingEffort(event.target.value); }}>
              <option value="">{t('st.namedAgents.inherit')}</option>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.serviceTier')}
            <select className={`${INPUT} mt-1`} value={serviceTier} onChange={(event) => { setServiceTier(event.target.value as typeof serviceTier); }}>
              <option value="">{t('st.namedAgents.inherit')}</option>
              {['auto', 'default', 'flex', 'priority'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <ToolListField
          field={tools}
          fieldKey="tools"
          label={t('st.namedAgents.tools')}
          labels={TOOLS_MODE_LABELS}
          onChange={setTools}
        />
        <ToolListField
          field={disallowedTools}
          fieldKey="disallowedTools"
          label={t('st.namedAgents.disallowedTools')}
          labels={DISALLOWED_TOOLS_MODE_LABELS}
          onChange={setDisallowedTools}
        />
        {profile.routes.map((route) => (
          <label key={route.id} className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.routeModel', { route: route.id })}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={routeAliases[route.id] ?? ''}
              placeholder="provider/model"
              onChange={(event) => { setRouteAliases((current) => ({ ...current, [route.id]: event.target.value })); }}
            />
          </label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </Dialog>
  );
}
