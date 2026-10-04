/**
 * One account sign-in flow, however it was started.
 *
 * A flow is per provider, so this lives in react-query under `['oauth',
 * provider]`: the add-connection entry and an existing connection row that
 * needs a new sign-in both read the same entry, and opening one shows the other
 * what is already running rather than issuing a second code.
 *
 * The flow has a shape of its own — pending with a code, one of the terminal
 * states, or gone — and this owns every transition into it: start, cancel,
 * dismiss. What a flow *means* for a connection is `accountState`'s job, and
 * what a person can do about it is the caller's.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { OAuthFlowSnapshot } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import type { OAuthMethodStatus } from '../lib/client';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import type { Feedback } from './controls';

export interface OAuthFlowController {
  /** The provider whose flow this is, or null when none is running. */
  readonly active: string | null;
  /**
   * The running flow's snapshot, or null. Every caller of the same provider
   * reads this one entry, so a sign-in started in the add flow is visible to
   * the connection row it will create and the two never issue two codes.
   */
  readonly snapshot: OAuthFlowSnapshot | null;
  /** True while this flow's card should be on screen. */
  readonly showing: boolean;
  /** Start (or restart) a method's sign-in; resolves once the code is issued. */
  readonly start: (method: OAuthMethodStatus) => Promise<void>;
  /** Stop this device's poll of a running flow. */
  readonly cancel: () => Promise<void>;
  /** Put a finished flow's card away without touching the credential. */
  readonly dismiss: (flowId: string) => void;
  /** True while this client is talking to the server for this method. */
  readonly busy: string | null;
  readonly cancelling: boolean;
  /** Per-method feedback, e.g. a sign-in that completed or could not start. */
  readonly feedback: { provider: string; value: Feedback } | null;
}

export function useOAuthFlow(onChanged?: () => Promise<void> | void): OAuthFlowController {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [feedback, setFeedback] = useState<{ provider: string; value: Feedback } | null>(null);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const previousStatus = useRef<string | null>(null);

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
    await queryClient.invalidateQueries({ queryKey: ['oauth-methods'] });
    await onChanged?.();
  }, [onChanged, queryClient]);

  // A completed flow is reported once and then left alone: the row reads the
  // method list, which is the authority on what is connected.
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

  const start = useCallback(async (method: OAuthMethodStatus) => {
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
  }, [client, locale, queryClient, refresh, t]);

  const cancel = useCallback(async () => {
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
  }, [active, client, locale, queryClient]);

  const dismiss = useCallback((flowId: string) => {
    setDismissed((flows) => (flows.includes(flowId) ? flows : [...flows, flowId]));
  }, []);

  return {
    active,
    snapshot,
    showing: snapshot !== null && snapshot.status !== 'authenticated' && !dismissed.includes(snapshot.flow_id),
    start,
    cancel,
    dismiss,
    busy,
    cancelling,
    feedback,
  };
}
