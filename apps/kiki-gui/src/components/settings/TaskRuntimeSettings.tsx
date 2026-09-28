import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  runtimeConfigDraftFromConfig,
  taskRuntimePatch,
  type RuntimeConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { SearchableSelect } from '../SearchableSelect';
import { FORM_LABEL, FORM_SELECT_TRIGGER, SettingsDiagnosticRow, SettingsDraftFooter } from './SettingsPrimitives';
import { SectionCard } from './SectionCard';
import { NumberField } from './runtimeControls';

/**
 * Task and background policy (runtime split): the `task` config domain moved
 * from the retired runtime leaf to the Plan & tasks leaf, next to the plan
 * defaults and the task board it governs. Saves through the narrow
 * task-domain patch so it never rewrites domains owned by other leaves.
 */
export function TaskPolicyCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuntimeConfigDraft['task'] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      setDraft(runtimeConfigDraftFromConfig(configQuery.data).task);
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-task-policy" title={t('st.taskPolicy.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const updateTask = (patch: Partial<RuntimeConfigDraft['task']>) => {
    setDraft((current) => current === null ? current : { ...current, ...patch });
    setDirty(true);
  };

  const save = async () => {
    let patch;
    try {
      patch = taskRuntimePatch(draft);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setDraft(runtimeConfigDraftFromConfig(echoed).task);
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.taskPolicy.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-task-policy" title={t('st.taskPolicy.title')}>
      <div className="space-y-4">
        <Hint>{t('st.taskPolicy.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label={t('st.taskPolicy.maxRunningTasks')} value={draft.maxRunningTasks} onChange={(maxRunningTasks) => { updateTask({ maxRunningTasks }); }} />
            <NumberField label={t('st.taskPolicy.bashTimeout')} value={draft.bashTaskTimeoutS} onChange={(bashTaskTimeoutS) => { updateTask({ bashTaskTimeoutS }); }} />
            <NumberField label={t('st.taskPolicy.killGrace')} value={draft.killGracePeriodMs} onChange={(killGracePeriodMs) => { updateTask({ killGracePeriodMs }); }} />
            <NumberField label={t('st.taskPolicy.printWait')} value={draft.printWaitCeilingS} onChange={(printWaitCeilingS) => { updateTask({ printWaitCeilingS }); }} />
            <NumberField label={t('st.taskPolicy.printTurns')} value={draft.printMaxTurns} onChange={(printMaxTurns) => { updateTask({ printMaxTurns }); }} />
            <div className="min-w-0">
              <span id="task-print-mode-label" className={FORM_LABEL}>{t('st.taskPolicy.printMode')}</span>
              <div className="mt-1">
                {/* Sits in a grid of bordered number inputs, so it wears the form trigger. */}
                <SearchableSelect
                  id="task-print-mode"
                  ariaLabel={t('st.taskPolicy.printMode')}
                  value={draft.printBackgroundMode}
                  disabled={saving}
                  hideFilter
                  onChange={(next) => { updateTask({ printBackgroundMode: next as RuntimeConfigDraft['task']['printBackgroundMode'] }); }}
                  options={(['exit', 'drain', 'steer'] as const).map((mode) => ({ value: mode, label: mode }))}
                  buttonClassName={`${FORM_SELECT_TRIGGER} font-mono`}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle label={t('st.taskPolicy.keepAlive')} checked={draft.keepAliveOnExit} onChange={(keepAliveOnExit) => { updateTask({ keepAliveOnExit }); }} />
            <Toggle label={t('st.taskPolicy.autoBackground')} checked={draft.bashAutoBackgroundOnTimeout} onChange={(bashAutoBackgroundOnTimeout) => { updateTask({ bashAutoBackgroundOnTimeout }); }} />
          </div>
        </fieldset>
        <SettingsDraftFooter id="task-policy" dirty={dirty} saving={saving}
          onSave={() => void save()}
          onDiscard={() => { if (configQuery.data !== undefined) setDraft(runtimeConfigDraftFromConfig(configQuery.data).task); setDirty(false); setFeedback(null); }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Environment diagnostics under System & data. Cron is env-driven (KIKI_CRON_*)
 * and is never persisted by this page.
 */
export function CronRuntimeCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const [cron, setCron] = useState<RuntimeConfigDraft['cron'] | null>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setCron(runtimeConfigDraftFromConfig(configQuery.data).cron);
  }, [configQuery.data]);

  return (
    <SectionCard id="st-card-cron" title={t('st.cron.title')} scope="readOnly">
      <div className="space-y-3">
        <Hint>{t('st.cron.hint')}</Hint>
        {cron === null ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <dl className="grid gap-x-6 sm:grid-cols-2" data-settings-diagnostics>
            <SettingsDiagnosticRow label={t('st.cron.debug')} value={cron.debug} />
            <SettingsDiagnosticRow label={t('st.cron.noJitter')} value={cron.noJitter} />
            <SettingsDiagnosticRow label={t('st.cron.noStale')} value={cron.noStale} />
            <SettingsDiagnosticRow label={t('st.cron.disabled')} value={cron.disabled} />
            <SettingsDiagnosticRow label={t('st.cron.manualTick')} value={cron.manualTick} />
            <SettingsDiagnosticRow label={t('st.cron.clock')} value={cron.clock} />
            <SettingsDiagnosticRow label={t('st.cron.poll')} value={cron.pollIntervalMs} />
          </dl>
        )}
      </div>
    </SectionCard>
  );
}
