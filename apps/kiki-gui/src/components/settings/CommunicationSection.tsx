import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  agentNotifyParentPatch,
  runtimeConfigDraftFromConfig,
  subscribeSettings,
  settingsSnapshot,
  settingsServerSnapshot,
  threadCommunicationPatch,
  tokenCountingPatch,
  writeSettings,
  type DefaultAppendTiming,
  type TokenCountingStrategy,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const APPEND_TIMINGS: readonly DefaultAppendTiming[] = ['agent_idle', 'subagents_done', 'tasks_done'];

const APPEND_TIMING_LABEL_KEY = {
  agent_idle: 'timing.agentIdle',
  subagents_done: 'timing.subagentsDone',
  tasks_done: 'timing.tasksDone',
} as const;

const APPEND_TIMING_HINT_KEY = {
  agent_idle: 'timing.hint.agentIdle',
  subagents_done: 'timing.hint.subagentsDone',
  tasks_done: 'timing.hint.tasksDone',
} as const;

export function ThreadCommunicationCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !saving) {
      setDraft(runtimeConfigDraftFromConfig(configQuery.data).threadCommunicationEnabled);
    }
  }, [configQuery.data, saving]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-thread-communication" title={t('st.communication.threadTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const apply = async (checked: boolean) => {
    setDraft(checked);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(threadCommunicationPatch(checked));
      queryClient.setQueryData(['config'], echoed);
      setDraft(runtimeConfigDraftFromConfig(echoed).threadCommunicationEnabled);
      setFeedback({ tone: 'success', text: t('st.communication.threadSaved') });
    } catch (error) {
      setDraft(configQuery.data === undefined ? draft : runtimeConfigDraftFromConfig(configQuery.data).threadCommunicationEnabled);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-thread-communication" title={t('st.communication.threadTitle')}>
      <div className="space-y-4">
        <Hint>{t('st.communication.threadHint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
          <Toggle
            label={t('st.communication.threadCommunication')}
            checked={draft}
            onChange={(checked) => { void apply(checked); }}
          />
        </fieldset>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function NotifyParentCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !saving) {
      setDraft(runtimeConfigDraftFromConfig(configQuery.data).agentsNotifyParent);
    }
  }, [configQuery.data, saving]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-notify-parent" title={t('st.communication.notifyParentTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const apply = async (checked: boolean) => {
    setDraft(checked);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(agentNotifyParentPatch(checked));
      queryClient.setQueryData(['config'], echoed);
      setDraft(runtimeConfigDraftFromConfig(echoed).agentsNotifyParent);
      setFeedback({ tone: 'success', text: t('st.communication.notifyParentSaved') });
    } catch (error) {
      setDraft(configQuery.data === undefined ? draft : runtimeConfigDraftFromConfig(configQuery.data).agentsNotifyParent);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-notify-parent" title={t('st.communication.notifyParentTitle')}>
      <div className="space-y-4">
        <Hint>{t('st.communication.notifyParentHint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
          <Toggle
            label={t('st.communication.notifyParent')}
            checked={draft}
            onChange={(checked) => { void apply(checked); }}
          />
        </fieldset>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function TokenCountingCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TokenCountingStrategy | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !saving) {
      setDraft(runtimeConfigDraftFromConfig(configQuery.data).tokenCountingStrategy);
    }
  }, [configQuery.data, saving]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-token-counting" title={t('st.communication.tokenCountingTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const apply = async (choice: TokenCountingStrategy) => {
    setDraft(choice);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(tokenCountingPatch(choice));
      queryClient.setQueryData(['config'], echoed);
      setDraft(runtimeConfigDraftFromConfig(echoed).tokenCountingStrategy);
      setFeedback({ tone: 'success', text: t('st.communication.tokenCountingSaved') });
    } catch (error) {
      setDraft(configQuery.data === undefined ? draft : runtimeConfigDraftFromConfig(configQuery.data).tokenCountingStrategy);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-token-counting" title={t('st.communication.tokenCountingTitle')}>
      <div className="space-y-4">
        <Hint>{t('st.communication.tokenCountingHint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.communication.tokenCounting')}
            <select
              className={`${SMALL_INPUT} mt-1 block`}
              value={draft}
              onChange={(event) => { void apply(event.target.value as TokenCountingStrategy); }}
            >
              <option value="measured+estimated">measured+estimated</option>
              <option value="measured">measured</option>
              <option value="estimated">estimated</option>
            </select>
          </label>
        </fieldset>

        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Local-only card: the default append timing for messages sent while the
 * agent is busy. Writes straight to the desktop settings store (no server
 * round-trip); the queue strip re-times individual messages on top of it.
 */
export function DefaultAppendTimingCard() {
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const [tick, ping] = useSavedTick();
  const current = settings.defaultAppendTiming;

  return (
    <SectionCard id="st-card-append-timing" title={t('st.communication.appendTimingTitle')}>
      <SettingField
        label={t('st.communication.appendTiming')}
        labelId="default-append-timing-label"
        help={<>{t('st.communication.appendTimingHint')} {t(APPEND_TIMING_HINT_KEY[current])}</>}
      >
        <SettingsSegmented<DefaultAppendTiming>
          ariaLabelledBy="default-append-timing-label"
          dataAttr="data-append-timing"
          value={current}
          onChange={(timing) => { writeSettings({ defaultAppendTiming: timing }); ping(); }}
          choices={APPEND_TIMINGS.map((timing) => ({ value: timing, label: t(APPEND_TIMING_LABEL_KEY[timing]) }))}
        />
        <SavedTick show={tick} />
      </SettingField>
    </SectionCard>
  );
}

export function CommunicationSection() {
  return (
    <>
      <ThreadCommunicationCard />
      <NotifyParentCard />
      <TokenCountingCard />
    </>
  );
}
