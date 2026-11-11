import { useCallback, useContext, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QueryClientContext } from '@tanstack/react-query';

import { promoteAgentToThread, sessionActionErrorText } from '@kiki/session-core/commands';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';

import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';
import { pushToast } from './toasts';

export interface PromoteAgentAction {
  readonly pending: boolean;
  readonly promote: () => void;
}

/**
 * "Open as thread" for one subagent: copies its conversation into a new
 * top-level session and navigates there. Undefined for the main agent and on
 * transports without the promote route, so callers render no entry at all.
 */
export function usePromoteAgent(sessionId: string | undefined, agentId: string | undefined): PromoteAgentAction | undefined {
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const [pending, setPending] = useState(false);
  const inflight = useRef(false);
  const client = connection?.client;
  const promote = useCallback(() => {
    if (client === undefined || sessionId === undefined || agentId === undefined || inflight.current) return;
    inflight.current = true;
    setPending(true);
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
        inflight.current = false;
        setPending(false);
      });
  }, [agentId, client, locale, navigate, queryClient, sessionId, t]);
  if (
    client === undefined ||
    client.sessions.promoteAgent === undefined ||
    sessionId === undefined ||
    agentId === undefined ||
    agentId === MAIN_AGENT_ID
  ) return undefined;
  return { pending, promote };
}
