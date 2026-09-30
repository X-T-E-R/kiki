/**
 * Room names for the comms surfaces: a room delivery carries only its room id,
 * so the name comes from the room list (cached with the sidebar's). A room
 * that was deleted reads as such and never links.
 */

import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { createBotRoomApi, ROOMS_QUERY_KEY } from '../../lib/botRooms';
import { useOptionalConnection } from '../../state/connection';

export function useRoomNames(enabled: boolean): (roomId: string) => { readonly name: string; readonly exists: boolean } {
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const query = useQuery({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: () => createBotRoomApi(client!).listRooms(),
    enabled: enabled && client?.klient?.rest !== undefined,
    staleTime: 15_000,
    retry: false,
  });
  const names = new Map((query.data ?? []).map((room) => [room.id, room.name] as const));
  return (roomId) => {
    const name = names.get(roomId);
    if (name !== undefined) return { name, exists: true };
    return { name: query.isSuccess ? t('comms.deletedRoom') : roomId, exists: !query.isSuccess };
  };
}

export function roomHref(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`;
}
