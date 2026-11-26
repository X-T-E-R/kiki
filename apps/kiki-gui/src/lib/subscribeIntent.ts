import { useCallback, useEffect, useRef, useState } from 'react';
import type { Location, NavigateFunction } from 'react-router-dom';

import type { HostAdapter, HostSubscribeIntent } from '../host';

export interface PendingSubscribeIntent {
  readonly id: string;
  readonly url: string;
  readonly name?: string;
  readonly mode?: 'auto' | 'manual' | 'once';
  readonly origin: 'native' | 'query';
}

export interface ParsedSubscribeQuery {
  readonly intent: PendingSubscribeIntent;
  readonly scrubbedTarget: string;
}

let nextLocalIntentSeq = 0;

function parseMode(raw: string | null): 'auto' | 'manual' | 'once' | undefined {
  if (raw === 'auto' || raw === 'manual' || raw === 'once') return raw;
  return undefined;
}

function sanitizeName(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Extracts a legacy `?subscribe=<url>[&name=...][&mode=auto|manual|once]`
 * intent from the current browser location and returns the scrubbed URL so
 * bearer subscription links never stay in browser history.
 */
export function extractSubscribeQuery(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): ParsedSubscribeQuery | null {
  if (!location.search) return null;
  const params = new URLSearchParams(location.search);
  const rawUrl = params.get('subscribe')?.trim();
  if (!rawUrl) return null;

  const name = sanitizeName(params.get('name'));
  const mode = parseMode(params.get('mode')?.trim().toLowerCase() ?? null);
  params.delete('subscribe');
  params.delete('name');
  params.delete('mode');

  const remaining = params.toString();
  const scrubbedTarget = `${location.pathname}${remaining ? `?${remaining}` : ''}${location.hash}`;
  return {
    intent: {
      id: `query-${++nextLocalIntentSeq}`,
      url: rawUrl,
      ...(name !== undefined ? { name } : {}),
      ...(mode !== undefined ? { mode } : {}),
      origin: 'query',
    },
    scrubbedTarget,
  };
}

/**
 * App-level FIFO subscribe-intent pump.
 *
 * - Attaches the native wake listener (`host.onSubscribeIntent`) first and
 *   peeks the authoritative Rust FIFO without auto-acking.
 * - Scrubs legacy `?subscribe=` query parameters immediately from history.
 * - Never opens two simultaneous modals or overwrites an active draft.
 * - Only ACKs a native intent when the user explicitly confirms or cancels;
 *   drains the next queued FIFO item right after ACK resolves.
 */
export function useSubscribeIntentQueue(
  host: HostAdapter,
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  navigate: NavigateFunction,
) {
  const [activeIntent, setActiveIntent] = useState<PendingSubscribeIntent | null>(null);
  const [localQueue, setLocalQueue] = useState<readonly PendingSubscribeIntent[]>([]);
  const activeRef = useRef<PendingSubscribeIntent | null>(null);
  const pendingNativeRef = useRef<HostSubscribeIntent | null>(null);
  const localQueueRef = useRef<readonly PendingSubscribeIntent[]>([]);
  const mountedRef = useRef(true);
  const settlingRef = useRef(false);
  const consumedQueryKeyRef = useRef<string | null>(null);

  activeRef.current = activeIntent;
  localQueueRef.current = localQueue;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const promoteNext = useCallback(() => {
    if (!mountedRef.current || activeRef.current !== null) return;
    const nativeHead = pendingNativeRef.current;
    if (nativeHead !== null) {
      pendingNativeRef.current = null;
      const next: PendingSubscribeIntent = {
        id: nativeHead.id,
        url: nativeHead.url,
        ...(nativeHead.name !== undefined ? { name: nativeHead.name } : {}),
        ...(nativeHead.mode !== undefined ? { mode: nativeHead.mode } : {}),
        origin: 'native',
      };
      activeRef.current = next;
      setActiveIntent(next);
      return;
    }
    const [head, ...rest] = localQueueRef.current;
    if (head !== undefined) {
      localQueueRef.current = rest;
      setLocalQueue(rest);
      activeRef.current = head;
      setActiveIntent(head);
    }
  }, []);

  const offerNativeIntent = useCallback((intent: HostSubscribeIntent) => {
    if (!mountedRef.current) return;
    if (activeRef.current?.origin === 'native' && activeRef.current.id === intent.id) return;
    if (pendingNativeRef.current?.id === intent.id) return;
    pendingNativeRef.current = intent;
    if (activeRef.current === null) promoteNext();
  }, [promoteNext]);

  // Scrub `?subscribe=` immediately and enqueue into the local FIFO.
  useEffect(() => {
    const extracted = extractSubscribeQuery(location);
    if (extracted === null) {
      consumedQueryKeyRef.current = null;
      return;
    }
    const queryKey = `${location.pathname}${location.search}`;
    if (consumedQueryKeyRef.current === queryKey) return;
    consumedQueryKeyRef.current = queryKey;
    void navigate(extracted.scrubbedTarget, { replace: true });
    if (activeRef.current === null) {
      activeRef.current = extracted.intent;
      setActiveIntent(extracted.intent);
    } else {
      const nextQueue = [...localQueueRef.current, extracted.intent];
      localQueueRef.current = nextQueue;
      setLocalQueue(nextQueue);
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  // Authoritative native FIFO pump (prefers `onSubscribeIntent`; falls back to
  // legacy `onSubscribeUrl` only on older shells lacking the structured bridge).
  useEffect(() => {
    if (host.onSubscribeIntent !== undefined) {
      const unsubscribe = host.onSubscribeIntent((intent) => {
        offerNativeIntent(intent);
      });
      void host.peekSubscribeIntent?.().then((head) => {
        if (head !== null) offerNativeIntent(head);
      }).catch(() => undefined);
      return unsubscribe;
    }
    if (host.onSubscribeUrl !== undefined) {
      return host.onSubscribeUrl((url) => {
        const trimmed = url.trim();
        if (!trimmed) return;
        const intent: PendingSubscribeIntent = {
          id: `legacy-url-${++nextLocalIntentSeq}`,
          url: trimmed,
          origin: 'query',
        };
        if (activeRef.current === null) {
          activeRef.current = intent;
          setActiveIntent(intent);
        } else {
          const nextQueue = [...localQueueRef.current, intent];
          localQueueRef.current = nextQueue;
          setLocalQueue(nextQueue);
        }
      });
    }
    return undefined;
  }, [host, offerNativeIntent]);

  /**
   * Call only after the user explicitly confirms or cancels the active intent.
   * ACKs the native FIFO head and drains the next queued intent if any.
   */
  const settleActiveIntent = useCallback(async () => {
    const current = activeRef.current;
    if (current === null || settlingRef.current) return;
    settlingRef.current = true;
    activeRef.current = null;
    setActiveIntent(null);
    try {
      if (current.origin === 'native' && host.ackSubscribeIntent !== undefined) {
        await host.ackSubscribeIntent(current.id).catch(() => false);
        const nextHead = await host.peekSubscribeIntent?.().catch(() => null) ?? null;
        if (nextHead !== null && mountedRef.current) {
          pendingNativeRef.current = nextHead;
        }
      }
    } finally {
      settlingRef.current = false;
      promoteNext();
    }
  }, [host, promoteNext]);

  return {
    activeIntent,
    queuedCount: localQueue.length + (pendingNativeRef.current !== null ? 1 : 0),
    settleActiveIntent,
  };
}
