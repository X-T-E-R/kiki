import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import type { KikiConfigPatch } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus } from '../controls';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { CommitInput, SettingsSelect } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';

type ContextStrategy = 'summarize' | 'auto' | 'fresh';

/** The config echo keeps loop_control's inner keys camelCase or snake_case depending on the path. */
function readLoopLimits(value: unknown): { maxSteps?: number; maxAttempts?: number; subagentStrategy?: ContextStrategy } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pick = (camel: string, snake: string) => record[camel] ?? record[snake];
  const steps = pick('maxStepsPerTurn', 'max_steps_per_turn');
  const attempts = pick('maxAttemptsPerStep', 'max_attempts_per_step');
  const strategy = pick('subagentContextStrategy', 'subagent_context_strategy');
  return {
    maxSteps: typeof steps === 'number' ? steps : undefined,
    maxAttempts: typeof attempts === 'number' ? attempts : undefined,
    subagentStrategy: strategy === 'summarize' || strategy === 'auto' || strategy === 'fresh' ? strategy : undefined,
  };
}

const WHOLE_NUMBER = /^\d+$/;

/**
 * AI → Defaults → Turn limits: the per-turn step cap, the per-step attempt
 * budget and the subagent context strategy. Each value merges into
 * loop_control on its own, so the compaction keys beside them never move.
 */
export function LoopLimitsCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const steps = useInstantSave();
  const attempts = useInstantSave();
  const strategy = useInstantSave();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  if (configQuery.data === undefined) {
    return (
      <SectionCard id="st-card-loop-limits" title={t('st.loopLimits.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }
  const loop = readLoopLimits(configQuery.data.loop_control);
  const write = (loopControl: Record<string, unknown>) => async () => {
    const echoed = await client.patchConfig({ loop_control: loopControl } as KikiConfigPatch);
    queryClient.setQueryData(['config'], echoed);
  };
  const validateCount = (text: string) => (text === '' || WHOLE_NUMBER.test(text) ? null : t('st.loopLimits.wholeNumber'));

  return (
    <SectionCard id="st-card-loop-limits" title={t('st.loopLimits.title')} effect="newSessions">
      <div className="space-y-1">
        <SettingField label={t('st.loopLimits.maxSteps')} help={t('st.loopLimits.maxStepsHelp')}>
          <SaveStatus saving={steps.saving} saved={steps.saved} />
          <CommitInput
            ariaLabel={t('st.loopLimits.maxSteps')}
            dataAttr="data-loop-max-steps"
            className="w-24"
            inputMode="numeric"
            placeholder={t('st.loopLimits.unlimited')}
            value={loop.maxSteps === undefined || loop.maxSteps === 0 ? '' : String(loop.maxSteps)}
            validate={validateCount}
            disabled={steps.saving}
            // Empty or 0 both mean "no cap"; 0 is written so a merge can clear an older value.
            onCommit={(text) => void steps.run(write({ max_steps_per_turn: text === '' ? 0 : Number(text) }))}
          />
        </SettingField>
        <FeedbackLine feedback={steps.error} />
        <SettingField label={t('st.loopLimits.maxAttempts')} help={t('st.loopLimits.maxAttemptsHelp')}>
          <SaveStatus saving={attempts.saving} saved={attempts.saved} />
          <CommitInput
            ariaLabel={t('st.loopLimits.maxAttempts')}
            dataAttr="data-loop-max-attempts"
            className="w-24"
            inputMode="numeric"
            placeholder="5"
            value={loop.maxAttempts === undefined ? '' : String(loop.maxAttempts)}
            validate={(text) => (text === '' ? t('st.loopLimits.attemptsRequired') : validateCount(text))}
            disabled={attempts.saving}
            onCommit={(text) => void attempts.run(write({ max_attempts_per_step: Number(text) }))}
          />
        </SettingField>
        <FeedbackLine feedback={attempts.error} />
        <SettingField label={t('st.loopLimits.subagentStrategy')} help={t('st.loopLimits.subagentStrategyHelp')}>
          <SaveStatus saving={strategy.saving} saved={strategy.saved} />
          <SettingsSelect<ContextStrategy>
            id="loop-subagent-strategy"
            ariaLabel={t('st.loopLimits.subagentStrategy')}
            dataAttr="data-loop-subagent-strategy"
            value={loop.subagentStrategy ?? 'summarize'}
            disabled={strategy.saving}
            choices={(['summarize', 'auto', 'fresh'] as const).map((value) => ({
              value,
              label: t(`context.strategy.option.${value}`),
              hint: t(`context.strategy.hint.${value}`),
            }))}
            onChange={(value) => void strategy.run(write({ subagent_context_strategy: value }))}
          />
        </SettingField>
        <FeedbackLine feedback={strategy.error} />
      </div>
    </SectionCard>
  );
}
