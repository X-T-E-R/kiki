import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  markRestartRequired,
  runtimeConfigDraftFromConfig,
  runtimeConfigPatch,
  type RuntimeConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from './controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from './ui';
import { SectionCard } from './settings/SectionCard';

function NumberField({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="text-[11px] font-medium text-ink-soft">
      {label}
      <input
        className={`${INPUT} mt-1 font-mono`}
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        onChange={(event) => { onChange(event.target.value); }}
      />
    </label>
  );
}

function StringListEditor({ label, values, onChange, placeholder }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-ink-soft">{label}</span>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { onChange([...values, '']); }}>
          {t('st.runtime.addEntry')}
        </button>
      </div>
      {values.map((value, index) => (
        <div key={`${index}:${value}`} className="flex gap-2">
          <input
            className={`${INPUT} font-mono`}
            value={value}
            placeholder={placeholder}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => {
              onChange(values.map((entry, candidate) => candidate === index ? event.target.value : entry));
            }}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            aria-label={t('st.runtime.removeEntry', { n: index + 1 })}
            onClick={() => { onChange(values.filter((_, candidate) => candidate !== index)); }}
          >
            ×
          </button>
        </div>
      ))}
      {values.length === 0 ? <Hint>{t('st.runtime.listEmpty')}</Hint> : null}
    </div>
  );
}

/** One settings cluster: a quiet heading plus a one-line "what it affects". */
function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-hairline pt-3 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-[12px] font-semibold text-ink">{title}</h3>
        {hint !== undefined ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function RuntimeConfigEditor() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuntimeConfigDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) setDraft(runtimeConfigDraftFromConfig(configQuery.data));
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-runtime" title={t('st.runtime.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const updateDraft = (next: RuntimeConfigDraft) => {
    setDraft(next);
    setDirty(true);
  };
  const updateTask = (patch: Partial<RuntimeConfigDraft['task']>) => {
    setDraft((current) => current === null ? current : { ...current, task: { ...current.task, ...patch } });
    setDirty(true);
  };
  const updateCron = (patch: Partial<RuntimeConfigDraft['cron']>) => {
    setDraft((current) => current === null ? current : { ...current, cron: { ...current.cron, ...patch } });
    setDirty(true);
  };

  const save = async () => {
    let patch;
    const identityChanged = draft.identityName.trim() !== (configQuery.data?.identity?.name ?? '')
      || draft.identitySlug.trim() !== (configQuery.data?.identity?.slug ?? '');
    try {
      patch = runtimeConfigPatch(draft);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setDraft(runtimeConfigDraftFromConfig(echoed));
      setDirty(false);
      if (identityChanged) markRestartRequired(['identity']);
      // The patch is narrow: the mcp and tools domains belong to the MCP
      // timeouts card and the automation leaf's tool policy card, so nothing
      // here needs their queries invalidated.
      setFeedback({ tone: 'success', text: t('st.runtime.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <SectionCard id="st-card-runtime" title={t('st.runtime.title')}>
        <div className="space-y-4">
          <Hint>{t('st.runtime.hint')}</Hint>
          <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
            <Group title={t('st.runtime.task')} hint={t('st.runtime.taskHint')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField label={t('st.runtime.maxRunningTasks')} value={draft.task.maxRunningTasks} onChange={(maxRunningTasks) => { updateTask({ maxRunningTasks }); }} />
                <NumberField label={t('st.runtime.bashTimeout')} value={draft.task.bashTaskTimeoutS} onChange={(bashTaskTimeoutS) => { updateTask({ bashTaskTimeoutS }); }} />
                <NumberField label={t('st.runtime.killGrace')} value={draft.task.killGracePeriodMs} onChange={(killGracePeriodMs) => { updateTask({ killGracePeriodMs }); }} />
                <NumberField label={t('st.runtime.printWait')} value={draft.task.printWaitCeilingS} onChange={(printWaitCeilingS) => { updateTask({ printWaitCeilingS }); }} />
                <NumberField label={t('st.runtime.printTurns')} value={draft.task.printMaxTurns} onChange={(printMaxTurns) => { updateTask({ printMaxTurns }); }} />
                <label className="text-[11px] font-medium text-ink-soft">{t('st.runtime.printMode')}
                  <select className={`${SMALL_INPUT} mt-1 block`} value={draft.task.printBackgroundMode} onChange={(event) => { updateTask({ printBackgroundMode: event.target.value as RuntimeConfigDraft['task']['printBackgroundMode'] }); }}>
                    <option value="exit">exit</option>
                    <option value="drain">drain</option>
                    <option value="steer">steer</option>
                  </select>
                </label>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Toggle label={t('st.runtime.keepAlive')} checked={draft.task.keepAliveOnExit} onChange={(keepAliveOnExit) => { updateTask({ keepAliveOnExit }); }} />
                <Toggle label={t('st.runtime.autoBackground')} checked={draft.task.bashAutoBackgroundOnTimeout} onChange={(bashAutoBackgroundOnTimeout) => { updateTask({ bashAutoBackgroundOnTimeout }); }} />
              </div>
            </Group>

            <Group title={t('st.runtime.resources')} hint={t('st.runtime.resourcesHint')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField label={t('st.runtime.workspaceIdle')} value={draft.workspaceIdleTtlMs} onChange={(workspaceIdleTtlMs) => { updateDraft({ ...draft, workspaceIdleTtlMs }); }} />
                <NumberField label={t('st.runtime.imageMaxEdge')} value={draft.imageMaxEdgePx} onChange={(imageMaxEdgePx) => { updateDraft({ ...draft, imageMaxEdgePx }); }} />
                <NumberField label={t('st.runtime.imageBudget')} value={draft.imageReadByteBudget} onChange={(imageReadByteBudget) => { updateDraft({ ...draft, imageReadByteBudget }); }} />
                {/* MCP startup/tool timeouts live on Settings → MCP
                    (st-card-mcp-timeouts) since the batch-3 split; the
                    runtime draft and patch no longer carry the mcp domain. */}
              </div>
            </Group>

            <Group title={t('st.runtime.communication')} hint={t('st.runtime.communicationHint')}>
              <Toggle label={t('st.runtime.threadCommunication')} checked={draft.threadCommunicationEnabled} onChange={(threadCommunicationEnabled) => { updateDraft({ ...draft, threadCommunicationEnabled }); }} />
              <label className="block text-[11px] font-medium text-ink-soft">{t('st.runtime.tokenCounting')}
                <select className={`${SMALL_INPUT} mt-1 block`} value={draft.tokenCountingStrategy} onChange={(event) => { updateDraft({ ...draft, tokenCountingStrategy: event.target.value as RuntimeConfigDraft['tokenCountingStrategy'] }); }}>
                  <option value="measured+estimated">measured+estimated</option>
                  <option value="measured">measured</option>
                  <option value="estimated">estimated</option>
                </select>
              </label>
            </Group>

            <Group title={t('st.runtime.agents')} hint={t('st.runtime.agentsHint')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-[11px] font-medium text-ink-soft">{t('st.runtime.identityName')}
                  <input className={`${INPUT} mt-1`} value={draft.identityName} onChange={(event) => { updateDraft({ ...draft, identityName: event.target.value }); }} />
                </label>
                <label className="text-[11px] font-medium text-ink-soft">{t('st.runtime.identitySlug')}
                  <input className={`${INPUT} mt-1 font-mono`} value={draft.identitySlug} onChange={(event) => { updateDraft({ ...draft, identitySlug: event.target.value }); }} />
                </label>
              </div>
              <StringListEditor label={t('st.runtime.extraAgentDirs')} values={draft.extraAgentDirs} placeholder="C:\agents" onChange={(extraAgentDirs) => { updateDraft({ ...draft, extraAgentDirs }); }} />
              <StringListEditor label={t('st.runtime.disabledProfiles')} values={draft.disabledBuiltinProfiles} placeholder="profile-name" onChange={(disabledBuiltinProfiles) => { updateDraft({ ...draft, disabledBuiltinProfiles }); }} />
            </Group>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>
              {saving ? t('common.saving') : t('st.runtime.save')}
            </button>
            {dirty ? <span className="text-[11px] font-medium text-amber-ink">{t('st.tools.unsaved')}</span> : null}
          </div>
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard title={t('st.runtime.cron')}>
        <div className="space-y-3">
          {/* cron is env-driven (KIMI_CRON_*) and never persisted — read-only display. */}
          <Hint>{t('st.runtime.cronHint')}</Hint>
          <fieldset disabled className="min-w-0 space-y-3 opacity-60">
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle label={t('st.runtime.cronDebug')} checked={draft.cron.debug} onChange={(debug) => { updateCron({ debug }); }} />
              <Toggle label={t('st.runtime.cronNoJitter')} checked={draft.cron.noJitter} onChange={(noJitter) => { updateCron({ noJitter }); }} />
              <Toggle label={t('st.runtime.cronNoStale')} checked={draft.cron.noStale} onChange={(noStale) => { updateCron({ noStale }); }} />
              <Toggle label={t('st.runtime.cronDisabled')} checked={draft.cron.disabled} onChange={(disabled) => { updateCron({ disabled }); }} />
              <Toggle label={t('st.runtime.cronManualTick')} checked={draft.cron.manualTick} onChange={(manualTick) => { updateCron({ manualTick }); }} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-medium text-ink-soft">{t('st.runtime.cronClock')}
                <input className={`${INPUT} mt-1 font-mono`} value={draft.cron.clock} onChange={(event) => { updateCron({ clock: event.target.value }); }} />
              </label>
              <NumberField label={t('st.runtime.cronPoll')} value={draft.cron.pollIntervalMs} placeholder={t('st.runtime.cronPollPlaceholder')} onChange={(pollIntervalMs) => { updateCron({ pollIntervalMs }); }} />
            </div>
          </fieldset>
        </div>
      </SectionCard>
    </div>
  );
}
