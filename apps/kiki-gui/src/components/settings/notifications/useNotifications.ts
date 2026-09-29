import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationSettings } from '@kiki/klient';

import { useConnection } from '../../../state/connection';

export const NOTIFY_SETTINGS_KEY = ['notifications', 'settings'] as const;
export const NOTIFY_PROVIDERS_KEY = ['notifications', 'providers'] as const;
export const NOTIFY_DELIVERIES_KEY = ['notifications', 'deliveries'] as const;

/**
 * Settings, the provider registry and the delivery log, shared by every card
 * on the page. The log is one newest-first list (the server keeps the last
 * 100); rows group it by channel.
 */
export function useNotificationData() {
  const { client } = useConnection();
  const settings = useQuery({ queryKey: NOTIFY_SETTINGS_KEY, queryFn: () => client.notifications.getSettings(), staleTime: 15_000 });
  const providers = useQuery({ queryKey: NOTIFY_PROVIDERS_KEY, queryFn: () => client.notifications.listProviders(), staleTime: 60_000 });
  const deliveries = useQuery({ queryKey: NOTIFY_DELIVERIES_KEY, queryFn: () => client.notifications.listDeliveries(), staleTime: 15_000 });
  return { settings, providers, deliveries };
}

/**
 * Write access: every settings write echoes the whole settings object, which
 * lands in the cache as the truth; credential writes and checks echo less, so
 * they refetch instead.
 */
export function useNotificationWrites() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const apply = (next: NotificationSettings) => { queryClient.setQueryData(NOTIFY_SETTINGS_KEY, next); };
  const refresh = () => queryClient.invalidateQueries({ queryKey: NOTIFY_SETTINGS_KEY });
  const refreshDeliveries = () => queryClient.invalidateQueries({ queryKey: NOTIFY_DELIVERIES_KEY });
  const reveal = async (slotId: string) => (await client.revealSecret({ kind: 'notification_credential', slot_id: slotId })).value;
  return { api: client.notifications, apply, refresh, refreshDeliveries, reveal };
}
