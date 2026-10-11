/** One agent's switch queue, reconciled from snapshots and ordered live events without polling. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentModelSwitchEvent, QueuedModelSwitch } from '../../lib/client';
import { useConnection } from '../../state/connection';

export interface ModelSwitchesHandle {
  /** Every operation the engine still tracks, oldest queue slot first. */
  readonly switches: readonly QueuedModelSwitch[];
  /** First pending/preparing operation for the existing pending indicator. */
  readonly active: QueuedModelSwitch | undefined;
  /** Future sends follow the last queued switch, otherwise the preparing switch. */
  readonly dependency: QueuedModelSwitch | undefined;
  /** A list read is in flight; errors end loading. */
  readonly loading: boolean;
  /** A failed read keeps known operations but does not claim an empty authoritative list. */
  readonly error: Error | undefined;
  readonly refresh: () => void;
}

export function useModelSwitches(sessionId: string, agentId: string | undefined): ModelSwitchesHandle {
  const { client, scopeId, wsStatus } = useConnection();
  // KikiClient owns one stable Klient; a new React wrapper is not a new connection.
  const identity = client.klient;
  const [operations, setOperations] = useState<ReadonlyMap<string, QueuedModelSwitch>>(new Map());
  const [loading, setLoading] = useState(agentId !== undefined);
  const [error, setError] = useState<Error>();
  const clientRef = useRef(client);
  clientRef.current = client;
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => { refreshRef.current(); }, []);

  useEffect(() => {
    setOperations(new Map());
    setError(undefined);
    setLoading(agentId !== undefined);
    if (agentId === undefined) {
      refreshRef.current = () => {};
      return;
    }
    const generationClient = clientRef.current;
    let disposed = false;
    let readId = 0;
    let reading = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failureCount = 0;
    let failed = false;
    let controller: AbortController | undefined;
    let subscription: ReturnType<typeof generationClient.subscribeAgentModelSwitches>;
    let subscriptionFailed = false;
    let current = new Map<string, QueuedModelSwitch>();
    let sinceRead: AgentModelSwitchEvent[] = [];
    const unknownStatuses = new Map<string, Extract<AgentModelSwitchEvent, { kind: 'status' }>>();
    const publish = () => { setOperations(new Map(current)); };
    const apply = (event: AgentModelSwitchEvent) => {
      if (event.kind === 'queued') {
        current.set(event.entry.input.operationId, { ...event.entry, queueIndex: event.queueIndex });
        unknownStatuses.delete(event.entry.input.operationId);
      } else {
        const existing = current.get(event.operationId);
        if (existing === undefined) {
          unknownStatuses.set(event.operationId, event);
          return;
        }
        // Status events carry no slot; retry must re-read it rather than reuse the failed slot.
        current.set(event.operationId, { ...existing, receipt: event.receipt, queueIndex: -1 });
      }
    };
    const read = () => {
      if (disposed) return;
      if (retry !== undefined) clearTimeout(retry);
      controller?.abort();
      controller = new AbortController();
      const request = ++readId;
      reading = true;
      sinceRead = [];
      setLoading(true);
      setError(undefined);
      void generationClient.listAgentModelSwitches(sessionId, agentId, controller.signal).then((list) => {
        if (disposed || request !== readId) return;
        current = new Map(list.map((entry) => [entry.input.operationId, entry]));
        for (const event of unknownStatuses.values()) {
          const existing = current.get(event.operationId);
          if (existing !== undefined) {
            if (event.receipt.state === 'pending' && existing.receipt.state === 'pending') {
              // This read began after the pending status and supplies its missing slot.
              current.set(event.operationId, { ...existing, receipt: event.receipt });
            } else apply(event);
            unknownStatuses.delete(event.operationId);
          }
        }
        for (const event of sinceRead) apply(event);
        sinceRead = [];
        reading = false;
        failed = false;
        failureCount = 0;
        publish();
        setLoading(false);
      }).catch((error: unknown) => {
        if (disposed || request !== readId) return;
        reading = false;
        sinceRead = [];
        failed = true;
        const preparing = error instanceof Error && error.message === 'model_switch_queue_preparing';
        setLoading(preparing);
        if (!preparing) setError(error instanceof Error ? error : new Error(String(error)));
        if (preparing || ++failureCount < 3) retry = setTimeout(read, preparing ? 100 : 1000 * failureCount);
      });
    };
    const attach = () => {
      subscriptionFailed = false;
      subscription = generationClient.subscribeAgentModelSwitches(sessionId, agentId, (event) => {
        if (disposed) return;
        const unknown = event.kind === 'status' && !current.has(event.operationId);
        if (reading) sinceRead.push(event);
        apply(event);
        publish();
        if (failed || unknown || (event.kind === 'status' && event.receipt.state === 'pending')) read();
      });
      void subscription.ready.then(() => { if (!disposed) read(); }).catch(() => { subscriptionFailed = true; });
    };
    refreshRef.current = () => {
      failureCount = 0;
      if (subscriptionFailed) { subscription.dispose(); attach(); }
      read();
    };
    // Attach first, read now, then reconcile the gap before the subscription handshake.
    attach();
    read();
    return () => {
      disposed = true;
      controller?.abort();
      if (retry !== undefined) clearTimeout(retry);
      refreshRef.current = () => {};
      subscription.dispose();
    };
  }, [scopeId, identity, sessionId, agentId]);

  const previousStatus = useRef(wsStatus);
  useEffect(() => {
    if (wsStatus === 'open' && previousStatus.current !== 'open') refresh();
    previousStatus.current = wsStatus;
  }, [wsStatus, refresh]);

  const switches = useMemo<readonly QueuedModelSwitch[]>(() => [...operations.values()].toSorted((left, right) => {
    const leftIndex = left.queueIndex >= 0 ? left.queueIndex : Number.MAX_SAFE_INTEGER;
    const rightIndex = right.queueIndex >= 0 ? right.queueIndex : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  }), [operations]);
  const active = switches.find((entry) => entry.receipt.state === 'pending' || entry.receipt.state === 'preparing');
  const dependency = switches.findLast((entry) => entry.receipt.state === 'pending')
    ?? switches.find((entry) => entry.receipt.state === 'preparing');
  return { switches, active, dependency, loading, error, refresh };
}
