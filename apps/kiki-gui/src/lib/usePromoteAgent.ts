import { useCallback, useContext, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { QueryClientContext } from '@tanstack/react-query';

import { promoteAgentToThread, sessionActionErrorText } from '@kiki/session-core/commands';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';

import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';
import { pushToast } from './toasts';

const promotionFlights = new WeakMap<object, Set<string>>();
const promotionListeners = new WeakMap<object, Map<string, Set<() => void>>>();

function notifyPromotion(client: object, key: string): void {
  for (const listener of promotionListeners.get(client)?.get(key) ?? []) listener();
}

function subscribePromotion(client: object, key: string, listener: () => void): () => void {
  let byTarget = promotionListeners.get(client);
  if (byTarget === undefined) {
    byTarget = new Map();
    promotionListeners.set(client, byTarget);
  }
  let listeners = byTarget.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    byTarget.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      byTarget.delete(key);
      if (byTarget.size === 0) promotionListeners.delete(client);
    }
  };
}

function beginPromotion(client: object, key: string): boolean {
  let flights = promotionFlights.get(client);
  if (flights?.has(key) === true) return false;
  if (flights === undefined) {
    flights = new Set();
    promotionFlights.set(client, flights);
  }
  flights.add(key);
  notifyPromotion(client, key);
  return true;
}

function endPromotion(client: object, key: string): void {
  const flights = promotionFlights.get(client);
  if (flights === undefined) return;
  flights.delete(key);
  if (flights.size === 0) promotionFlights.delete(client);
  notifyPromotion(client, key);
}

export interface PromoteAgentAction {
  readonly pending: boolean;
  readonly promote: () => void;
}

/**
 * "Open as thread" for one subagent: copies its conversation into a new
 * top-level session and navigates there. All mounted actions for the same
 * client and agent share their pending state and a single in-flight request.
 */
export function usePromoteAgent(sessionId: string | undefined, agentId: string | undefined): PromoteAgentAction | undefined {
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const client = connection?.client;
  const targetKey = sessionId === undefined || agentId === undefined ? undefined : JSON.stringify([sessionId, agentId]);
  const subscribe = useCallback((listener: () => void) => {
    if (client === undefined || targetKey === undefined) return () => undefined;
    return subscribePromotion(client, targetKey, listener);
  }, [client, targetKey]);
  const getSnapshot = useCallback(() => {
    if (client === undefined || targetKey === undefined) return false;
    return promotionFlights.get(client)?.has(targetKey) ?? false;
  }, [client, targetKey]);
  const pending = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const promote = useCallback(() => {
    if (client === undefined || sessionId === undefined || agentId === undefined || targetKey === undefined) return;
    if (!beginPromotion(client, targetKey)) return;
    void promoteAgentToThread({
      client,
      host: {},
      refreshSessions: () => { void queryClient?.invalidateQueries({ queryKey: ['sessions'] }); },
      navigate: (path) => { void navigate(path); },
    }, sessionId, agentId)
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('agent.promoteFailed', { detail: sessionActionErrorText(locale, error) }) });
      })
      .finally(() => {
        endPromotion(client, targetKey);
      });
  }, [agentId, client, locale, navigate, queryClient, sessionId, t, targetKey]);
  if (
    client === undefined ||
    client.sessions.promoteAgent === undefined ||
    sessionId === undefined ||
    agentId === undefined ||
    agentId === MAIN_AGENT_ID
  ) return undefined;
  return { pending, promote };
}
