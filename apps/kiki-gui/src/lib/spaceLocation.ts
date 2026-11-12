import { useQuery } from '@tanstack/react-query';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';
import type { KikiClient } from './client';
import { connectionIdOfSpaceKey, connectionsApi, remoteConnectionKeys, useRemoteConnections } from './remoteConnections';
import { MAIN_SPACE_ID, currentSpace, useSpaces, type SpaceListItem } from './spaces';

export type SpaceConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export interface SpaceLocation {
  readonly spaceName: string;
  readonly computerName?: string;
  readonly state: SpaceConnectionState;
  readonly inRemoteScope: boolean;
  readonly localSpaceName: string;
  readonly localComputerName?: string;
  readonly spaceColor?: string;
  readonly subtitle: string;
}

const UUID_LIKE_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sanitizeHumanLabel(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('remote:') || UUID_LIKE_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export function useServerHandshake(client: KikiClient | null) {
  const canHandshake = client !== null && typeof client.klient?.rest?.connections?.handshake === 'function';
  return useQuery({
    queryKey: [...remoteConnectionKeys.all, 'handshake', client?.baseUrl ?? null],
    queryFn: async () => {
      if (client === null) throw new Error('The connection is not ready.');
      return connectionsApi(client).handshake();
    },
    enabled: canHandshake,
    staleTime: 60_000,
    retry: false,
  });
}

function resolveLocalSpace(
  here: ReturnType<typeof currentSpace>,
  items: readonly SpaceListItem[],
  mainLabel: string,
  unnamedLabel: string,
): { name: string; color?: string } {
  if (here === null || here.homeId === MAIN_SPACE_ID) {
    const matchedMain = items.find((item) => item.id === MAIN_SPACE_ID);
    const customMainName = matchedMain && matchedMain.name !== MAIN_SPACE_ID ? sanitizeHumanLabel(matchedMain.name) : undefined;
    return { name: customMainName ?? mainLabel, color: here?.color ?? matchedMain?.color };
  }
  const matched = items.find((item) => item.id === here.homeId);
  const resolvedName =
    sanitizeHumanLabel(here.name) ??
    (matched && matched.name !== matched.id ? sanitizeHumanLabel(matched.name) : undefined) ??
    unnamedLabel;
  return { name: resolvedName, color: here.color ?? matched?.color };
}

export function useSpaceLocation(options?: { readonly openingSpaceName?: string | null }): SpaceLocation {
  const host = useHost();
  const { t } = useI18n();
  const conn = useOptionalConnection();
  const client = conn?.client ?? null;
  const localClient = conn?.localClient ?? null;
  const spaceKey = conn?.spaceKey;
  const connectionId = conn?.connectionId ?? null;
  const sshLabel = conn?.sshLabel ?? null;
  const wsStatus = conn?.wsStatus;
  const wsBannerSuppressed = conn?.wsBannerSuppressed;

  const resolvedConnectionId =
    (typeof connectionId === 'string' && connectionId !== '' ? connectionId : null) ??
    (typeof spaceKey === 'string' ? connectionIdOfSpaceKey(spaceKey) : null);
  const cleanSshLabel = sanitizeHumanLabel(sshLabel);
  const inRemoteScope = resolvedConnectionId !== null || (typeof sshLabel === 'string' && sshLabel.trim().length > 0);

  const controlClient = host.kind === 'tauri' ? localClient : (localClient ?? (inRemoteScope ? null : client));
  const spaces = useSpaces(host.kind === 'tauri' ? controlClient : null);
  const remoteConnections = useRemoteConnections(controlClient);
  const handshake = useServerHandshake(host.kind === 'tauri' ? null : controlClient);

  const here = currentSpace();
  const items = spaces.data ?? [];
  const localResolved = resolveLocalSpace(here, items, t('st.spaces.main'), t('sidebar.space.unnamed'));
  const localSpaceName = localResolved.name;
  const localComputerName =
    host.kind === 'tauri'
      ? t('sidebar.space.thisComputer')
      : sanitizeHumanLabel(handshake.data?.targetLabel);

  const state: SpaceConnectionState =
    wsStatus === 'open' || wsStatus === undefined || (wsStatus === 'connecting' && wsBannerSuppressed === true)
      ? 'connected'
      : wsStatus === 'connecting'
        ? 'reconnecting'
        : 'disconnected';

  let spaceName = localSpaceName;
  let computerName: string | undefined = localComputerName;
  let spaceColor: string | undefined = localResolved.color;

  if (resolvedConnectionId !== null) {
    const record = (remoteConnections.data ?? []).find((entry) => entry.id === resolvedConnectionId);
    spaceName = sanitizeHumanLabel(record?.label) ?? t('sidebar.space.unnamed');
    computerName = undefined;
    spaceColor = undefined;
  } else if (inRemoteScope) {
    spaceName = cleanSshLabel ?? t('sidebar.space.unnamed');
    computerName = undefined;
    spaceColor = undefined;
  }

  const opening = sanitizeHumanLabel(options?.openingSpaceName);
  let subtitle: string;
  if (opening !== undefined) {
    subtitle = t('sidebar.space.opening', { space: opening });
  } else {
    const stateLabel =
      state === 'reconnecting'
        ? t('sidebar.space.stateReconnecting')
        : state === 'disconnected'
          ? t('sidebar.space.stateDisconnected')
          : inRemoteScope
            ? t('sidebar.space.stateConnected')
            : undefined;
    if (computerName !== undefined && stateLabel !== undefined) {
      subtitle = `${computerName} · ${stateLabel}`;
    } else if (computerName !== undefined) {
      subtitle = computerName;
    } else if (stateLabel !== undefined) {
      subtitle = stateLabel;
    } else {
      subtitle = '';
    }
  }

  return {
    spaceName,
    computerName,
    state,
    inRemoteScope,
    localSpaceName,
    localComputerName,
    spaceColor,
    subtitle,
  };
}
