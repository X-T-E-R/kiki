import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { SessionInterruptedWork } from '@kiki/protocol';
import {
  resolveRecoverableInterruption,
  type ToolBlock,
  type TurnTailInfo,
  type UserBlock,
} from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';

export interface ModelSwitchNoticeActions {
  readonly edit?: (operationId: string) => void;
  readonly cancel?: (operationId: string) => void;
  readonly retry?: (operationId: string) => void;
  readonly retryAsFresh?: (operationId: string) => void;
  readonly keepOriginal?: (operationId: string) => void;
  readonly pendingOperationId?: string;
}

export const ModelSwitchActionsContext = createContext<ModelSwitchNoticeActions | undefined>(undefined);

export function canFaithfullyRetryUserBlock(
  block: UserBlock | undefined,
  allowRegenerate = true,
): boolean {
  if (block === undefined) return false;
  if (allowRegenerate && block.userMessageId !== undefined) return true;
  if ((block.media?.length ?? 0) > 0) return false;
  if (block.contentPending === true) return false;
  if (Array.isArray(block.queuedContent) && block.queuedContent.some((part) => part.type !== 'text')) {
    return false;
  }
  return block.text.trim() !== '';
}

export function hasTurnTailSurfaceContent(input: {
  readonly agentId: string;
  readonly tail?: TurnTailInfo;
  readonly interruptedWork?: SessionInterruptedWork;
  readonly promptQueueHold?: { readonly reason: 'recovery'; readonly count: number };
  readonly busy?: boolean;
  readonly footnoteAttachedInline?: boolean;
}): boolean {
  if (input.busy === true) return false;
  const recovery = resolveRecoverableInterruption({
    agentId: input.agentId,
    turnTail: input.tail,
    interruptedWork: input.interruptedWork,
    promptQueueHold: input.promptQueueHold,
  });
  if (recovery.recoverable) return true;
  if (input.tail === undefined) return false;
  if (input.tail.state === 'failed' || input.tail.state === 'cancelled') return true;
  return input.footnoteAttachedInline !== true;
}

type Translate = ReturnType<typeof useI18n>['t'];

export function activityOutcomeLabels(t: Translate) {
  return {
    running: t('transcript.runningAria'),
    failed: t('transcript.failedAria'),
    stopped: t('transcript.stoppedAria'),
    done: t('transcript.doneAria'),
  };
}

export const DURATION_WORTH_SHOWING_MS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseOutputJson(output: unknown): unknown {
  if (typeof output === 'object' && output !== null) return output;
  if (typeof output !== 'string') return undefined;
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function extractPendingThreadMessageId(block: ToolBlock): string | undefined {
  if (block.name !== 'ThreadSend') return undefined;
  const args = asRecord(block.args);
  if (asString(args?.['room']) !== undefined) return undefined;
  const result = asRecord(parseOutputJson(block.output));
  if (asString(result?.['delivery']) !== 'pending') return undefined;
  return asString(result?.['messageId']) ?? asString(result?.['message_id']);
}

export interface TranscriptDeliveryValue {
  readonly deliveredAgentMessages?: Readonly<Record<string, string>>;
  readonly threadDeliveryById: Readonly<Record<string, 'delivered' | 'undeliverable'>>;
}

const EMPTY_THREAD_DELIVERY: Readonly<Record<string, 'delivered' | 'undeliverable'>> = {};
export const TranscriptDeliveryContext = createContext<TranscriptDeliveryValue>({
  threadDeliveryById: EMPTY_THREAD_DELIVERY,
});

const THREAD_RECONCILE_PAGE_LIMIT = 5;

export function TranscriptDeliveryProvider({
  sessionId,
  deliveredAgentMessages,
  pendingThreadMessageIds,
  children,
}: {
  readonly sessionId?: string;
  readonly deliveredAgentMessages?: Readonly<Record<string, string>>;
  readonly pendingThreadMessageIds?: readonly string[];
  readonly children: ReactNode;
}) {
  const connection = useOptionalConnection();
  const api = connection?.client;
  const wsStatus = connection?.wsStatus;
  const [threadDeliveryById, setThreadDeliveryById] = useState<Readonly<Record<string, 'delivered' | 'undeliverable'>>>(EMPTY_THREAD_DELIVERY);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const prevWsStatusRef = useRef<string | undefined>(wsStatus);
  const reconciledRef = useRef<{ sessionId: string | undefined; epoch: number; ids: Set<string> }>({
    sessionId,
    epoch: 0,
    ids: new Set(),
  });

  useEffect(() => {
    setThreadDeliveryById(EMPTY_THREAD_DELIVERY);
    reconciledRef.current = { sessionId, epoch: reconnectEpoch, ids: new Set() };
  }, [sessionId]);

  useEffect(() => {
    const previous = prevWsStatusRef.current;
    prevWsStatusRef.current = wsStatus;
    if (wsStatus === 'open' && previous !== undefined && previous !== 'open') {
      setReconnectEpoch((epoch) => epoch + 1);
    }
  }, [wsStatus]);

  const pendingKey = useMemo(
    () => (pendingThreadMessageIds === undefined || pendingThreadMessageIds.length === 0 ? '' : pendingThreadMessageIds.join('\u0000')),
    [pendingThreadMessageIds],
  );

  useEffect(() => {
    if (pendingKey === '') return;
    const events = api?.klient?.events;
    if (events === undefined) return;
    let sub: { dispose(): void; ready?: Promise<void> } | undefined;
    try {
      sub = events.on('thread.messageDelivery', (event) => {
        if (sessionId !== undefined && event.sourceSessionId !== undefined && event.sourceSessionId !== sessionId && event.targetSessionId !== sessionId) {
          return;
        }
        setThreadDeliveryById((prev) =>
          prev[event.messageId] === event.delivery ? prev : { ...prev, [event.messageId]: event.delivery },
        );
      });
      void sub.ready?.catch(() => {});
    } catch {
      return;
    }
    return () => { sub?.dispose(); };
  }, [api, sessionId, pendingKey]);

  useEffect(() => {
    if (sessionId === undefined || pendingKey === '') return;
    const threads = api?.klient?.global?.threads;
    if (threads === undefined) return;
    const ids = pendingKey.split('\u0000');
    const tracker =
      reconciledRef.current.sessionId === sessionId && reconciledRef.current.epoch === reconnectEpoch
        ? reconciledRef.current
        : (reconciledRef.current = { sessionId, epoch: reconnectEpoch, ids: new Set() });
    const unseen = ids.filter((id) => !tracker.ids.has(id) && threadDeliveryById[id] === undefined);
    if (unseen.length === 0) return;
    for (const id of unseen) tracker.ids.add(id);
    const remaining = new Set(unseen);
    let cancelled = false;
    void (async () => {
      let cursor: string | undefined;
      for (let page = 0; page < THREAD_RECONCILE_PAGE_LIMIT && remaining.size > 0 && !cancelled; page += 1) {
        const res = await threads.messages({ sessionId, cursor, limit: 100 });
        if (cancelled) return;
        const updates: Record<string, 'delivered' | 'undeliverable'> = {};
        for (const msg of res.items) {
          if (!remaining.has(msg.messageId)) continue;
          remaining.delete(msg.messageId);
          if (msg.delivery === 'delivered' || msg.delivery === 'undeliverable') {
            updates[msg.messageId] = msg.delivery;
          }
        }
        if (Object.keys(updates).length > 0) {
          setThreadDeliveryById((prev) => ({ ...prev, ...updates }));
        }
        if (res.nextCursor === undefined) break;
        cursor = res.nextCursor;
      }
    })().catch(() => {
      if (!cancelled) {
        for (const id of unseen) tracker.ids.delete(id);
      }
    });
    return () => { cancelled = true; };
  }, [api, sessionId, pendingKey, reconnectEpoch, threadDeliveryById]);

  const value = useMemo<TranscriptDeliveryValue>(
    () => ({ deliveredAgentMessages, threadDeliveryById }),
    [deliveredAgentMessages, threadDeliveryById],
  );
  return <TranscriptDeliveryContext.Provider value={value}>{children}</TranscriptDeliveryContext.Provider>;
}
