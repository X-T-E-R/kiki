import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import type { SearchMessagesResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

type IndexState = SearchMessagesResponse['index_state'];

export const SEARCH_INDEX_STATE_KEY = ['search-index-state'] as const;

/**
 * The server has no status route for the full-text index, but every search
 * page carries `index_state`; one single-result query reads it.
 */
const PROBE = { query: 'kiki', page_size: 1 } as const;

/** Reasons the user cannot fix by restarting the indexer. */
const NOT_RETRYABLE = new Set<IndexState['reason']>(['disabled', 'runtime_disabled']);

/**
 * Where the sidebar says "full-text search is unavailable", this card says
 * why in the same words and offers the same restart, so an indexer that
 * exhausted its memory budget can be brought back without a server restart.
 */
export function SearchIndexStatusCard() {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const state = useQuery({
    queryKey: SEARCH_INDEX_STATE_KEY,
    queryFn: async ({ signal }) => (await client.searchMessages(PROBE, signal)).index_state,
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.state === 'building' ? 3_000 : false),
  });
  const index = state.data;

  const retry = async () => {
    setRetrying(true);
    setFeedback(null);
    try {
      await client.retrySearchIndexer();
      setFeedback({ tone: 'success', text: t('st.searchIndex.retried') });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SEARCH_INDEX_STATE_KEY }),
        queryClient.invalidateQueries({ queryKey: ['global-search'] }),
      ]);
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.searchIndex.retryFailed', { reason: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setRetrying(false);
    }
  };

  const counts = index === undefined ? undefined : { indexed: index.indexed_sessions, total: index.total_sessions };
  const line = index === undefined
    ? state.isError
      ? t('st.searchIndex.checkFailed', { reason: state.error instanceof Error ? state.error.message : String(state.error) })
      : t('st.searchIndex.checking')
    : index.state === 'unavailable'
      ? t(`sidebar.results.unavailable.${index.reason ?? 'generic'}`)
      : index.state === 'building'
        ? t('st.searchIndex.building', counts)
        : index.state === 'readonly'
          ? t('st.searchIndex.readonly', counts)
          : t('st.searchIndex.ready', counts);
  const canRetry = index?.state === 'unavailable' && !NOT_RETRYABLE.has(index.reason);

  return (
    <SectionCard id="st-card-search-index" title={t('st.searchIndex.title')}>
      <div className="space-y-3" data-search-index-status={index?.state ?? (state.isError ? 'error' : 'checking')} data-search-index-reason={index?.reason}>
        <p
          role="status"
          className={`text-[12.5px] ${index?.state === 'unavailable' || state.isError ? 'text-danger' : 'text-ink-soft'}`}
        >
          {line}
        </p>
        {canRetry ? (
          <button type="button" className={SECONDARY_BUTTON} data-search-index-retry disabled={retrying} onClick={() => { void retry(); }}>
            {retrying ? t('st.searchIndex.retrying') : t('st.searchIndex.retry')}
          </button>
        ) : state.isError ? (
          <button type="button" className={SECONDARY_BUTTON} data-search-index-recheck onClick={() => { void state.refetch(); }}>
            {t('common.retry')}
          </button>
        ) : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
