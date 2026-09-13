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
import { INPUT, PRIMARY_BUTTON, SMALL_INPUT } from '../ui';
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
            <label className="text-[11px] font-medium text-ink-soft">{t('st.taskPolicy.printMode')}
              <select className={`${SMALL_INPUT} mt-1 block`} value={draft.printBackgroundMode} onChange={(event) => { updateTask({ printBackgroundMode: event.target.value as RuntimeConfigDraft['task']['printBackgroundMode'] }); }}>
                <option value="exit">exit</option>
                <option value="drain">drain</option>
                <option value="steer">steer</option>
              </select>
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle label={t('st.taskPolicy.keepAlive')} checked={draft.keepAliveOnExit} onChange={(keepAliveOnExit) => { updateTask({ keepAliveOnExit }); }} />
            <Toggle label={t('st.taskPolicy.autoBackground')} checked={draft.bashAutoBackgroundOnTimeout} onChange={(bashAutoBackgroundOnTimeout) => { updateTask({ bashAutoBackgroundOnTimeout }); }} />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
          <button type="button" className={PRIMARY_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
          {dirty ? <span className="text-[11px] font-medium text-amber-ink">{t('st.tools.unsaved')}</span> : null}
        </div>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Cron operations (runtime split): the scheduler belongs with Plan & tasks.
 * cron is env-driven (KIMI_CRON_*) and never persisted — read-only display.
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
    <SectionCard id="st-card-cron" title={t('st.cron.title')}>
      <div className="space-y-3">
        <Hint>{t('st.cron.hint')}</Hint>
        {cron === null ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <fieldset disabled className="min-w-0 space-y-3 opacity-60">
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle label={t('st.cron.debug')} checked={cron.debug} onChange={() => {}} />
              <Toggle label={t('st.cron.noJitter')} checked={cron.noJitter} onChange={() => {}} />
              <Toggle label={t('st.cron.noStale')} checked={cron.noStale} onChange={() => {}} />
              <Toggle label={t('st.cron.disabled')} checked={cron.disabled} onChange={() => {}} />
              <Toggle label={t('st.cron.manualTick')} checked={cron.manualTick} onChange={() => {}} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-medium text-ink-soft">{t('st.cron.clock')}
                <input className={`${INPUT} mt-1 font-mono`} value={cron.clock} readOnly />
              </label>
              <NumberField label={t('st.cron.poll')} value={cron.pollIntervalMs} placeholder={t('st.cron.pollPlaceholder')} onChange={() => {}} />
            </div>
          </fieldset>
        )}
      </div>
    </SectionCard>
  );
}
