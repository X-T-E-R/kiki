/**
 * Account sign-in (OAuth) — one row per method the server offers (Kimi Code,
 * GitHub Copilot, ChatGPT, …), each with its own sign-in / sign-out control
 * and status. At most one device flow runs at a time; its card opens under
 * the method that started it and the panel polls that method's flow at the
 * server-suggested interval. Shared by the Connections settings tab and the
 * onboarding model step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { OAuthMethodStatus } from '../lib/client';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import { FeedbackLine, InlineError, type Feedback } from './controls';
import { SECONDARY_BUTTON } from './ui';
import { protocolLabel } from './providerPresets';

export const OAUTH_METHODS_QUERY_KEY = ['oauth-methods'] as const;

export function AccountSignIn({
  onChanged,
  compact = false,
}: {
  /** Called after a sign-in completes or a sign-out lands. */
  onChanged?: () => Promise<void> | void;
  /** Onboarding density: no protocol line, sign-out hidden. */
  compact?: boolean;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [feedback, setFeedback] = useState<{ provider: string; value: Feedback } | null>(null);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const previousStatus = useRef<string | null>(null);

  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 10_000,
  });
  const flowQuery = useQuery({
    queryKey: ['oauth', active],
    enabled: active !== null,
    queryFn: () => client.getOAuthStatus({ provider: active ?? undefined }),
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== null && data !== undefined && data.status === 'pending'
        ? Math.max(2000, data.interval * 1000)
        : false;
    },
  });
  const snapshot = active === null ? null : (flowQuery.data ?? null);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: OAUTH_METHODS_QUERY_KEY });
    await onChanged?.();
  }, [onChanged, queryClient]);

  useEffect(() => {
    if (snapshot === null) {
      previousStatus.current = null;
      return;
    }
    if (snapshot.status === 'authenticated' && !dismissed.includes(snapshot.flow_id)) {
      if (previousStatus.current === 'pending') {
        setFeedback({ provider: snapshot.provider, value: { tone: 'success', text: t('st.oauth.authenticated') } });
      }
      setDismissed((flows) => [...flows, snapshot.flow_id]);
      void refresh();
    }
    previousStatus.current = snapshot.status;
  }, [snapshot, dismissed, refresh, t]);

  const start = async (method: OAuthMethodStatus) => {
    setBusy(method.provider);
    setFeedback(null);
    try {
      const result = await client.startOAuthLogin({ provider: method.id });
      setActive(method.provider);
      if (result.status === 'authenticated') {
        setFeedback({ provider: method.provider, value: { tone: 'success', text: t('st.auth.already') } });
        await refresh();
      } else {
        setDismissed([]);
        queryClient.setQueryData(['oauth', method.provider], result);
      }
    } catch (error) {
      setFeedback({ provider: method.provider, value: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (active === null) return;
    setCancelling(true);
    try {
      await client.cancelOAuthLogin({ provider: active });
    } catch (error) {
      setFeedback({ provider: active, value: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      setCancelling(false);
      await queryClient.invalidateQueries({ queryKey: ['oauth', active] });
    }
  };

  const signOut = async (method: OAuthMethodStatus) => {
    setBusy(method.provider);
    setFeedback(null);
    try {
      await client.logoutOAuth({ provider: method.id });
      setFeedback({ provider: method.provider, value: { tone: 'success', text: t('st.account.signedOut', { method: method.label }) } });
      await refresh();
    } catch (error) {
      setFeedback({ provider: method.provider, value: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      setBusy(null);
    }
  };

  const visibleSnapshot = snapshot !== null
    && snapshot.status !== 'authenticated'
    && !dismissed.includes(snapshot.flow_id)
    ? snapshot
    : null;
  const methods = methodsQuery.data ?? [];

  return (
    <div className="space-y-2" data-account-sign-in>
      <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-panel">
        {methods.map((method) => {
          const pending = visibleSnapshot !== null && visibleSnapshot.provider === method.provider;
          const rowFeedback = feedback?.provider === method.provider ? feedback.value : null;
          return (
            <li key={method.id} data-oauth-method={method.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                    {method.label}
                    {method.signed_in ? (
                      <span className="inline-flex items-center gap-1 rounded-[4px] bg-success/10 px-1.5 py-px text-[11px] font-medium text-success">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
                        {t('st.account.signedIn')}
                      </span>
                    ) : null}
                  </p>
                  {compact ? null : (
                    <p className="truncate text-[11.5px] text-ink-faint">
                      {t(`st.account.method.${method.id}` as 'st.account.method.kimi-code')} · {protocolLabel(method.protocol)}
                    </p>
                  )}
                </div>
                {method.signed_in ? (
                  compact ? null : (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={busy !== null}
                      onClick={() => void signOut(method)}
                    >
                      {busy === method.provider ? t('st.auth.working') : t('st.auth.signOut')}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={busy !== null || pending}
                    aria-label={t('st.account.signInWith', { method: method.label })}
                    onClick={() => void start(method)}
                  >
                    {busy === method.provider ? t('st.auth.working') : t('st.account.signIn')}
                  </button>
                )}
              </div>
              {pending ? (
                <div className="mt-3">
                  <OAuthDeviceCard
                    snapshot={visibleSnapshot}
                    label={method.label}
                    cancelling={cancelling}
                    onCancel={() => void cancel()}
                    onRetry={() => void start(method)}
                    onDismiss={() => { setDismissed((flows) => [...flows, visibleSnapshot.flow_id]); }}
                  />
                </div>
              ) : null}
              {rowFeedback !== null ? <div className="mt-2"><FeedbackLine feedback={rowFeedback} /></div> : null}
            </li>
          );
        })}
        {methodsQuery.isLoading ? (
          <li className="px-3 py-3 text-[12px] text-ink-faint">{t('st.account.loading')}</li>
        ) : null}
      </ul>
      {methodsQuery.isError ? <InlineError error={methodsQuery.error} /> : null}
    </div>
  );
}
