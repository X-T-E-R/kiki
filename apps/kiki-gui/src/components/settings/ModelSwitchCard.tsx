/**
 * ModelSwitchCard — Settings → 模型 → 切换模型.
 *
 * Two instant-save defaults (the mode used when nothing else matches, and
 * whether a pick asks first) plus a compact ordered list of exception rules.
 * Rules are a draft form: they save as one table (first match wins) or not at
 * all, so a half-edited rule never reaches the space's config. Selecting a row
 * opens the editor underneath the list — no separate page, no card-in-card.
 *
 * The preference logic (first match, confirm inheritance, canonical-id
 * matching with * and ?) lives in @kiki/session-core/settings, not here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { PatchConfigRequest } from '@kiki/protocol';
import {
  matchesModelSwitchPattern,
  modelSwitchPreferencesToWire,
  readModelSwitchPreferences,
  type ModelSwitchMode,
  type ModelSwitchPreferenceRule,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { FORM_LABEL, SettingsDraftFooter, SettingsSegmented, SettingsSelect } from './SettingsPrimitives';

const MODE_ORDER = ['direct', 'compact', 'fresh'] as const satisfies readonly ModelSwitchMode[];
const MODE_LABEL_KEY = {
  direct: 'st.modelSwitch.mode.direct',
  compact: 'st.modelSwitch.mode.compact',
  fresh: 'st.modelSwitch.mode.fresh',
} as const satisfies Record<ModelSwitchMode, I18nKey>;

type RuleAsk = 'inherit' | 'ask' | 'skip';

function askOf(rule: ModelSwitchPreferenceRule): RuleAsk {
  return rule.confirm === undefined ? 'inherit' : rule.confirm ? 'ask' : 'skip';
}

function patternsToText(patterns: readonly string[] | undefined): string {
  return patterns === undefined ? '' : patterns.join(', ');
}

/** Comma-separated model patterns; empty means "any model". */
function textToPatterns(text: string): string[] | undefined {
  const parts = text.split(/[,，]/u).map((part) => part.trim()).filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts;
}

function rulesEqual(left: readonly ModelSwitchPreferenceRule[], right: readonly ModelSwitchPreferenceRule[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((rule, index) => {
    const other = right[index]!;
    return rule.id === other.id
      && rule.enabled === other.enabled
      && rule.mode === other.mode
      && rule.confirm === other.confirm
      && patternsToText(rule.fromModels) === patternsToText(other.fromModels)
      && patternsToText(rule.toModels) === patternsToText(other.toModels);
  });
}

interface RuleDraft {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly mode: ModelSwitchMode;
  readonly ask: RuleAsk;
  readonly enabled: boolean;
}

function draftOf(rule: ModelSwitchPreferenceRule): RuleDraft {
  return {
    id: rule.id,
    from: patternsToText(rule.fromModels),
    to: patternsToText(rule.toModels),
    mode: rule.mode,
    ask: askOf(rule),
    enabled: rule.enabled,
  };
}

function ruleOf(draft: RuleDraft): ModelSwitchPreferenceRule {
  return {
    id: draft.id,
    enabled: draft.enabled,
    fromModels: textToPatterns(draft.from),
    toModels: textToPatterns(draft.to),
    mode: draft.mode,
    confirm: draft.ask === 'inherit' ? undefined : draft.ask === 'ask',
  };
}

/** A pattern this narrow can only be a typo: no wildcard characters are illegal, but whitespace and separators are. */
function patternIssue(patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => /[\s[\]{}"'\\]/u.test(pattern) || pattern === '');
}

export function ModelSwitchCard() {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const serverPrefs = useMemo(
    () => readModelSwitchPreferences(configQuery.data?.model_switch),
    [configQuery.data],
  );
  const [rules, setRules] = useState(serverPrefs.rules);
  const [baseline, setBaseline] = useState(serverPrefs.rules);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<RuleDraft | undefined>(undefined);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = !rulesEqual(rules, baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Follow the server value while the form is clean; a dirty form keeps the
  // user's edits (the draft footer owns save/discard).
  useEffect(() => {
    if (dirtyRef.current) return;
    setRules(serverPrefs.rules);
    setBaseline(serverPrefs.rules);
  }, [serverPrefs.rules]);

  // Each control writes only its own field: a default-mode pick can never
  // persist an unsaved rule draft, and a rule save can never rewind the
  // defaults it no longer carries.
  const patchDomain = useCallback(async (patch: NonNullable<PatchConfigRequest['model_switch']>) => {
    const echoed = await client.patchConfig({ model_switch: patch });
    queryClient.setQueryData(['config'], echoed);
  }, [client, queryClient]);

  const saveDefaultMode = (mode: ModelSwitchMode) => {
    setFeedback(null);
    void patchDomain({ default_mode: mode })
      .then(() => { setFeedback({ tone: 'info', text: t('st.modelSwitch.saved') }); })
      .catch((error: unknown) => {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      });
  };
  const saveConfirm = (confirm: boolean) => {
    setFeedback(null);
    void patchDomain({ confirm })
      .then(() => { setFeedback({ tone: 'info', text: t('st.modelSwitch.saved') }); })
      .catch((error: unknown) => {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      });
  };

  const saveRules = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      // The rule table saves as one: the whole array goes, in display order.
      await patchDomain({ rules: modelSwitchPreferencesToWire({ ...serverPrefs, rules }).rules });
      setBaseline(rules);
      setDraft(undefined);
    } catch (error) {
      // The draft stays on screen: an unsaved rule table is never reported as
      // saved, and the row can be retried.
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const openEditor = (id: string) => {
    const rule = rules.find((entry) => entry.id === id);
    if (rule === undefined) return;
    setSelectedId(id);
    setDraft(draftOf(rule));
  };
  const applyDraft = (next: RuleDraft) => {
    setDraft(next);
    setRules((current) => current.map((rule) => (rule.id === next.id ? ruleOf(next) : rule)));
  };
  const addRule = () => {
    const id = `rule-${crypto.randomUUID().slice(0, 8)}`;
    const rule = ruleOf({ id, from: '', to: '', mode: serverPrefs.defaultMode, ask: 'inherit', enabled: true });
    setRules((current) => [...current, rule]);
    setSelectedId(id);
    setDraft(draftOf(rule));
  };
  const removeRule = (id: string) => {
    setRules((current) => current.filter((rule) => rule.id !== id));
    if (selectedId === id) {
      setSelectedId(undefined);
      setDraft(undefined);
    }
  };
  const moveRule = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    setRules((current) => {
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };

  // Three answers, not two: no pattern means the rule takes any model, a
  // pattern that matches nothing says so, and an unread catalog says nothing at
  // all — a label with an empty value reads as a broken preview.
  const catalog = modelsQuery.data?.items;
  const previewOf = (patterns: readonly string[] | undefined): string | undefined => {
    if (patterns === undefined) return t('st.modelSwitch.ruleAny');
    if (catalog === undefined) return undefined;
    const matched = catalog.filter((item) => patterns.some((pattern) => matchesModelSwitchPattern(pattern, item.id)));
    if (matched.length === 0) return t('st.modelSwitch.previewNone');
    const head = matched.slice(0, 4).map((item) => item.id).join(', ');
    return matched.length > 4 ? `${head} +${matched.length - 4}` : head;
  };

  const rowClass = 'flex min-h-8 items-center gap-2 rounded-md px-1.5 text-left text-[12px] transition-colors';
  return (
    <SectionCard id="st-card-model-switch" title={t('st.modelSwitch.title')}>
      <div className="space-y-4">
        <div>
          <p className={FORM_LABEL}>{t('st.modelSwitch.defaultMode')}</p>
          <div className="mt-1.5">
            <SettingsSegmented<ModelSwitchMode>
              ariaLabel={t('st.modelSwitch.defaultMode')}
              value={serverPrefs.defaultMode}
              dataAttr="data-model-switch-default-mode"
              choices={MODE_ORDER.map((mode) => ({ value: mode, label: t(MODE_LABEL_KEY[mode]) }))}
              onChange={(mode) => { saveDefaultMode(mode); }}
            />
          </div>
          <Hint>{t('st.modelSwitch.defaultModeHint')}</Hint>
        </div>
        <div>
          <Toggle
            layout="row"
            label={t('st.modelSwitch.confirm')}
            checked={serverPrefs.confirm}
            onChange={(checked) => { saveConfirm(checked); }}
          />
          <Hint>{t('st.modelSwitch.confirmHint')}</Hint>
        </div>
        <div className="border-t border-hairline pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] font-medium text-ink-soft">{t('st.modelSwitch.rulesTitle')}</p>
            <button type="button" data-model-switch-rule-add className={`${SECONDARY_BUTTON} h-7 px-2 text-[12px]`} onClick={addRule}>
              <span className="inline-flex items-center gap-1"><Icon name="plus" size={12} />{t('st.modelSwitch.ruleAdd')}</span>
            </button>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-ink-faint">{t('st.modelSwitch.rulesHint')}</p>
          {rules.length === 0 ? (
            <p data-model-switch-rules-empty className="mt-2 text-[12px] text-ink-faint">{t('st.modelSwitch.ruleEmpty')}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-0.5" data-model-switch-rules>
              {rules.map((rule, index) => {
                const selected = rule.id === selectedId;
                const summary = `${rule.fromModels === undefined ? t('st.modelSwitch.ruleAny') : patternsToText(rule.fromModels)} → ${rule.toModels === undefined ? t('st.modelSwitch.ruleAny') : patternsToText(rule.toModels)}`;
                return (
                  <li
                    key={rule.id}
                    data-model-switch-rule={rule.id}
                    className={`${rowClass} ${selected ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.03]'}`}
                  >
                    <button
                      type="button"
                      data-model-switch-rule-open={rule.id}
                      onClick={() => { openEditor(rule.id); }}
                      className="min-w-0 flex-1 truncate text-left text-ink"
                      title={summary}
                    >
                      <span className={rule.enabled ? undefined : 'text-ink-faint line-through'}>{summary}</span>
                    </button>
                    <span className="shrink-0 text-ink-faint">{t(MODE_LABEL_KEY[rule.mode])}</span>
                    <span className="shrink-0 text-ink-faint">
                      {rule.confirm === undefined
                        ? t('st.modelSwitch.ask.inherit')
                        : rule.confirm ? t('st.modelSwitch.ask.ask') : t('st.modelSwitch.ask.skip')}
                    </span>
                    <span className="flex shrink-0 items-center">
                      <button
                        type="button"
                        aria-label={t('st.modelSwitch.ruleMoveUp')}
                        disabled={index === 0}
                        onClick={() => { moveRule(index, -1); }}
                        className="h-6 w-6 rounded text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
                      >
                        <Icon name="arrowUp" size={12} className="mx-auto" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('st.modelSwitch.ruleMoveDown')}
                        disabled={index === rules.length - 1}
                        onClick={() => { moveRule(index, 1); }}
                        className="h-6 w-6 rounded text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
                      >
                        <Icon name="arrowDown" size={12} className="mx-auto" />
                      </button>
                      <button
                        type="button"
                        data-model-switch-rule-remove={rule.id}
                        aria-label={t('st.modelSwitch.ruleDelete')}
                        onClick={() => { removeRule(rule.id); }}
                        className="h-6 w-6 rounded text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none"
                      >
                        <Icon name="close" size={12} className="mx-auto" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {draft !== undefined ? (
            <div data-model-switch-rule-editor={draft.id} className="mt-3 space-y-3 border-t border-hairline pt-3">
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-40 flex-1">
                  <span className={FORM_LABEL}>{t('st.modelSwitch.ruleFrom')}</span>
                  <input
                    type="text"
                    value={draft.from}
                    placeholder={t('st.modelSwitch.ruleAny')}
                    onChange={(event) => { applyDraft({ ...draft, from: event.target.value }); }}
                    className={`${INPUT} mt-1 h-7 text-[12px]`}
                  />
                </label>
                <label className="min-w-40 flex-1">
                  <span className={FORM_LABEL}>{t('st.modelSwitch.ruleTo')}</span>
                  <input
                    type="text"
                    value={draft.to}
                    placeholder={t('st.modelSwitch.ruleAny')}
                    onChange={(event) => { applyDraft({ ...draft, to: event.target.value }); }}
                    className={`${INPUT} mt-1 h-7 text-[12px]`}
                  />
                </label>
              </div>
              <p className="text-[12px] leading-snug text-ink-faint">{t('st.modelSwitch.rulePatternsHint')}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <span className={FORM_LABEL}>{t('st.modelSwitch.ruleMode')}</span>
                  <SettingsSegmented<ModelSwitchMode>
                    ariaLabel={t('st.modelSwitch.ruleMode')}
                    value={draft.mode}
                    dataAttr="data-model-switch-rule-mode"
                    choices={MODE_ORDER.map((mode) => ({ value: mode, label: t(MODE_LABEL_KEY[mode]) }))}
                    onChange={(mode) => { applyDraft({ ...draft, mode }); }}
                  />
                </div>
                <label className="flex items-center gap-2">
                  <span className={FORM_LABEL}>{t('st.modelSwitch.ruleAsk')}</span>
                  <SettingsSelect<RuleAsk>
                    ariaLabel={t('st.modelSwitch.ruleAsk')}
                    variant="form"
                    value={draft.ask}
                    dataAttr="data-model-switch-rule-ask"
                    choices={[
                      { value: 'inherit', label: t('st.modelSwitch.ask.inherit') },
                      { value: 'ask', label: t('st.modelSwitch.ask.ask') },
                      { value: 'skip', label: t('st.modelSwitch.ask.skip') },
                    ]}
                    onChange={(ask) => { applyDraft({ ...draft, ask }); }}
                  />
                </label>
                {/* A settings row, not a bare switch: nothing else on this row
                    prints the label. */}
                <Toggle
                  layout="row"
                  label={t('st.modelSwitch.ruleEnabled')}
                  checked={draft.enabled}
                  onChange={(enabled) => { applyDraft({ ...draft, enabled }); }}
                />
              </div>
              {catalog !== undefined ? (
                <div data-model-switch-rule-preview className="space-y-0.5 text-[12px] leading-snug">
                  <p className="text-ink-faint">
                    {t('st.modelSwitch.previewFrom')}
                    {' '}
                    {previewOf(textToPatterns(draft.from))}
                  </p>
                  <p className="text-ink-faint">
                    {t('st.modelSwitch.previewTo')}
                    {' '}
                    {previewOf(textToPatterns(draft.to))}
                  </p>
                </div>
              ) : null}
              {patternIssue(textToPatterns(draft.from)) || patternIssue(textToPatterns(draft.to)) ? (
                <p role="alert" className="text-[12px] text-danger">{t('st.modelSwitch.rulePatternInvalid')}</p>
              ) : null}
            </div>
          ) : null}
          <SettingsDraftFooter
            id="model-switch-rules"
            dirty={dirty}
            saving={saving}
            saveLabel={t('st.modelSwitch.ruleSave')}
            onSave={() => { void saveRules(); }}
            onDiscard={() => {
              setRules(baseline);
              setSelectedId(undefined);
              setDraft(undefined);
              setFeedback(null);
            }}
          />
        </div>
        <FeedbackLine feedback={feedback} />
        {configQuery.error !== null && configQuery.error !== undefined ? <InlineError error={configQuery.error} /> : null}
      </div>
    </SectionCard>
  );
}
