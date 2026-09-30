import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { permissionRuleConfigSchema } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { useDirtyReporter } from '../dirtyGuard';
import { Icon } from '../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { LIST_ROW_HEIGHT, ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec } from './list';
import { FieldIssue, FORM_LABEL, SettingsSelect } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

type PermissionRule = NonNullable<NonNullable<KikiConfigResponse['permission']>['rules']>[number];
type RuleDraft = { decision: PermissionRule['decision']; pattern: string; scope: PermissionRule['scope']; reason: string };
type RuleItem = { rule: PermissionRule; index: number };
const NEW_RULE: RuleDraft = { decision: 'ask', pattern: '', scope: 'user', reason: '' };
const DECISIONS = ['allow', 'deny', 'ask'] as const;

function toDraft(rule: PermissionRule): RuleDraft {
  return { decision: rule.decision, pattern: rule.pattern, scope: rule.scope, reason: rule.reason ?? '' };
}

export function PermissionRulesSettings() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const rules = configQuery.data?.permission?.rules ?? [];
  const ruleItems = useMemo<readonly RuleItem[]>(() => rules.map((rule, index) => ({ rule, index })), [rules]);
  const keyOf = useCallback((item: RuleItem) => `${item.index}:${item.rule.pattern}:${item.rule.decision}`, []);
  const textOf = useCallback((item: RuleItem) => [item.rule.pattern, item.rule.reason], []);
  const filters = useMemo<readonly ListFilterSpec<RuleItem>[]>(
    () => DECISIONS.map((decision) => ({ id: decision, label: t(`st.perm.decision.${decision}`), test: (item) => item.rule.decision === decision })),
    [t],
  );
  // Order is the semantics here: the first matching rule wins, so the list
  // offers search and decision filters but no resorting.
  const view = useListView({ listId: 'permission-rules', items: ruleItems, keyOf, textOf, filters });
  const [editing, setEditing] = useState<{ index: number | null; draft: RuleDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const original = editing?.index === null ? NEW_RULE : rules[editing?.index ?? -1];
  const dirty = editing !== null && JSON.stringify(editing.draft) !== JSON.stringify(original && toDraft(original));
  const patternValid = editing === null || permissionRuleConfigSchema.shape.pattern.safeParse(editing.draft.pattern).success;
  // A fresh, empty rule is not wrong yet; say so once something is typed.
  const patternIssue = !patternValid && editing !== null && editing.draft.pattern !== '';
  useDirtyReporter('permission-rule', dirty);

  const saveRules = async (next: PermissionRule[]): Promise<boolean> => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ permission: { rules: next } });
      const baseline = queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data;
      queryClient.setQueryData(['config'], {
        ...baseline,
        ...echoed,
        permission: echoed.permission ?? { ...baseline?.permission, rules: next },
      });
      ping();
      return true;
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (editing === null || !dirty || !patternValid || saving) return;
    const { index, draft } = editing;
    const rule: PermissionRule = {
      decision: draft.decision,
      scope: draft.scope,
      pattern: draft.pattern.trim(),
      reason: draft.reason || undefined,
    };
    const next = [...rules];
    if (index === null) next.push(rule);
    else next[index] = rule;
    if (await saveRules(next)) setEditing(null);
  };

  const remove = async (index: number) => {
    if (saving) return;
    if (await saveRules(rules.filter((_, position) => position !== index))) setEditing(null);
  };

  const move = async (index: number, offset: -1 | 1) => {
    if (saving) return;
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    if (await saveRules(next)) setEditing(null);
  };

  const update = (patch: Partial<RuleDraft>) => {
    setEditing((current) => current === null ? null : { ...current, draft: { ...current.draft, ...patch } });
    setFeedback(null);
  };

  return <SectionCard id="st-card-permission-rules" title={t('st.perm.rulesTitle')}>
    <div className="space-y-3" data-permission-rules>
      <Hint>{t('st.perm.rulesHint')}</Hint>
      {configQuery.isLoading ? <Hint>{t('st.perm.loading')}</Hint> : rules.length === 0
        ? <ListEmpty kind="none" title={t('st.perm.rulesEmpty')} />
        : <>
          <ListToolbar view={view} total={ruleItems.length} filters={filters}
            searchLabel={t('st.perm.search')} searchPlaceholder={t('st.perm.searchPlaceholder')}
            actions={
              <button type="button" className={SECONDARY_BUTTON} disabled={saving || !configQuery.data}
                onClick={() => { setEditing({ index: null, draft: { ...NEW_RULE } }); setFeedback(null); }}>{t('st.perm.add')}</button>
            } />
          {view.visible.length === 0 ? (
            <ListEmpty kind="no-match" title={t('st.perm.noMatchTitle')}
              body={view.query.trim() !== '' ? t('st.perm.noMatches', { query: view.query.trim() }) : undefined}
              onClear={view.clear} />
          ) : (
            <ListBody items={view.visible} keyOf={keyOf} density={view.density} label={t('st.perm.rulesTitle')}
              renderRow={({ rule, index }) => {
                const reorderBlocked = saving || editing !== null || view.narrowed;
                return (
                  <div className="flex items-center gap-3 px-3 py-1.5 text-[13px]" style={{ minHeight: LIST_ROW_HEIGHT[view.density] }}>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ink">
                      <span className="min-w-0 truncate font-mono text-[12px]" title={rule.pattern}>{rule.pattern}</span>
                      <Icon name="arrowRight" size={12} className="shrink-0 text-ink-faint" />
                      <span className="shrink-0">{t(`st.perm.decision.${rule.decision}`)}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-ink-faint">{t(`st.perm.scope.${rule.scope}`)}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" className={SECONDARY_BUTTON} disabled={reorderBlocked || index === 0}
                        title={view.narrowed ? t('st.perm.reorderNarrowed') : undefined}
                        aria-label={t('st.perm.moveUp')} onClick={() => void move(index, -1)}><Icon name="arrowUp" size={14} /></button>
                      <button type="button" className={SECONDARY_BUTTON} disabled={reorderBlocked || index === rules.length - 1}
                        title={view.narrowed ? t('st.perm.reorderNarrowed') : undefined}
                        aria-label={t('st.perm.moveDown')} onClick={() => void move(index, 1)}><Icon name="arrowDown" size={14} /></button>
                      <button type="button" className={SECONDARY_BUTTON} disabled={saving || editing !== null}
                        onClick={() => { setEditing({ index, draft: toDraft(rule) }); setFeedback(null); }}>{t('st.perm.edit')}</button>
                      <button type="button" className={SECONDARY_BUTTON} disabled={saving || editing !== null}
                        aria-label={`${t('st.perm.delete')} ${rule.pattern}`} onClick={() => void remove(index)}>{t('st.perm.delete')}</button>
                    </div>
                  </div>
                );
              }} />
          )}
        </>}
      {rules.length === 0 ? (
        <div className="flex items-center gap-3">
          <button type="button" className={SECONDARY_BUTTON} disabled={saving || !configQuery.data}
            onClick={() => { setEditing({ index: null, draft: { ...NEW_RULE } }); setFeedback(null); }}>{t('st.perm.add')}</button>
          <SaveStatus saving={saving} saved={saved} />
        </div>
      ) : (
        <SaveStatus saving={saving} saved={saved} />
      )}
      {/* A rule is four fields: a short dialog, not a block pushed into the list. */}
      {editing !== null ? <Dialog
        onClose={() => { setEditing(null); setFeedback(null); }}
        ariaLabel={editing.index === null ? t('st.perm.addTitle') : t('st.perm.editTitle')}
        overlayId="settings-permission-rule"
        panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md}`}
      >
        <div className="space-y-3" data-permission-rule-editor>
          <h2 className="font-display text-[18px] font-semibold text-ink">{editing.index === null ? t('st.perm.addTitle') : t('st.perm.editTitle')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.pattern')}</span>
              <input data-autofocus className={INPUT} value={editing.draft.pattern} onChange={(event) => update({ pattern: event.target.value })}
                aria-invalid={patternIssue} aria-describedby={patternIssue ? 'permission-rule-pattern-error' : undefined}
                placeholder="Bash(rm -rf*)" /></label>
            <div className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.decision')}</span>
              <SettingsSelect variant="form" ariaLabel={t('st.perm.decision')} value={editing.draft.decision}
                onChange={(decision) => update({ decision })} choices={(['allow', 'deny', 'ask'] as const).map((value) => ({ value, label: t(`st.perm.decision.${value}`) }))} /></div>
          </div>
          <FieldIssue id="permission-rule-pattern-error" text={patternIssue ? t('st.perm.invalidPattern') : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.scope')}</span>
              <SettingsSelect variant="form" ariaLabel={t('st.perm.scope')} value={editing.draft.scope}
                onChange={(scope) => update({ scope })} choices={(['user', 'project', 'turn-override', 'session-runtime'] as const).map((value) => ({ value, label: t(`st.perm.scope.${value}`) }))} /></div>
            <label className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.reason')}</span>
              <input className={INPUT} value={editing.draft.reason} onChange={(event) => update({ reason: event.target.value })} /></label>
          </div>
          {editing.draft.scope === 'session-runtime' ? <Hint>{t('st.perm.sessionScopeHint')}</Hint> : null}
          {/* A dialog keeps its commit button in view; leaving is Cancel. */}
          <div className="flex flex-wrap items-center gap-2 pt-3" data-settings-draft="permission-rule" data-dirty={dirty ? 'true' : undefined}>
            <button type="button" className={PRIMARY_BUTTON} disabled={!dirty || saving || !patternValid} onClick={() => void saveDraft()}>
              {saving ? t('common.saving') : editing.index === null ? t('st.perm.add') : t('common.save')}
            </button>
            <button type="button" data-settings-discard="permission-rule" className={SECONDARY_BUTTON} disabled={saving}
              onClick={() => { setEditing(null); setFeedback(null); }}>{t('common.cancel')}</button>
          </div>
          <FeedbackLine feedback={feedback} />
        </div>
      </Dialog> : null}
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      {editing === null ? <FeedbackLine feedback={feedback} /> : null}
    </div>
  </SectionCard>;
}
