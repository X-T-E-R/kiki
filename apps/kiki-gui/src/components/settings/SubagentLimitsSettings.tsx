import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AGENT_LIST_UI_FIELD_ORDER,
  subagentAgentListFieldsFromConfig,
  subagentAgentListFieldsPatch,
  subagentLimitsFromConfig,
  toggleAgentListField,
  type AgentListTelemetryField,
} from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { FeedbackLine, Hint, InlineError, SaveStatus } from '../controls';
import { SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField, SettingsBox } from './fields';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';
import { useSavedTick } from './useSavedTick';

export function SubagentLimitsSettings() {
  const { client } = useConnection();
  const { t } = useI18n();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig() });
  const [hours, setHours] = useState('2');
  const [direct, setDirect] = useState('16');
  const [total, setTotal] = useState('0');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [tick, ping] = useSavedTick();
  useEffect(() => {
    if (config.data === undefined || dirty) return;
    const value = subagentLimitsFromConfig(config.data);
    setHours(String(value.timeoutMs / 3_600_000)); setDirect(String(value.maxDirectChildren)); setTotal(String(value.maxTotalSubagents));
  }, [config.data, dirty]);
  const save = async () => {
    const timeoutMs = Math.round(Number(hours) * 3_600_000);
    const maxDirect = Number(direct), maxTotal = Number(total);
    if ([hours, direct, total].some((value) => value.trim() === '') || ![timeoutMs, maxDirect, maxTotal].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      setError(t('st.subagentLimits.invalid')); return;
    }
    setSaving(true); setError(undefined);
    try {
      const body = { subagent: { timeout_ms: timeoutMs, max_direct_children: maxDirect, max_total_subagents: maxTotal } };
      cache.setQueryData(['config'], await client.patchConfig(body));
      await cache.invalidateQueries({ queryKey: ['agentCapabilities'] });
      setDirty(false); ping();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const discard = () => {
    if (config.data !== undefined) {
      const value = subagentLimitsFromConfig(config.data);
      setHours(String(value.timeoutMs / 3_600_000)); setDirect(String(value.maxDirectChildren)); setTotal(String(value.maxTotalSubagents));
    }
    setDirty(false); setError(undefined);
  };
  // Units sit right of the input, never in the label.
  const field = (id: string, label: string, help: string, value: string, set: (next: string) => void, step: string, unit?: string) => (
    <SettingField label={label} htmlFor={id} help={help}>
      <span className="flex items-center gap-1.5">
        <input id={id} className={`${SMALL_INPUT} h-8 w-24 text-right tabular-nums`} type="number" min="0" step={step} value={value}
          onChange={(event) => { set(event.target.value); setDirty(true); }} />
        {unit !== undefined ? <span className="text-[12px] text-ink-faint">{unit}</span> : null}
      </span>
    </SettingField>
  );
  return <SectionCard id="st-card-subagent-limits" title={t('st.subagentLimits.title')}>
    <SettingsBox>
    <Hint>{t('st.subagentLimits.lead')}</Hint>
    <fieldset disabled={saving || config.isPending || config.isError} className="mt-2 space-y-1">
      {field('subagent-limit-hours', t('st.subagentLimits.timeoutShort'), t('st.subagentLimits.timeoutHelp'), hours, setHours, 'any', t('st.subagentLimits.hoursUnit'))}
      {field('subagent-limit-direct', t('st.subagentLimits.directShort'), t('st.subagentLimits.directHelp'), direct, setDirect, '1')}
      {field('subagent-limit-total', t('st.subagentLimits.totalShort'), t('st.subagentLimits.totalHelp'), total, setTotal, '1')}
    </fieldset>
    <SettingsDraftFooter id="subagent-limits" dirty={dirty} saving={saving} saved={tick}
      saveLabel={t('st.boardStorage.save')} saveDisabled={config.isPending || config.isError}
      onSave={() => { void save(); }} onDiscard={discard} />
    {error || config.error ? <FeedbackLine feedback={{ tone: 'error', text: error ?? config.error?.message ?? '' }} /> : null}
    </SettingsBox>
  </SectionCard>;
}

/**
 * Developer & labs › Engine parameters → AgentList default return fields:
 * which fields a compact AgentList call carries. A tool-output detail nobody
 * sees while working, so it left Agents › Dispatch; each chip still saves
 * the moment it flips.
 */
export function SubagentAgentListFieldsCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig() });
  const save = useInstantSave();
  const agentList = subagentAgentListFieldsFromConfig(config.data);
  const disabled = save.saving || config.isPending || config.isError;

  const updateFields = async (next: readonly AgentListTelemetryField[] | null) => {
    await save.run(async () => {
      const echoed = await client.patchConfig(subagentAgentListFieldsPatch(next));
      cache.setQueryData(['config'], echoed);
    });
  };

  return (
    <SectionCard
      id="st-card-subagent-agent-list-fields"
      title={t('st.agentListFields.label')}
      actions={
        <>
          <SaveStatus saving={save.saving} saved={save.saved} />
          {agentList.isCustom ? (
            <button
              type="button"
              disabled={disabled}
              data-agent-list-fields-reset
              onClick={() => { void updateFields(null); }}
              className="text-[12px] text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
            >
              {t('st.agentListFields.reset')}
            </button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3" data-agent-list-fields>
        <Hint>{t('st.agentListFields.help')}</Hint>
        <div
          role="group"
          aria-label={t('st.agentListFields.label')}
          className="flex flex-wrap items-center gap-1.5"
        >
          {AGENT_LIST_UI_FIELD_ORDER.map((item) => {
            const on = agentList.fields.includes(item);
            return (
              <button
                key={item}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                data-agent-list-field={item}
                onClick={() => { void updateFields(toggleAgentListField(agentList.fields, item)); }}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 ${
                  on
                    ? 'border-hairline-strong bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                    : 'border-dashed border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink'
                }`}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${on ? 'bg-selected-ink' : 'bg-ink/20'}`} aria-hidden="true" />
                <span>{t(`st.agentListFields.field.${item}`)}</span>
                <code className={`font-mono text-[11px] ${on ? 'text-ink-soft' : 'text-ink-faint/80'}`}>{item}</code>
              </button>
            );
          })}
        </div>
        {config.isError ? <InlineError error={config.error} /> : null}
        <FeedbackLine feedback={save.error} />
      </div>
    </SectionCard>
  );
}
