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
  type RuntimeConfigDraft,
  type TokenCountingStrategy,
} from '@kiki/session-core/settings';
import type { KikiConfigPatch } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
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

/**
 * Instant-apply binding for one value projected out of the server config:
 * optimistic local state, a narrow patch, the echoed value as the truth, and
 * a rollback plus inline error when the write fails.
 */
function useServerChoice<T>(project: (draft: RuntimeConfigDraft) => T, patch: (value: T) => KikiConfigPatch) {
  const { client } = useConnection();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [value, setValue] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();

  useEffect(() => {
    if (configQuery.data !== undefined && !saving) setValue(project(runtimeConfigDraftFromConfig(configQuery.data)));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- project is a stable pure selector
  }, [configQuery.data, saving]);

  const apply = async (next: T) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const echoed = await client.patchConfig(patch(next));
      queryClient.setQueryData(['config'], echoed);
      setValue(project(runtimeConfigDraftFromConfig(echoed)));
      ping();
    } catch (cause) {
      setValue(previous);
      setError({ tone: 'error', text: errorText(locale, cause) });
    } finally {
      setSaving(false);
    }
  };
  return { value, apply, saving, error, saved, configQuery };
}

/**
 * Sessions → Agent messaging: the two channels agents use to talk outside
 * their own reply. One card, two switches, each saved the moment it flips.
 */
export function AgentMessagingCard() {
  const { t } = useI18n();
  const thread = useServerChoice((draft) => draft.threadCommunicationEnabled, threadCommunicationPatch);
  const notify = useServerChoice((draft) => draft.agentsNotifyParent, agentNotifyParentPatch);
  const loading = thread.value === null || notify.value === null;

  return (
    <SectionCard id="st-card-agent-messaging" title={t('st.sessions.messagingTitle')}>
      {loading ? (
        thread.configQuery.isError ? <InlineError error={thread.configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
      ) : (
        <div className="space-y-1">
          <div data-settings-field data-agent-messaging="thread" className="space-y-0.5 py-1">
            <Toggle layout="row" label={t('st.communication.threadCommunication')} checked={thread.value === true}
              disabled={thread.saving} onChange={(checked) => { void thread.apply(checked); }} />
            <Hint>{t('st.sessions.threadHint')}</Hint>
            <FeedbackLine feedback={thread.error} />
          </div>
          <div data-settings-field data-agent-messaging="notify" className="space-y-0.5 py-1">
            <Toggle layout="row" label={t('st.communication.notifyParent')} checked={notify.value === true}
              disabled={notify.saving} onChange={(checked) => { void notify.apply(checked); }} />
            <Hint>{t('st.sessions.notifyHint')}</Hint>
            <FeedbackLine feedback={notify.error} />
          </div>
          <SavedTick show={thread.saved || notify.saved} />
        </div>
      )}
    </SectionCard>
  );
}

/** Developer → Token counting: a reporting detail, applied on change. */
export function TokenCountingCard() {
  const { t } = useI18n();
  const choice = useServerChoice((draft) => draft.tokenCountingStrategy, tokenCountingPatch);
  return (
    <SectionCard id="st-card-token-counting" title={t('st.communication.tokenCountingTitle')}>
      {choice.value === null ? (
        choice.configQuery.isError ? <InlineError error={choice.configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
      ) : (
        <div className="space-y-1">
          <SettingField label={t('st.communication.tokenCounting')} help={t('st.dev.tokenHint')}>
            <SettingsSelect<TokenCountingStrategy>
              id="token-counting-strategy"
              ariaLabel={t('st.communication.tokenCounting')}
              value={choice.value}
              disabled={choice.saving}
              onChange={(next) => { void choice.apply(next); }}
              choices={(['measured+estimated', 'measured', 'estimated'] as const).map((value) => ({ value, label: value }))}
              className="font-mono"
            />
            <SavedTick show={choice.saved} />
          </SettingField>
          <FeedbackLine feedback={choice.error} />
        </div>
      )}
    </SectionCard>
  );
}

/**
 * General → Composer: when a message sent while the agent is busy starts.
 * A device default; the queue strip can still re-time each message.
 */
export function AppendTimingField() {
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const current = settings.defaultAppendTiming;
  return (
    <div id="st-card-append-timing" className="scroll-mt-4">
      <SettingField
        label={t('st.communication.appendTimingTitle')}
        labelId="default-append-timing-label"
        help={<>{t('st.communication.appendTimingHint')} {t(APPEND_TIMING_HINT_KEY[current])}</>}
      >
        <SettingsSegmented<DefaultAppendTiming>
          ariaLabelledBy="default-append-timing-label"
          dataAttr="data-append-timing"
          value={current}
          onChange={(timing) => { writeSettings({ defaultAppendTiming: timing }); }}
          choices={APPEND_TIMINGS.map((timing) => ({ value: timing, label: t(APPEND_TIMING_LABEL_KEY[timing]) }))}
        />
      </SettingField>
    </div>
  );
}
