import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { OAuthDeviceCard } from '../OAuthDeviceCard';
import { NewProviderWizard, ProviderEditor } from '../ProviderFields';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * Tab 1 of the merged "Models & providers" entry (redesign §3.3): everything
 * about connecting a service — OAuth sign-in, configured providers with their
 * credentials/lifecycle, and the add-provider wizard. Model browsing and
 * new-session defaults live on the sibling tabs.
 */
export function ConnectionsTab() {
  const { client, config: connection } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthCancelling, setOauthCancelling] = useState(false);
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);
  const [dismissedFlows, setDismissedFlows] = useState<readonly string[]>([]);
  const prevFlowStatus = useRef<string | null>(null);

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  // The device flow polls at the server-suggested interval while pending and
  // stops on any terminal state.
  const oauthQuery = useQuery({
    queryKey: ['oauth'],
    queryFn: () => client.getOAuthStatus(),
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== null && data !== undefined && data.status === 'pending'
        ? Math.max(2000, data.interval * 1000)
        : false;
    },
  });

  const snapshot = oauthQuery.data ?? null;

  const refreshProviderData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
    ]);
  }, [queryClient]);

  // authenticated → auto-collapse the card and refresh provider data.
  useEffect(() => {
    if (snapshot === null) {
      prevFlowStatus.current = null;
      return;
    }
    if (snapshot.status === 'authenticated' && !dismissedFlows.includes(snapshot.flow_id)) {
      if (prevFlowStatus.current === 'pending') {
        setOauthFeedback({ tone: 'success', text: t('st.oauth.authenticated') });
      }
      setDismissedFlows((flows) => [...flows, snapshot.flow_id]);
      void refreshProviderData();
    }
    prevFlowStatus.current = snapshot.status;
  }, [snapshot, dismissedFlows, t, refreshProviderData]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const result = await client.startOAuthLogin();
      if (result.status === 'authenticated') {
        setOauthFeedback({ tone: 'success', text: t('st.auth.already') });
        await refreshProviderData();
      } else {
        // Surface the fresh pending flow immediately; the interval poller
        // takes over from here.
        setDismissedFlows([]);
        queryClient.setQueryData(['oauth'], result);
      }
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const cancelOAuth = async () => {
    setOauthCancelling(true);
    try {
      await client.cancelOAuthLogin();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthCancelling(false);
      await queryClient.invalidateQueries({ queryKey: ['oauth'] });
    }
  };

  const logout = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      await client.logoutOAuth();
      setDismissedFlows([]);
      setOauthFeedback({ tone: 'success', text: t('st.auth.removed') });
      await Promise.all([refreshProviderData(), queryClient.invalidateQueries({ queryKey: ['oauth'] })]);
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const visibleSnapshot = snapshot !== null
    && snapshot.status !== 'authenticated'
    && !dismissedFlows.includes(snapshot.flow_id)
    ? snapshot
    : null;

  const providerItems = providersQuery.data?.items ?? [];
  const unconfiguredCount = providerItems.filter((provider) => !provider.has_api_key).length;

  return (
    <div className="space-y-4">
      <SectionCard id="st-card-auth" title={t('st.auth.title')}>
        <div className="space-y-3">
          {authQuery.data !== undefined ? (
            <div className="flex items-start gap-2.5">
              <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${authQuery.data.ready ? 'bg-success' : 'bg-amber-rule'}`} />
              <div className="min-w-0 text-[12.5px]">
                <p className="font-medium text-ink">{authQuery.data.ready ? t('st.auth.statusReady') : t('st.auth.statusNotReady')}</p>
                <p className="text-ink-soft">{t('st.auth.summary', { count: authQuery.data.providers_count, model: authQuery.data.default_model ?? t('st.auth.none') })}</p>
                {authQuery.data.managed_provider ? (
                  <p className="text-ink-soft">{t('st.auth.managed', { status: authQuery.data.managed_provider.status })}</p>
                ) : null}
                {!authQuery.data.ready ? (
                  <Hint>{t('st.auth.signInNextHint')}</Hint>
                ) : null}
              </div>
            </div>
          ) : null}
          {visibleSnapshot !== null ? (
            <OAuthDeviceCard
              snapshot={visibleSnapshot}
              cancelling={oauthCancelling}
              onCancel={() => void cancelOAuth()}
              onRetry={() => void startOAuth()}
              onDismiss={() => { setDismissedFlows((flows) => [...flows, visibleSnapshot.flow_id]); }}
            />
          ) : null}
          <div className="flex gap-2">
            <button type="button" disabled={oauthBusy} onClick={() => void startOAuth()} className={PRIMARY_BUTTON}>{oauthBusy ? t('st.auth.working') : t('st.auth.signIn')}</button>
            <button type="button" disabled={oauthBusy} onClick={() => void logout()} className={SECONDARY_BUTTON}>{t('st.auth.signOut')}</button>
          </div>
          <Hint>{t('st.auth.sharedHomeHint')}</Hint>
          <FeedbackLine feedback={oauthFeedback} />
          {authQuery.isError ? <InlineError error={authQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-providers" title={t('st.providers.title')}>
        <div className="space-y-3">
          {providerItems.length > 0 ? <Hint>{t('st.providers.listHint')}</Hint> : null}
          {providerItems.map((provider) => (
            <ProviderEditor
              key={provider.id}
              provider={provider}
              models={modelsQuery.data?.items ?? []}
              managed={provider.id === authQuery.data?.managed_provider?.name}
              onSaved={refreshProviderData}
            />
          ))}
          {providersQuery.isLoading ? <Hint>{t('st.providers.loading')}</Hint> : null}
          {providersQuery.data?.items.length === 0 ? (
            <div className="space-y-1.5 rounded-lg border border-dashed border-hairline-strong px-3 py-4">
              <p className="text-[12.5px] text-ink-soft">{t('st.providers.empty')}</p>
              <Hint>{t('st.providers.emptyGo')}</Hint>
            </div>
          ) : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-providers-add" title={t('st.providers.addTitle')} aside={t('st.providers.addAside')}>
        <NewProviderWizard onSaved={refreshProviderData} />
      </SectionCard>

      {providerItems.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-panel px-3 py-2.5">
          <Hint>
            {t('st.providers.nextStepHint')}
            {unconfiguredCount > 0 ? ` ${t('st.providers.nextStepUnconfigured', { count: unconfiguredCount })}` : ''}
          </Hint>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} ml-auto`}
            onClick={() => { navigate('/settings/ai?tab=models'); }}
          >
            {t('st.defaults.pickModel')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
