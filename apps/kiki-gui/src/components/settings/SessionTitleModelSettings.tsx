import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { runtimeConfigDraftFromConfig, sessionTitleModelPatch } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * The model that writes session titles. Empty (the default) keeps title
 * generation on the managed `chat_title` tool; a pinned alias runs the same
 * prompt budgets through that model instead.
 */
export function SessionTitleModelCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      setDraft(runtimeConfigDraftFromConfig(configQuery.data).sessionTitleModel);
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-session-title-model" title={t('st.sessionTitleModel.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(sessionTitleModelPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      setDraft(runtimeConfigDraftFromConfig(echoed).sessionTitleModel);
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.sessionTitleModel.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-session-title-model" title={t('st.sessionTitleModel.title')}>
      <div className="space-y-3">
        <Hint>{t('st.sessionTitleModel.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
          <label className="block text-[12px] font-medium text-ink" htmlFor="session-title-model">
            {t('st.sessionTitleModel.model')}
            <input
              id="session-title-model"
              className={`${INPUT} mt-1`}
              value={draft}
              placeholder={t('st.sessionTitleModel.placeholder')}
              onChange={(event) => {
                setDraft(event.target.value);
                setDirty(true);
              }}
            />
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
