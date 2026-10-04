import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  runtimeConfigDraftFromConfig,
  taskRuntimePatch,
  type PrintBackgroundMode,
  type RuntimeConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { FORM_LABEL, SettingsDiagnosticRow, SettingsDraftFooter } from './SettingsPrimitives';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import { Group, NumberField } from './runtimeControls';
import { useSavedTick } from './useSavedTick';

/**
 * Engine defaults and bounds for the `task` domain. Source of each number:
 *  - bashTaskTimeoutS : DEFAULT_BACKGROUND_TIMEOUT_S = 600 s; `0` disarms the
 *    timeout (agent/task/taskService.ts arms the timer only when > 0)
 *  - killGracePeriodMs: SIGTERM_GRACE_MS = 5000 ms; `0` kills without waiting
 *  - printWaitCeilingS: PRINT_WAIT_CEILING_S_DEFAULT = floor(MAX_TIMER_DELAY_MS/1000)
 *  - printMaxTurns    : PRINT_MAX_TURNS_DEFAULT = 100000
 * An unset `maxRunningTasks` imposes no cap, and `0` is rejected by the schema.
 */
const TASK_DEFAULTS = {
  bashTaskTimeoutS: '600',
  killGracePeriodMs: '5000',
  printWaitCeilingS: '2147483',
  printMaxTurns: '100000',
} as const;

const PRINT_MODE_ORDER = ['exit', 'drain', 'steer'] as const;

const PRINT_MODE_LABEL_KEY: Record<PrintBackgroundMode, I18nKey> = {
  exit: 'st.taskPolicy.printMode.exit',
  drain: 'st.taskPolicy.printMode.drain',
  steer: 'st.taskPolicy.printMode.steer',
};

const PRINT_MODE_HINT_KEY: Record<PrintBackgroundMode, I18nKey> = {
  exit: 'st.taskPolicy.printMode.exitHint',
  drain: 'st.taskPolicy.printMode.drainHint',
  steer: 'st.taskPolicy.printMode.steerHint',
};

/**
 * The three non-interactive outcomes, spelled out instead of shown as wire
 * values: each row names what the run does after the main turn, with the
 * stored value kept as a mono caption for config files and bug reports.
 */
function PrintModePicker({ value, onChange }: {
  value: PrintBackgroundMode;
  onChange: (value: PrintBackgroundMode) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="min-w-0 space-y-1.5" data-task-print-mode={value}>
      <legend className={FORM_LABEL}>{t('st.taskPolicy.printMode')}</legend>
      {PRINT_MODE_ORDER.map((mode) => {
        const selected = mode === value;
        return (
          <label
            key={mode}
            data-task-print-mode-choice={mode}
            className={`flex cursor-pointer items-start gap-2 rounded-lg p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-selected-ink/50 ${
              selected ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'bg-ink/[0.03] hover:bg-ink/[0.05]'
            }`}
          >
            <input
              type="radio"
              name="task-print-mode"
              className="mt-0.5 accent-[var(--color-selected-ink)]"
              checked={selected}
              onChange={() => { if (!selected) onChange(mode); }}
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-baseline gap-1">
                <span className="text-[13px] font-medium text-ink">{t(PRINT_MODE_LABEL_KEY[mode])}</span>
                <span aria-hidden className="text-[11px] text-ink-faint">·</span>
                <span className="font-mono text-[11px] text-ink-faint">{mode}</span>
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t(PRINT_MODE_HINT_KEY[mode])}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Task and background policy (runtime split): the `task` config domain moved
 * from the retired runtime leaf to the Plan & tasks leaf, next to the plan
 * defaults and the task board it governs. Saves through the narrow
 * task-domain patch so it never rewrites domains owned by other leaves.
 *
 * The card is split by who is asking: everyday background limits stay flat,
 * the non-interactive (`kimi -p`) parameters and the kill grace period sit
 * under Advanced, where a wire-level value is worth seeing.
 */
export function TaskPolicyCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuntimeConfigDraft['task'] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
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
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-task-policy" title={t('st.taskPolicy.title')}>
      <div className="space-y-4">
        <Hint>{t('st.taskPolicy.hint')} <span className="text-ink-soft">{t('st.taskPolicy.emptyRule')}</span></Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label={t('st.taskPolicy.maxRunningTasks')}
              value={draft.maxRunningTasks}
              hint={t('st.taskPolicy.maxRunningTasksHint')}
              detail={t('st.taskPolicy.maxRunningTasksDetail')}
              onChange={(maxRunningTasks) => { updateTask({ maxRunningTasks }); }}
            />
            <NumberField
              label={t('st.taskPolicy.bashTimeout')}
              value={draft.bashTaskTimeoutS}
              hint={t('st.taskPolicy.bashTimeoutHint')}
              detail={t('st.taskPolicy.bashTimeoutDetail', { seconds: TASK_DEFAULTS.bashTaskTimeoutS })}
              onChange={(bashTaskTimeoutS) => { updateTask({ bashTaskTimeoutS }); }}
            />
          </div>
          <div className="space-y-1">
            <SettingField label={t('st.taskPolicy.autoBackground')} help={t('st.taskPolicy.autoBackgroundHelp')}>
              <Toggle layout="bare" label={t('st.taskPolicy.autoBackground')} checked={draft.bashAutoBackgroundOnTimeout} onChange={(bashAutoBackgroundOnTimeout) => { updateTask({ bashAutoBackgroundOnTimeout }); }} />
            </SettingField>
            <SettingField label={t('st.taskPolicy.keepAlive')} help={t('st.taskPolicy.keepAliveHelp')}>
              <Toggle layout="bare" label={t('st.taskPolicy.keepAlive')} checked={draft.keepAliveOnExit} onChange={(keepAliveOnExit) => { updateTask({ keepAliveOnExit }); }} />
            </SettingField>
            <SettingField label={t('st.taskPolicy.fileToolHints')} help={t('st.taskPolicy.fileToolHintsHelp')}>
              <Toggle layout="bare" label={t('st.taskPolicy.fileToolHints')} checked={draft.bashFileToolHints} onChange={(bashFileToolHints) => { updateTask({ bashFileToolHints }); }} />
            </SettingField>
          </div>
          <AdvancedDetails summary={t('st.taskPolicy.advanced')} data-task-policy-advanced>
            <div className="space-y-4">
              <Group title={t('st.taskPolicy.cliGroup')} hint={t('st.taskPolicy.cliGroupHint')}>
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <NumberField
                      label={t('st.taskPolicy.printWait')}
                      value={draft.printWaitCeilingS}
                      hint={t('st.taskPolicy.printWaitHint')}
                      detail={t('st.taskPolicy.printWaitDetail', { seconds: TASK_DEFAULTS.printWaitCeilingS })}
                      onChange={(printWaitCeilingS) => { updateTask({ printWaitCeilingS }); }}
                    />
                    <NumberField
                      label={t('st.taskPolicy.printTurns')}
                      value={draft.printMaxTurns}
                      hint={t('st.taskPolicy.printTurnsHint')}
                      detail={t('st.taskPolicy.printTurnsDetail', { turns: TASK_DEFAULTS.printMaxTurns })}
                      onChange={(printMaxTurns) => { updateTask({ printMaxTurns }); }}
                    />
                  </div>
                  <PrintModePicker
                    value={draft.printBackgroundMode}
                    onChange={(printBackgroundMode) => { updateTask({ printBackgroundMode }); }}
                  />
                </div>
              </Group>
              <Group title={t('st.taskPolicy.terminationGroup')} hint={t('st.taskPolicy.terminationGroupHint')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField
                    label={t('st.taskPolicy.killGrace')}
                    value={draft.killGracePeriodMs}
                    hint={t('st.taskPolicy.killGraceHint')}
                    detail={t('st.taskPolicy.killGraceDetail', { ms: TASK_DEFAULTS.killGracePeriodMs })}
                    onChange={(killGracePeriodMs) => { updateTask({ killGracePeriodMs }); }}
                  />
                </div>
              </Group>
            </div>
          </AdvancedDetails>
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="task-policy" dirty={dirty} saving={saving}
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
 * and is never persisted by this page. Switches read as on/off: this is a
 * status panel, not a form.
 */
export function CronRuntimeCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const [cron, setCron] = useState<RuntimeConfigDraft['cron'] | null>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setCron(runtimeConfigDraftFromConfig(configQuery.data).cron);
  }, [configQuery.data]);

  const onOff = (value: boolean) => value ? t('st.cron.on') : t('st.cron.off');
  return (
    <SectionCard id="st-card-cron" title={t('st.cron.title')} scope="readOnly">
      <div className="space-y-3">
        <Hint>{t('st.cron.hint')}</Hint>
        {cron === null ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <dl className="grid gap-x-6 sm:grid-cols-2" data-settings-diagnostics>
            <SettingsDiagnosticRow label={t('st.cron.debug')} value={onOff(cron.debug)} />
            <SettingsDiagnosticRow label={t('st.cron.noJitter')} value={onOff(cron.noJitter)} />
            <SettingsDiagnosticRow label={t('st.cron.noStale')} value={onOff(cron.noStale)} />
            <SettingsDiagnosticRow label={t('st.cron.disabled')} value={onOff(cron.disabled)} />
            <SettingsDiagnosticRow label={t('st.cron.manualTick')} value={onOff(cron.manualTick)} />
            <SettingsDiagnosticRow label={t('st.cron.clock')} value={cron.clock} />
            <SettingsDiagnosticRow label={t('st.cron.poll')} value={millisecondsAsSeconds(cron.pollIntervalMs)} />
          </dl>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Diagnostics read durations in the same readable unit as the editor fields.
 * Values that are not a number (an unset or explicitly `null` poll interval)
 * pass through untouched.
 */
function millisecondsAsSeconds(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return value;
  return String(Number(trimmed) / 1000);
}
