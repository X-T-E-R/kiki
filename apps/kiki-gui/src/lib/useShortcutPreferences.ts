import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useConnection } from '../state/connection';
import { applyShortcutPreferences, resetShortcutRuntime, shortcutState } from './shortcuts';

export const SHORTCUTS_QUERY_KEY = ['gui-shortcuts'] as const;

/**
 * Load the connected server's saved shortcut table into the runtime store.
 * A server without the route (or a failed read) leaves the shipped defaults
 * active; the Settings card reports the failure where it can be retried.
 */
export function useShortcutPreferencesSync(): void {
  const { client } = useConnection();
  const platform = shortcutState().platform;
  const query = useQuery({
    queryKey: [...SHORTCUTS_QUERY_KEY, platform],
    queryFn: () => client.readShortcuts(platform),
    staleTime: 60_000,
    retry: false,
  });
  const preferences = query.data?.preferences;
  useEffect(() => {
    if (preferences !== undefined) applyShortcutPreferences(preferences);
  }, [preferences]);
  // A different server brings its own table; never carry the old one over.
  useEffect(() => () => { resetShortcutRuntime(platform); }, [client, platform]);
}
