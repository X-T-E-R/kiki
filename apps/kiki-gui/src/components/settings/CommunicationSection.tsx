import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  agentNotifyParentPatch,
  runtimeConfigDraftFromConfig,
  threadCommunicationPatch,
  tokenCountingPatch,
  type TokenCountingStrategy,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';

export function ThreadCommunicationCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const projected = runtimeConfigDraftFromConfig(configQuery.data);
      setDraft(projected.threadCommunicationEnabled);
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-thread-communication" title={t('st.communication.threadTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(threadCommunicationPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      const projected = runtimeConfigDraftFromConfig(echoed);
      setDraft(projected.threadCommunicationEnabled);
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.communication.threadSaved') });
    } catch (error) {
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
            onChange={(checked) => {
              setDraft(checked);
              setDirty(true);
              setFeedback(null);
            }}
          />
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

export function NotifyParentCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const projected = runtimeConfigDraftFromConfig(configQuery.data);
      setDraft(projected.agentsNotifyParent);
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-notify-parent" title={t('st.communication.notifyParentTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(agentNotifyParentPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      const projected = runtimeConfigDraftFromConfig(echoed);
      setDraft(projected.agentsNotifyParent);
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.communication.notifyParentSaved') });
    } catch (error) {
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
            onChange={(checked) => {
              setDraft(checked);
              setDirty(true);
              setFeedback(null);
            }}
          />
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

export function TokenCountingCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TokenCountingStrategy | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const projected = runtimeConfigDraftFromConfig(configQuery.data);
      setDraft(projected.tokenCountingStrategy);
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-token-counting" title={t('st.communication.tokenCountingTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(tokenCountingPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      const projected = runtimeConfigDraftFromConfig(echoed);
      setDraft(projected.tokenCountingStrategy);
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.communication.tokenCountingSaved') });
    } catch (error) {
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
              onChange={(event) => {
                setDraft(event.target.value as TokenCountingStrategy);
                setDirty(true);
                setFeedback(null);
              }}
            >
              <option value="measured+estimated">measured+estimated</option>
              <option value="measured">measured</option>
              <option value="estimated">estimated</option>
            </select>
          </label>
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

export function CommunicationSection() {
  return (
    <>
      <ThreadCommunicationCard />
      <NotifyParentCard />
      <TokenCountingCard />
    </>
  );
}
