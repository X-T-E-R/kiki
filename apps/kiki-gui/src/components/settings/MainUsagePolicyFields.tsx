/**
 * The values people set on a model day to day: default effort, service tier,
 * the generated-token ceiling, the context budget and the compaction point.
 *
 * Each row edits the shared value — the one every agent uses. An identity
 * (`main`, `independent`) may carry its own value on top of a row; that layer
 * opens in a popover anchored to the row's "Per agent" control (the anchored
 * popover tier, `overlays/AnchoredPopover`), so the difference is read and
 * restored right where the shared value is set, and there is still one Save.
 *
 * Three states a field can be in, and they stay three because the engine reads
 * them apart:
 *   - shared   — the model's own value
 *   - set      — this identity's own number or word
 *   - not sent — the tier is deliberately omitted so the API default applies,
 *                which is not the same as being unset. Thinking has no such
 *                state: it is switched off by the effort string `off`.
 *
 * The resolved value and its origin come from the server and describe the last
 * saved draft. They are withheld while the draft is unsaved rather than shown
 * as the result of what the person just typed.
 */

import type { I18nKey } from '@kiki/session-core/i18n';
import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import { formatCompactTokens, parseCompactInput } from '../../lib/autoCompact';
import { SMALL_INPUT } from '../ui';
import { AnchoredPopover, usePopover } from '../overlays';
import { effortLabel } from './profileEditor/profileDraft';
import { SettingHelp } from './SettingHelp';
import { SettingsSelect } from './SettingsPrimitives';
import {
  COUNT_USAGE_FIELDS,
  EMPTY_USAGE_BRANCH,
  USAGE_POSITIONS,
  USAGE_SERVICE_TIERS,
  clearUsageField,
  setUsageText,
  usageFieldValue,
  type TierDraft,
  type UsageBranchDraft,
  type UsagePolicyDraft,
  type UsagePolicyField,
  type UsagePosition,
} from './mainUsagePolicyDraft';

const FIELD_LABEL: Readonly<Record<UsagePolicyField, I18nKey>> = {
  thinking_effort: 'st.usagePolicy.thinkingEffort',
  service_tier: 'st.usagePolicy.serviceTier',
  auto_compact: 'st.usagePolicy.autoCompact',
  context_budget: 'st.usagePolicy.contextBudget',
  max_completion_tokens: 'st.usagePolicy.maxCompletionTokens',
};

const POSITION_LABEL: Readonly<Record<UsagePosition, I18nKey>> = {
  main: 'st.modelScope.main',
  independent: 'st.modelScope.independent',
};

/** Reading order: the two pickers, the two ceilings, then the compaction row. */
const ROW_ORDER: readonly UsagePolicyField[] = [
  'thinking_effort', 'service_tier', 'max_completion_tokens', 'context_budget', 'auto_compact',
];

/** One resolved field: what the identity really gets, and where it came from. */
export interface ResolvedUsageField {
  value: string;
  source: string | undefined;
}

export interface UsagePolicyView {
  draft: UsagePolicyDraft;
  /** Per field: the shared layer's value, already rendered for a person. */
  shared: Readonly<Record<UsagePolicyField, string>>;
  /** Per identity, the server's resolved value and origin. */
  resolved: Readonly<Record<UsagePosition, Readonly<Partial<Record<UsagePolicyField, ResolvedUsageField>>>>>;
  /** The field that blocked the last save, if any. */
  issue: { position: UsagePosition; field: UsagePolicyField } | null;
  /** True when any identity holds unsaved differences. */
  dirty: boolean;
}

/** An edit to the shared layer; each field routes to the draft that owns it. */
export type SharedUsageEdit = Readonly<Partial<Record<UsagePolicyField, string>>>;

export function MainUsagePolicyFields({
  modelId, view, efforts, onSharedChange, onChange, sharedIssue = null, compactionControl, compactionTrack, disabled = false,
}: {
  modelId: string;
  view: UsagePolicyView;
  /** A shared value the last save refused, with its message. */
  sharedIssue?: { field: UsagePolicyField; text: string } | null;
  /** The efforts this model supports, in display order. */
  efforts: readonly string[];
  onSharedChange: (next: SharedUsageEdit) => void;
  onChange: (next: UsagePolicyDraft) => void;
  /** The shared compaction field, with its presets. */
  compactionControl: React.ReactNode;
  /** The compaction track under it. */
  compactionTrack: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div data-main-usage-policy={modelId} className="grid min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2" data-usage-fields>
      {ROW_ORDER.map((field) => (
        <div key={field} className={field === 'auto_compact' ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
          <UsageRow field={field} modelId={modelId} view={view} efforts={efforts} disabled={disabled}
            onSharedChange={onSharedChange} onChange={onChange}
            sharedIssue={sharedIssue?.field === field ? sharedIssue.text : undefined}
            sharedControl={field === 'auto_compact' ? compactionControl : undefined}
            below={field === 'auto_compact' ? compactionTrack : undefined} />
        </div>
      ))}
    </div>
  );
}
function UsageRow({
  field, modelId, view, efforts, onSharedChange, onChange, sharedIssue, sharedControl, below, disabled,
}: {
  sharedIssue?: string;
  field: UsagePolicyField;
  modelId: string;
  view: UsagePolicyView;
  efforts: readonly string[];
  onSharedChange: (next: SharedUsageEdit) => void;
  onChange: (next: UsagePolicyDraft) => void;
  sharedControl?: React.ReactNode;
  below?: React.ReactNode;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const label = t(FIELD_LABEL[field]);
  const fieldId = `usage-${modelId}-${field}`;
  const shared = view.shared[field];
  const overridden = USAGE_POSITIONS.filter((position) =>
    usageFieldValue(view.draft[position] ?? EMPTY_USAGE_BRANCH, field) !== '');
  const flagged = view.issue !== null && view.issue.field === field;
  const popover = usePopover();
  const { setOpen } = popover;
  // A save refused on an identity value opens the popover that holds it.
  useEffect(() => { if (flagged) setOpen(true); }, [flagged, setOpen]);
  const expanded = popover.open;
  // Without an override the toggle stays out of sight until the row is
  // hovered or anything in it has focus; it never leaves the tab order.
  const quiet = overridden.length === 0 && !expanded;

  return (
    <div data-usage-row={field} className="group min-w-0 space-y-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <label htmlFor={sharedControl === undefined ? fieldId : undefined} className="text-[12px] font-medium text-ink-soft">{label}</label>
        <button type="button" data-usage-identity-toggle={field}
          data-usage-toggle-quiet={quiet ? '' : undefined}
          {...popover.triggerProps}
          className={`inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] transition-[color,background-color,opacity] focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:h-9 ${
            overridden.length > 0
              ? 'bg-selected-ink/10 font-medium text-selected-ink hover:bg-selected-ink/15'
              : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'
          } ${quiet ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100' : ''}`}>
          <span data-usage-override-marker={overridden.length > 0 ? overridden.join(' ') : undefined}>
            {overridden.length > 0
              ? overridden.map((position) => t(POSITION_LABEL[position])).join(' · ')
              : t('st.usagePolicy.perAgent')}
          </span>
          <svg aria-hidden viewBox="0 0 12 12" className={`size-2.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div data-usage-shared={field} className="min-w-0">
        {sharedControl ?? <SharedControl field={field} id={fieldId} label={label} value={shared}
          efforts={efforts} disabled={disabled} invalid={sharedIssue !== undefined} onSharedChange={onSharedChange} />}
      </div>
      {sharedIssue === undefined ? null : (
        <p role="alert" className="text-[12px] text-danger" data-usage-shared-issue={field}>{sharedIssue}</p>
      )}
      {below}
      <AnchoredPopover {...popover.popoverProps} label={t('st.usagePolicy.perAgentTitle', { field: label })} align="end"
        widthClassName="w-[22rem]" data={{ 'data-usage-identities': field }}>
        <p className="mb-2 text-[12px] font-medium text-ink-soft">{t('st.usagePolicy.perAgentTitle', { field: label })}</p>
        <div className="space-y-2">
          {USAGE_POSITIONS.map((position) => (
            <IdentityLine key={position} field={field} position={position} modelId={modelId} label={label}
              view={view} efforts={efforts} disabled={disabled} onChange={onChange} />
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function SharedControl({ field, id, label, value, efforts, disabled, invalid, onSharedChange }: {
  field: UsagePolicyField;
  invalid: boolean;
  id: string;
  label: string;
  value: string;
  efforts: readonly string[];
  disabled: boolean;
  onSharedChange: (next: SharedUsageEdit) => void;
}) {
  const { t } = useI18n();
  if (field === 'service_tier') {
    return <SettingsSelect id={id} variant="form" mono dataAttr="data-usage-value" ariaLabel={label}
      disabled={disabled}
      value={value === '' ? 'unset' : value}
      onChange={(next) => { onSharedChange({ [field]: next === 'unset' ? '' : next }); }}
      choices={[
        { value: 'unset', label: t('st.usagePolicy.unset') },
        ...USAGE_SERVICE_TIERS.map((tier) => ({ value: tier, label: tier })),
      ]} />;
  }
  if (field === 'thinking_effort') {
    return <SettingsSelect id={id} variant="form" dataAttr="data-usage-value" ariaLabel={label}
      disabled={disabled}
      value={value === '' ? 'unset' : value}
      onChange={(next) => { onSharedChange({ [field]: next === 'unset' ? '' : next }); }}
      choices={[
        { value: 'unset', label: t('st.usagePolicy.unset') },
        ...effortChoices(efforts, value, t),
        { value: 'off', label: t('st.usagePolicy.off') },
      ]} />;
  }
  return <UsageTextInput id={id} field={field} label={label} value={value} invalid={invalid}
    placeholder={t('st.usagePolicy.unset')} disabled={disabled}
    onCommit={(next) => { onSharedChange({ [field]: next }); }} />;
}
/**
 * One identity's value for one field. Empty means it uses the shared value,
 * which the placeholder or the inherit option names. The restore verb sits at
 * the end of the line so every identity puts it in the same place.
 */
function IdentityLine({ field, position, modelId, label, view, efforts, disabled, onChange }: {
  field: UsagePolicyField;
  position: UsagePosition;
  modelId: string;
  label: string;
  view: UsagePolicyView;
  efforts: readonly string[];
  disabled: boolean;
  onChange: (next: UsagePolicyDraft) => void;
}) {
  const { t } = useI18n();
  const branch = view.draft[position] ?? EMPTY_USAGE_BRANCH;
  const put = (next: UsageBranchDraft) => { onChange({ ...view.draft, [position]: next }); };
  const current = usageFieldValue(branch, field);
  const overridden = current !== '';
  const shared = view.shared[field];
  const id = `usage-${modelId}-${position}-${field}`;
  const who = t(POSITION_LABEL[position]);
  const aria = `${who} · ${label}`;
  const own = ownText(field, branch, t);
  const resolved = view.resolved[position]?.[field];
  // A saved projection describes the saved draft. While a draft is unsaved it
  // answers a question the person is no longer asking, so it is dropped.
  const effective = view.dirty ? own : (resolved?.value !== undefined && resolved.value !== '' ? resolved.value : own);
  const origin = view.dirty ? undefined : resolved?.source;
  const clamped = overridden && effective !== '' && effective !== own;
  const invalid = view.issue !== null && view.issue.field === field && view.issue.position === position;
  const sharedText = shared === '' ? t('st.usagePolicy.unset') : formatUsageValue(field, field === 'thinking_effort' ? effortLabel(shared, t) : shared);
  const inheritLabel = t('st.usagePolicy.inheritValue', { value: sharedText });

  let control: React.ReactNode;
  if (field === 'service_tier') {
    control = <SettingsSelect id={id} variant="form" mono dataAttr="data-usage-value" ariaLabel={aria}
      disabled={disabled} value={branch.tier} onChange={(next) => { put({ ...branch, tier: next as TierDraft }); }}
      choices={[
        { value: 'inherit', label: inheritLabel },
        { value: 'not_sent', label: t('st.usagePolicy.omit') },
        ...USAGE_SERVICE_TIERS.map((tier) => ({ value: tier, label: tier })),
      ]} />;
  } else if (field === 'thinking_effort') {
    control = <SettingsSelect id={id} variant="form" dataAttr="data-usage-value" ariaLabel={aria}
      disabled={disabled} value={current === '' ? 'inherit' : current}
      onChange={(next) => { put(setUsageText(branch, field, next === 'inherit' ? '' : next)); }}
      choices={[
        { value: 'inherit', label: inheritLabel },
        ...effortChoices(efforts, current === 'off' ? '' : current, t),
        { value: 'off', label: t('st.usagePolicy.off') },
      ]} />;
  } else {
    control = <UsageTextInput id={id} field={field} label={aria} value={current} invalid={invalid}
      placeholder={inheritLabel} disabled={disabled}
      onCommit={(next) => { put(setUsageText(branch, field, next)); }} />;
  }

  return (
    <div data-usage-position={position} className="space-y-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-20 shrink-0 truncate text-[12px] text-ink-soft" title={who}>{who}</span>
        <div className="min-w-0 flex-1">{control}</div>
        {overridden ? (
          <button type="button" data-usage-restore={field} disabled={disabled}
            title={t('st.usagePolicy.restoreInherit')} aria-label={`${t('st.usagePolicy.restoreInherit')} · ${aria}`}
            className="shrink-0 rounded px-1.5 py-1 text-[11.5px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
            onClick={() => { if (!disabled) put({ ...branch, ...clearUsageField(field) }); }}>
            {t('st.usagePolicy.restoreShort')}
          </button>
        ) : null}
      </div>
      {clamped ? (
        <p className="flex items-center gap-1.5 ps-[5.5rem] text-[11.5px] text-ink-faint">
          <span>{t('st.usagePolicy.effectiveShort')}</span>
          <span className="tabular-nums text-ink-soft" data-usage-effective={field}>{formatUsageValue(field, effective)}</span>
          {origin === undefined ? null : (
            <SettingHelp><span className="break-all font-mono text-[11px]" data-usage-source={field}>{origin}</span></SettingHelp>
          )}
        </p>
      ) : null}
      {invalid ? (
        <p role="alert" className="ps-[5.5rem] text-[12px] text-danger" data-usage-issue={field}>{t('st.usagePolicy.issueCount')}</p>
      ) : null}
    </div>
  );
}

/** The model's efforts as picker choices, keeping a stored value that is not among them. */
function effortChoices(efforts: readonly string[], current: string, t: (key: I18nKey) => string) {
  const list = efforts.filter((level) => level !== 'off');
  if (current !== '' && current !== 'off' && !list.includes(current)) list.push(current);
  return list.map((level) => ({ value: level, label: level === 'off' ? t('st.usagePolicy.off') : effortLabel(level, t) }));
}

/**
 * Token counts read the way the field they belong to settles — `180k`, `1M` —
 * so the input, its placeholder and the resolved line speak with one voice. A
 * value that is not a count is shown as typed.
 */
export function formatUsageValue(field: UsagePolicyField, value: string): string {
  if (!COUNT_USAGE_FIELDS.has(field)) return value;
  const count = Number(value);
  return value !== '' && Number.isFinite(count) ? formatCompactTokens(count) : value;
}

/**
 * One token-count field. `160k`, `0.2M` and `160000` are all accepted and the
 * field settles on `160k` when it is left; the draft keeps the plain integer,
 * so validation and the wire never see the display form. Anything unreadable
 * keeps its text and is reported by the save check.
 */
function UsageTextInput({
  id, field, label, value, invalid, placeholder, onCommit, disabled = false,
}: {
  id: string;
  field: UsagePolicyField;
  label: string;
  value: string;
  invalid: boolean;
  placeholder: string | undefined;
  onCommit: (next: string) => void;
  disabled?: boolean;
}) {
  const isCount = COUNT_USAGE_FIELDS.has(field);
  const display = isCount && value !== '' && /^\d+$/.test(value.trim()) ? formatCompactTokens(Number(value)) : value;
  const [text, setText] = useState(display);
  const [editing, setEditing] = useState(false);

  // An outside change (a reload after save, the restore control) re-reads the
  // field, but never mid-edit: that would move the caret.
  useEffect(() => {
    if (disabled) setEditing(false);
  }, [disabled]);
  useEffect(() => {
    if (!editing || disabled) setText(display);
  }, [display, editing, disabled]);

  return <input
    id={id} data-usage-value={field} aria-label={label} aria-invalid={invalid}
    disabled={disabled}
    className={`${SMALL_INPUT} h-8 w-full ${invalid ? 'border-danger' : ''} ${isCount ? 'font-mono tabular-nums' : ''}`}
    inputMode={isCount ? 'decimal' : undefined}
    spellCheck={false} autoComplete="off"
    value={text}
    placeholder={placeholder}
    onChange={(event) => {
      const next = event.target.value;
      setEditing(true);
      setText(next);
      if (!isCount) { onCommit(next); return; }
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

/** This identity's own value, read on the same terms as the shared one. */
function ownText(field: UsagePolicyField, branch: UsageBranchDraft, t: (key: I18nKey) => string): string {
  const value = usageFieldValue(branch, field);
  if (value === '') return '';
  if (value === 'not_sent') return t('st.usagePolicy.omit');
  if (field === 'thinking_effort' && value === 'off') return t('st.usagePolicy.off');
  return value;
}
