import { memo, useCallback, useContext, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { Session } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { sessionNotificationMode, type SessionNotificationMode } from '@kiki/session-core/sessions';

import { useI18n } from '../../i18n';
import { updateSessionNotificationMode } from '../../lib/sessionNotificationMutation';
import { pushToast } from '../../lib/toasts';
import { useOptionalConnection } from '../../state/connection';
import { INSPECTOR_HEAD } from '../agent-panel/InspectorSection';
import { FOCUS_RING } from './shell';

const MODES: readonly SessionNotificationMode[] = ['all', 'urgent', 'off'];

const MODE_LABELS: Readonly<Record<SessionNotificationMode, {
  readonly label: 'rail.notifications.mode.all' | 'rail.notifications.mode.urgent' | 'rail.notifications.mode.off';
  readonly hint: 'rail.notifications.mode.allHint' | 'rail.notifications.mode.urgentHint' | 'rail.notifications.mode.offHint';
}>> = {
  all: {
    label: 'rail.notifications.mode.all',
    hint: 'rail.notifications.mode.allHint',
  },
  urgent: {
    label: 'rail.notifications.mode.urgent',
    hint: 'rail.notifications.mode.urgentHint',
  },
  off: {
    label: 'rail.notifications.mode.off',
    hint: 'rail.notifications.mode.offHint',
  },
};

export interface SessionNotificationControlProps {
  readonly session: Session;
}

export const SessionNotificationControl = memo(function SessionNotificationControl({
  session,
}: SessionNotificationControlProps) {
  const { t, locale } = useI18n();
  const labelId = useId();
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const subscribeSessionCache = useCallback(
    (onStoreChange: () => void) => {
      if (queryClient === undefined) return () => {};
      return queryClient.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (Array.isArray(key) && key[0] === 'session' && key[1] === session.id) {
          onStoreChange();
        }
      });
    },
    [queryClient, session.id],
  );
  const cachedSession = useSyncExternalStore(
    subscribeSessionCache,
    () => queryClient?.getQueryData<Session>(['session', session.id]),
    () => undefined,
  );
  const effectiveSession =
    cachedSession !== undefined && cachedSession.id === session.id && cachedSession.updated_at >= session.updated_at
      ? cachedSession
      : session;
  const serverMode = sessionNotificationMode(effectiveSession);
  const [optimistic, setOptimistic] = useState<{ readonly sessionId: string; readonly mode: SessionNotificationMode } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOptimistic((current) => {
      if (current === null) return null;
      if (current.sessionId !== session.id || current.mode === serverMode) return null;
      return current;
    });
  }, [session.id, serverMode]);

  const activeMode = optimistic !== null && optimistic.sessionId === session.id ? optimistic.mode : serverMode;
  const canUpdate = connection !== null && typeof connection.client?.updateSessionProfile === 'function';

  const selectMode = (nextMode: SessionNotificationMode) => {
    if (busy || nextMode === activeMode || !canUpdate) return;
    setOptimistic({ sessionId: session.id, mode: nextMode });
    setBusy(true);
    void updateSessionNotificationMode({
      client: connection.client,
      queryClient,
      session: effectiveSession,
      mode: nextMode,
    })
      .catch((error: unknown) => {
        setOptimistic(null);
        pushToast({ tone: 'error', text: errorText(locale, error) });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div
      data-rail-session-notifications=""
      data-notification-mode={activeMode}
      className="flex min-h-8 items-center justify-between gap-2 py-0.5"
    >
      <span id={labelId} className={INSPECTOR_HEAD}>
        {t('rail.notifications.title')}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="inline-flex shrink-0 items-center rounded-md bg-ink/[0.04] p-0.5"
      >
        {MODES.map((mode) => {
          const checked = activeMode === mode;
          const copy = MODE_LABELS[mode];
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={checked}
              data-notification-option={mode}
              title={t(copy.hint)}
              disabled={busy || !canUpdate}
              onClick={() => { selectMode(mode); }}
              className={`h-6 cursor-pointer rounded-[5px] px-2 text-[11.5px] leading-none font-normal transition-colors disabled:cursor-default disabled:opacity-60 ${FOCUS_RING} ${
                checked
                  ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-ink-faint hover:text-ink'
              }`}
            >
              {t(copy.label)}
            </button>
          );
        })}
      </div>
    </div>
  );
});
