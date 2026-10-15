/**
 * useOutputLayerClient — hook providing a stable OutputLayerClient singleton
 * bound to the active connection, and syncing server configuration to outputLayerStore.
 */

import { useMemo, useEffect, useRef, useContext } from 'react';
import { QueryClientContext, QueryObserver } from '@tanstack/react-query';
import { useOptionalConnection } from '../../state/connection';
import { OutputLayerClient, type OutputLayerStorage } from '../../lib/outputLayerClient';
import type { OutputLayerFacade } from '@kiki/klient/core/facade/output-layer';
import { outputLayerStore } from './outputLayerStore';
import type { OutputLayerConfiguration } from './types';

let singletonClient: OutputLayerClient | null = null;
let currentFacade: OutputLayerFacade | null = null;
let currentScope: string | null = null;

export function getActiveOutputLayerClient(): OutputLayerClient | null {
  return singletonClient ?? outputLayerStore.getActiveClient();
}

export function setActiveOutputLayerClient(client: OutputLayerClient | null) {
  singletonClient = client;
  outputLayerStore.setActiveClient(client);
}

export function useOutputLayerClient(sessionId?: string): OutputLayerClient | null {
  const connection = useOptionalConnection();
  const clientFacade =
    connection?.klient?.rest?.outputLayer ??
    (connection?.client as unknown as { klient?: { rest?: { outputLayer?: OutputLayerFacade } } })?.klient?.rest?.outputLayer ??
    (connection?.client as unknown as { rest?: { outputLayer?: OutputLayerFacade } })?.rest?.outputLayer;

  const scopeKey = connection?.spaceKey ?? connection?.scopeId ?? 'local';
  const serverId = connection?.meta?.server_id ?? '';
  const contextKey = `${scopeKey}:${serverId}:${sessionId ?? '__all__'}`;

  const outputClient = useMemo(() => {
    if (!clientFacade) {
      if (connection) {
        singletonClient = null;
        outputLayerStore.setActiveClient(null);
      }
      currentFacade = null;
      currentScope = null;
      return null;
    }
    if (clientFacade === currentFacade && scopeKey === currentScope && singletonClient !== null) {
      return singletonClient;
    }
    currentFacade = clientFacade;
    currentScope = scopeKey;
    const storage: OutputLayerStorage | undefined = typeof localStorage !== 'undefined'
      ? {
          getItem: (key: string) => {
            try { return localStorage.getItem(`${key}:${scopeKey}`); } catch { return null; }
          },
          setItem: (key: string, value: string) => {
            try { localStorage.setItem(`${key}:${scopeKey}`, value); } catch {}
          },
        }
      : undefined;
    singletonClient = new OutputLayerClient(clientFacade, storage);
    outputLayerStore.setActiveClient(singletonClient);
    return singletonClient;
  }, [clientFacade, scopeKey, connection]);

  const queryClient = useContext(QueryClientContext);
  const inFlightRef = useRef<Map<string, Promise<OutputLayerConfiguration>>>(new Map());

  // Active query observer: refetches on plugin invalidation without polling or fake setQueryData
  useEffect(() => {
    if (!outputClient) return;

    if (queryClient) {
      const queryKey = ['plugin', 'output-layer-configuration', scopeKey, serverId, sessionId ?? '__all__'];
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: () => outputClient.configuration(sessionId ? { sessionId } : undefined),
        staleTime: 15_000,
      });

      const current = observer.getCurrentResult();
      if (current.status === 'success' && current.data) {
        outputLayerStore.setConfiguration(current.data, contextKey);
      } else if (current.status === 'error') {
        outputLayerStore.setConfiguration(
          { enabled: false, presets: [], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } },
          contextKey,
        );
      }

      const unsubscribe = observer.subscribe((result) => {
        if (result.status === 'success' && result.data) {
          outputLayerStore.setConfiguration(result.data, contextKey);
        } else if (result.status === 'error') {
          outputLayerStore.setConfiguration(
            { enabled: false, presets: [], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } },
            contextKey,
          );
        }
      });

      return () => {
        unsubscribe();
      };
    }

    // Fallback when QueryClientProvider is absent (e.g. lightweight isolated unit test)
    if (!inFlightRef.current.has(contextKey)) {
      const promise = outputLayerStore.fetchConfiguration(outputClient, {
        sessionId: sessionId ? sessionId : undefined,
        contextKey,
      }).finally(() => {
        inFlightRef.current.delete(contextKey);
      });
      inFlightRef.current.set(contextKey, promise);
    }
  }, [outputClient, queryClient, scopeKey, serverId, sessionId, contextKey]);

  return outputClient;
}
