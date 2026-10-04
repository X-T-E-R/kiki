/**
 * Who a parameter belongs to: shared, or one identity that differs.
 *
 * One model, one set of shared values. An identity may carry a difference on a
 * handful of those fields, and only those fields; everything else keeps
 * inheriting. The scope switch therefore sits *on the parameter group itself*
 * rather than beside a second copy of it: switching scopes re-points the same
 * rows at a different layer, so there is one place to read a value, one place
 * to write it, and one Save.
 *
 * Three states a field can be in, and they stay three because the engine reads
 * them apart:
 *   - shared   — the model's own value
 *   - set      — this position's own number or word
 *   - not sent — the tier is deliberately omitted so the API default applies,
 *                which is not the same as being unset. Thinking has no such
 *                state: it is switched off by the effort string `off`.
 *
 * The resolved value and its origin come from the server and describe the last
 * saved draft. They are withheld while the draft is unsaved rather than shown
 * as the result of what the person just typed; this editor does not solve the
 * model itself.
 *
 * Giving a difference back is an explicit control, never a side effect of
 * editing something else.
 */

import type { I18nKey } from '@kiki/session-core/i18n';
import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import { formatCompactTokens, parseCompactInput } from '../../lib/autoCompact';
import { Hint } from '../controls';
import { SMALL_INPUT } from '../ui';
import { SettingField } from './fields';
import { SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import {
  COUNT_USAGE_FIELDS,
  EMPTY_USAGE_BRANCH,
  USAGE_POLICY_FIELDS,
  USAGE_SERVICE_TIERS,
  clearUsageField,
  countUsageDifferences,
  setUsageText,
  usageFieldValue,
  type TierDraft,
  type UsageBranchDraft,
  type UsagePolicyDraft,
  type UsagePolicyField,
  type UsagePosition,
} from './mainUsagePolicyDraft';

export type UsageScope = 'shared' | UsagePosition;

const FIELD_LABEL: Readonly<Record<UsagePolicyField, I18nKey>> = {
  thinking_effort: 'st.usagePolicy.thinkingEffort',
  service_tier: 'st.usagePolicy.serviceTier',
  auto_compact: 'st.usagePolicy.autoCompact',
  context_budget: 'st.usagePolicy.contextBudget',
  max_completion_tokens: 'st.usagePolicy.maxCompletionTokens',
};

/** One resolved field: what the position really gets, and where it came from. */
export interface ResolvedUsageField {
  value: string;
  source: string | undefined;
}

export interface UsagePolicyView {
  draft: UsagePolicyDraft;
  /** Per field: the shared layer's value, already rendered for a person. */
  shared: Readonly<Record<UsagePolicyField, string>>;
  /** Per position, the server's resolved value and origin. */
  resolved: Readonly<Record<UsagePosition, Readonly<Partial<Record<UsagePolicyField, ResolvedUsageField>>>>>;
  /** The field that blocked the last save, if any. */
  issue: { position: UsagePosition; field: UsagePolicyField } | null;
  /** True when any position holds unsaved differences. */
  dirty: boolean;
}

/** An edit to the shared layer; each field routes to the control that owns it. */
export type SharedUsageEdit = Readonly<Partial<Record<UsagePolicyField, string>>>;

export function MainUsagePolicyFields({
  modelId, scope, showIndependent, onScopeChange, view, onSharedChange, onChange, compaction, compactionControl,
}: {
  modelId: string;
  scope: UsageScope;
  /** Only when the server carries an independent branch worth showing. */
  showIndependent: boolean;
  onScopeChange: (scope: UsageScope) => void;
  view: UsagePolicyView;
  onSharedChange: (next: SharedUsageEdit) => void;
  onChange: (next: UsagePolicyDraft) => void;
  /** The compaction track and hint, shown under the compaction row. */
  compaction?: React.ReactNode;
  /** The compaction field itself, with its presets and percentage entry. */
  compactionControl?: React.ReactNode;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const branch = scope === 'shared' ? undefined : (view.draft[scope] ?? EMPTY_USAGE_BRANCH);
  const differences = countUsageDifferences(branch ?? EMPTY_USAGE_BRANCH);
  return (
    <div data-main-usage-policy={modelId} data-usage-scope={scope}
      className="min-w-0 space-y-2 border-t border-hairline pt-4 disabled:opacity-60">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <SettingsSegmented<UsageScope>
          ariaLabel={t('st.usagePolicy.scopeAria')}
          value={scope}
          dataAttr="data-usage-scope-choice"
          onChange={onScopeChange}
          choices={[
            { value: 'shared', label: t('st.usagePolicy.shared') },
            { value: 'main', label: t('st.usagePolicy.main') },
            // Independent appears only when the server carries a branch for it;
            // a position nobody uses is not offered a control it has no use for.
            ...(showIndependent ? [{ value: 'independent' as const, label: t('st.promptIdentity.independent') }] : []),
          ]}
        />
        {scope === 'shared' ? null : (
          <span className="text-[12px] text-ink-faint" data-usage-differences={String(differences)}>
            {differences === 0 ? t('st.usagePolicy.noDifferences')
              : differences === 1 ? t('st.usagePolicy.differencesOne')
              : t('st.usagePolicy.differences', { count: String(differences) })}
          </span>
        )}
      </div>
      <Hint>
        {scope === 'shared'
          ? t('st.usagePolicy.sharedHint')
          : t(scope === 'main' ? 'st.usagePolicy.mainHint' : 'st.usagePolicy.independentHint')}
      </Hint>
      <div className="space-y-1" data-usage-fields={scope}>
        {USAGE_POLICY_FIELDS.map((field) => (
          <UsageRow key={field} field={field} scope={scope} modelId={modelId}
            branch={branch ?? EMPTY_USAGE_BRANCH} shared={view.shared[field]}
            resolved={scope === 'shared' ? undefined : view.resolved[scope]?.[field]}
            draftDirty={scope !== 'shared' && view.dirty}
            invalid={view.issue !== null && view.issue.field === field
              && (scope === 'shared' || view.issue.position === scope)}
            onSharedChange={onSharedChange}
            onChange={(next) => onChange({ ...view.draft, [scope]: next })}
            compaction={field === 'auto_compact' ? compaction : undefined}
            compactionControl={field === 'auto_compact' ? compactionControl : undefined} />
        ))}
      </div>
      {scope === 'shared' ? null : <Hint>{t('st.usagePolicy.capsHelp')}</Hint>}
    </div>
  );
}

function UsageRow({
  field, scope, modelId, branch, shared, resolved, draftDirty, invalid, onSharedChange, onChange, compaction, compactionControl,
}: {
  field: UsagePolicyField;
  scope: UsageScope;
  modelId: string;
  branch: UsageBranchDraft;
  shared: string;
  resolved: ResolvedUsageField | undefined;
  draftDirty: boolean;
  invalid: boolean;
  onSharedChange: (next: SharedUsageEdit) => void;
  onChange: (next: UsageBranchDraft) => void;
  /** The compaction control, which only the compaction row carries. */
  compaction?: React.ReactNode;
  /** Replaces the plain input for the compaction row, which has its own. */
  compactionControl?: React.ReactNode;
}) {
  const { t } = useI18n();
  const label = t(FIELD_LABEL[field]);
  const fieldId = `usage-${modelId}-${scope}-${field}`;
  const current = scope === 'shared' ? shared : usageFieldValue(branch, field);
  const overridden = scope !== 'shared' && current !== '';
  const own = scope === 'shared' ? shared : ownText(field, branch, t);
  // A saved projection describes the saved draft. While this one is unsaved it
  // answers a question the person is no longer asking, so it is dropped rather
  // than shown as if the edit had already taken effect.
  const effective = draftDirty ? own : (resolved?.value !== undefined && resolved.value !== '' ? resolved.value : own);
  const origin = draftDirty ? undefined : resolved?.source;
  const problem = invalid ? t('st.usagePolicy.issueCount') : null;
  // Only say something when the two genuinely differ; a restatement of the same
  // number reads as new information that it is not.
  const differs = overridden && effective !== '' && effective !== shared;

  return <div data-usage-row={field}>
    <SettingField label={label} labelId={`${fieldId}-label`} layout="stack"
      help={differs
        ? <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span>{shared === '' ? t('st.usagePolicy.unset') : formatUsageValue(field, shared)}</span>
          <span aria-hidden>→</span>
          <span className="tabular-nums" data-usage-effective={field}>{formatUsageValue(field, effective)}</span>
        </span>
        : undefined}
      detail={differs && origin !== undefined
        // The origin is a config path: reference text behind the label's `i`,
        // not a line on the first screen.
        ? <span className="font-mono text-[11px] break-all" data-usage-source={field}>{origin}</span>
        : undefined}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {field === 'service_tier'
          ? scope === 'shared'
            ? <SettingsSelect id={fieldId} variant="form" mono dataAttr="data-usage-value" ariaLabel={label}
              value={shared === '' ? 'unset' : shared}
              onChange={(next) => { onSharedChange({ [field]: next === 'unset' ? '' : next }); }}
              choices={[
                { value: 'unset', label: t('st.usagePolicy.unset') },
                ...USAGE_SERVICE_TIERS.map((tier) => ({ value: tier, label: tier })),
              ]} />
            : <SettingsSelect id={fieldId} variant="form" mono dataAttr="data-usage-value" ariaLabel={label}
              value={branch.tier} onChange={(next) => onChange({ ...branch, tier: next as TierDraft })}
              choices={[
                { value: 'inherit', label: t('st.usagePolicy.inherit') },
                { value: 'not_sent', label: t('st.usagePolicy.omit') },
                ...USAGE_SERVICE_TIERS.map((tier) => ({ value: tier, label: tier })),
              ]} />
          : compactionControl ?? <UsageTextInput
            id={fieldId} field={field} label={label}
            value={current}
            invalid={problem !== null}
            placeholder={scope === 'shared' || shared === ''
              ? undefined
              : COUNT_USAGE_FIELDS.has(field) ? t('st.usagePolicy.inheritSharedPoint') : formatUsageValue(field, shared)}
            onCommit={(next) => {
              if (scope === 'shared') onSharedChange({ [field]: next });
              else onChange(setUsageText(branch, field as Exclude<UsagePolicyField, 'service_tier'>, next));
            }} />}
        {overridden
          // Always its own line, always at its end. Sharing a line with the input
          // left it to wrap past the presets on a narrow row and settle between
          // the hint and the slider, where it read as part of the hint; a `basis-full`
          // line makes the position the same at every width and on every row.
          ? <button type="button" data-usage-restore={field}
            className="basis-full ms-auto mt-0.5 shrink-0 self-start rounded px-1.5 py-1 text-right text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
            onClick={() => { onChange({ ...branch, ...clearUsageField(field) }); }}>{t('st.usagePolicy.restoreInherit')}</button>
          : null}
        {problem !== null
          ? <p role="alert" className="w-full text-[12px] text-danger" data-usage-issue={field}>{problem}</p>
          : null}
      </div>
      {compaction}
    </SettingField>
  </div>;
}

/**
 * Token counts read the way the field they belong to settles — `180k`, `1M` —
 * so the input, its placeholder, and the shared → effective line speak with one
 * voice. A value that is not a count (mid-typing text the row will reject) is
 * shown as typed rather than mangled. Efforts and tiers are words and stay as
 * they are.
 */
export function formatUsageValue(field: UsagePolicyField, value: string): string {
  if (!COUNT_USAGE_FIELDS.has(field)) return value;
  const count = Number(value);
  return Number.isFinite(count) ? formatCompactTokens(count) : value;
}

/**
 * One editable field. Token counts take the same read/write the compaction point
 * does — `160k`, `0.2M` and `160000` are all accepted and the field settles on
 * `160k` — so three numbers in this panel stop reading three ways. The draft
 * keeps the plain integer either way, so validation, the wire and the resolved
 * line are untouched by how the value was typed.
 *
 * The draft is updated on every keystroke, exactly as a plain field would be, so
 * validation and Save still see the text being typed. The `k` form appears when
 * the field is left, which is the one moment a value is known to be finished.
 * Anything unreadable keeps its text and is reported by the row's own check
 * rather than being rewritten here.
 */
function UsageTextInput({
  id, field, label, value, invalid, placeholder, onCommit,
}: {
  id: string;
  field: UsagePolicyField;
  label: string;
  value: string;
  invalid: boolean;
  placeholder: string | undefined;
  onCommit: (next: string) => void;
}) {
  const isCount = COUNT_USAGE_FIELDS.has(field);
  const display = isCount && value !== '' && /^\d+$/.test(value.trim()) ? formatCompactTokens(Number(value)) : value;
  const [text, setText] = useState(display);
  const [editing, setEditing] = useState(false);

  // A change from outside this field (a scope switch, a reload after save, the
  // restore control) re-reads it, but never mid-edit: that would move the caret
  // and discard what is being typed.
  useEffect(() => {
    if (!editing) setText(display);
  }, [display, editing]);

  return <input
    id={id} data-usage-value={field} aria-label={label} aria-invalid={invalid}
    className={`${SMALL_INPUT} ${invalid ? 'border-danger' : ''} ${isCount ? 'font-mono tabular-nums' : ''}`}
    inputMode={isCount ? 'decimal' : undefined}
    spellCheck={false} autoComplete="off"
    value={text}
    placeholder={placeholder}
    onChange={(event) => {
      const next = event.target.value;
      setEditing(true);
      setText(next);
      if (!isCount) { onCommit(next); return; }
      // Hand the plain integer up as typed, so an unfinished number is never
      // rescaled mid-keystroke, and hand the `k` form up as soon as it parses.
      const parsed = parseCompactInput(next);
      onCommit(parsed.kind === 'tokens' ? String(parsed.tokens) : next);
    }}
    onFocus={() => setEditing(true)}
    onBlur={() => {
      setEditing(false);
      const parsed = isCount ? parseCompactInput(text) : null;
      setText(parsed?.kind === 'tokens' ? formatCompactTokens(parsed.tokens) : text);
    }} />;
}

/** This position's own value, read on the same terms as the shared one. */
function ownText(field: UsagePolicyField, branch: UsageBranchDraft, t: (key: I18nKey) => string): string {
  const value = usageFieldValue(branch, field);
  if (value === '') return '';
  if (value === 'not_sent') return t('st.usagePolicy.omit');
  if (field === 'thinking_effort' && value === 'off') return t('st.usagePolicy.off');
  return value;
}
