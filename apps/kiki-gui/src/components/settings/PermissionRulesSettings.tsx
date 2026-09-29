import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { permissionRuleConfigSchema } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { FieldIssue, FORM_LABEL, SettingsDraftFooter, SettingsSelect } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

type PermissionRule = NonNullable<NonNullable<KikiConfigResponse['permission']>['rules']>[number];
type RuleDraft = { decision: PermissionRule['decision']; pattern: string; scope: PermissionRule['scope']; reason: string };
const NEW_RULE: RuleDraft = { decision: 'ask', pattern: '', scope: 'user', reason: '' };

function toDraft(rule: PermissionRule): RuleDraft {
  return { decision: rule.decision, pattern: rule.pattern, scope: rule.scope, reason: rule.reason ?? '' };
}

export function PermissionRulesSettings() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const rules = configQuery.data?.permission?.rules ?? [];
  const [editing, setEditing] = useState<{ index: number | null; draft: RuleDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const original = editing?.index === null ? NEW_RULE : rules[editing?.index ?? -1];
  const dirty = editing !== null && JSON.stringify(editing.draft) !== JSON.stringify(original && toDraft(original));
  const patternValid = editing === null || permissionRuleConfigSchema.shape.pattern.safeParse(editing.draft.pattern).success;

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
        ? <Hint>{t('st.perm.rulesEmpty')}</Hint>
        : <ol className="divide-y divide-hairline" aria-label={t('st.perm.rulesTitle')}>
          {rules.map((rule, index) => <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-[13px]">
            <span className="min-w-0 flex-1 break-all text-ink"><span className="font-mono text-[12px]">{rule.pattern}</span> → {t(`st.perm.decision.${rule.decision}`)}</span>
            <span className="text-[12px] text-ink-faint">{t(`st.perm.scope.${rule.scope}`)}</span>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" className={SECONDARY_BUTTON} disabled={saving || editing !== null || index === 0}
                aria-label={t('st.perm.moveUp')} onClick={() => void move(index, -1)}>↑</button>
              <button type="button" className={SECONDARY_BUTTON} disabled={saving || editing !== null || index === rules.length - 1}
                aria-label={t('st.perm.moveDown')} onClick={() => void move(index, 1)}>↓</button>
              <button type="button" className={SECONDARY_BUTTON} disabled={saving || editing !== null}
                onClick={() => { setEditing({ index, draft: toDraft(rule) }); setFeedback(null); }}>{t('st.perm.edit')}</button>
              <button type="button" className={SECONDARY_BUTTON} disabled={saving || editing !== null}
                aria-label={`${t('st.perm.delete')} ${rule.pattern}`} onClick={() => void remove(index)}>{t('st.perm.delete')}</button>
            </div>
          </li>)}</ol>}
      {editing === null ? <div className="flex items-center gap-3">
        <button type="button" className={SECONDARY_BUTTON} disabled={saving || !configQuery.data}
          onClick={() => { setEditing({ index: null, draft: { ...NEW_RULE } }); setFeedback(null); }}>{t('st.perm.add')}</button>
        <SaveStatus saving={saving} saved={saved} />
      </div> :
        <div className="space-y-3 border-l-2 border-hairline pl-3" data-permission-rule-editor>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.pattern')}</span>
              <input className={INPUT} value={editing.draft.pattern} onChange={(event) => update({ pattern: event.target.value })}
                aria-invalid={!patternValid} aria-describedby={!patternValid ? 'permission-rule-pattern-error' : undefined}
                placeholder="Bash(rm -rf*)" /></label>
            <div className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.decision')}</span>
              <SettingsSelect variant="form" ariaLabel={t('st.perm.decision')} value={editing.draft.decision}
                onChange={(decision) => update({ decision })} choices={(['allow', 'deny', 'ask'] as const).map((value) => ({ value, label: t(`st.perm.decision.${value}`) }))} /></div>
          </div>
          <FieldIssue id="permission-rule-pattern-error" text={!patternValid ? t('st.perm.invalidPattern') : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.scope')}</span>
              <SettingsSelect variant="form" ariaLabel={t('st.perm.scope')} value={editing.draft.scope}
                onChange={(scope) => update({ scope })} choices={(['user', 'project', 'turn-override', 'session-runtime'] as const).map((value) => ({ value, label: t(`st.perm.scope.${value}`) }))} /></div>
            <label className="space-y-1"><span className={FORM_LABEL}>{t('st.perm.reason')}</span>
              <input className={INPUT} value={editing.draft.reason} onChange={(event) => update({ reason: event.target.value })} /></label>
          </div>
          {editing.draft.scope === 'session-runtime' ? <Hint>{t('st.perm.sessionScopeHint')}</Hint> : null}
          <SettingsDraftFooter id="permission-rule" dirty={dirty} saving={saving} saveDisabled={!patternValid}
            onSave={() => void saveDraft()} onDiscard={() => { setEditing(null); setFeedback(null); }} />
          {!dirty ? <button type="button" className={SECONDARY_BUTTON} onClick={() => setEditing(null)}>{t('common.cancel')}</button> : null}
        </div>}
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  </SectionCard>;
}
