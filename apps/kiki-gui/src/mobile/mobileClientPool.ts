import { useCallback, useEffect, useRef } from 'react';

import { createRemoteSpaceClient, type KikiClient } from '../lib/client';
import { connectionIdOfSpaceKey } from '../lib/remoteConnections';
import { useConnection } from '../state/connection';

interface PooledClientEntry {
  readonly gen: string;
  readonly client: KikiClient;
}

/**
 * Resolves a live `KikiClient` for any `spaceKey` (`local`, `main`, or
 * `remote:<connectionId>`) without triggering a full-page reload or tearing
 * down the mobile shell.
 */
export function useMobileClientResolver(): (spaceKey: string) => KikiClient {
  const { client, localClient, config, connectionId, spaceKey: activeSpaceKey } = useConnection();
  const poolRef = useRef(new Map<string, PooledClientEntry>());

  const controlClient = localClient ?? client;
  const controlBaseUrl = controlClient.baseUrl;
  const controlToken = config.token;

  useEffect(() => {
    const pool = poolRef.current;
    return () => {
      for (const entry of pool.values()) {
        void entry.client.dispose?.().catch?.(() => undefined);
      }
      pool.clear();
    };
  }, []);

  return useCallback((targetSpaceKey: string): KikiClient => {
    if (
      targetSpaceKey === '' ||
      targetSpaceKey === 'local' ||
      targetSpaceKey === activeSpaceKey
    ) {
      return client;
    }
    const targetConnectionId = connectionIdOfSpaceKey(targetSpaceKey);
    if (targetConnectionId === null) {
      return controlClient;
    }
    if (targetConnectionId === connectionId) {
      return client;
    }
    const gen = `${controlBaseUrl}|${controlToken}|${targetConnectionId}`;
    const existing = poolRef.current.get(targetConnectionId);
    if (existing !== undefined && existing.gen === gen) {
      return existing.client;
    }
    if (existing !== undefined) {
      poolRef.current.delete(targetConnectionId);
      void existing.client.dispose?.().catch?.(() => undefined);
    }
    const created = createRemoteSpaceClient({
      endpoint: controlBaseUrl,
      token: controlToken,
      connectionId: targetConnectionId,
    });
    poolRef.current.set(targetConnectionId, { gen, client: created });
    return created;
  }, [activeSpaceKey, client, connectionId, controlBaseUrl, controlClient, controlToken]);
}
