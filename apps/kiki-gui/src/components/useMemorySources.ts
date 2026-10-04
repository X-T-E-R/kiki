import { useQuery } from '@tanstack/react-query';

import type { PersonaSummary, Workspace } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { BOTS_QUERY_KEY, useBotRoomApi } from '../lib/botRooms';
import type { MemorySettings, MemoryTarget } from '../lib/client';
import { useConnection } from '../state/connection';
import { memoryTargetKey, personaMemoryTarget } from './persona/PersonaMemoryScope';
import { personaQueryKey } from './persona/usePersonas';

export interface MemorySource {
  readonly target: MemoryTarget;
  readonly label: string;
}

/** Persona memory includes long-term and only the selected workspace slice; shared sources may use the Bot's home. */
export function memorySourceTargets(
  workspaceId: string | undefined,
  personaId: string | undefined,
  botWorkspaceId: string | undefined,
  settings: MemorySettings | undefined,
  personaShared: readonly ('global' | 'workspace')[] = ['global', 'workspace'],
): MemoryTarget[] {
  const own: MemoryTarget[] = personaId === undefined
    ? [workspaceId === undefined ? { scope: 'global' } : { scope: 'workspace', workspaceId }]
    : [personaMemoryTarget(personaId, undefined)];
  if (personaId !== undefined) {
    if (workspaceId !== undefined) own.push(personaMemoryTarget(personaId, workspaceId));
  }
  const effectiveWorkspace = workspaceId ?? botWorkspaceId;
  const followsGlobal = settings?.enabled === true
    && effectiveWorkspace !== undefined
    && settings.workspaces[effectiveWorkspace] === undefined;
  const shared: MemoryTarget[] = [];
  if (personaId === undefined ? followsGlobal : personaShared.includes('global')) shared.push({ scope: 'global' });
  if (personaId !== undefined && personaShared.includes('workspace') && effectiveWorkspace !== undefined) {
    shared.push({ scope: 'workspace', workspaceId: effectiveWorkspace });
  }
  const targets = [...shared, ...own];
  return targets.filter((target, index) => targets.findIndex((other) => memoryTargetKey(other) === memoryTargetKey(target)) === index);
}

export function useMemorySources({
  workspaceId,
  workspaces,
  workspacesLoading = false,
  workspacesError = null,
  persona,
  settings,
}: {
  readonly workspaceId: string | undefined;
  readonly workspaces: readonly Workspace[];
  readonly workspacesLoading?: boolean;
  readonly workspacesError?: Error | null;
  readonly persona: PersonaSummary | undefined;
  readonly settings: MemorySettings | undefined;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const api = useBotRoomApi();
  const definition = useQuery({
    queryKey: personaQueryKey(persona?.id ?? ''),
    queryFn: () => client.getPersona(persona!.id),
    enabled: persona !== undefined,
    staleTime: 15_000,
  });
  const bots = useQuery({
    queryKey: BOTS_QUERY_KEY,
    queryFn: () => api.listBots(),
    enabled: persona !== undefined,
    staleTime: 15_000,
  });
  const bot = bots.data?.find((item) => item.personaId === persona?.id);
  const home = useQuery({
    queryKey: ['memory-bot-home', bot?.homeSessionId],
    queryFn: () => client.getSession(bot!.homeSessionId!),
    enabled: bot?.homeSessionId !== undefined,
    staleTime: 15_000,
  });
  const botWorkspaceId = home.data?.workspace_id;
  const isKnownWorkspace = workspaceId !== undefined && (workspaces.some((item) => item.id === workspaceId) || (persona !== undefined && workspaceId === botWorkspaceId));
  const needsWorkspaceDirectory = workspaceId !== undefined && !isKnownWorkspace;
  const personaLoading = persona !== undefined && (definition.isPending || bots.isPending || (bot?.homeSessionId !== undefined && home.isPending));
  const rangeLoading = needsWorkspaceDirectory && (workspacesLoading || personaLoading);
  const rangeError = needsWorkspaceDirectory ? workspacesError : null;
  const validatedWorkspaceId = isKnownWorkspace ? workspaceId : undefined;
  const workspaceName = (id: string | undefined) => workspaces.find((item) => item.id === id)?.name
    ?? (id === botWorkspaceId ? t('memory.source.botHome') : id ?? '');
  const sourceLabel = (target: MemoryTarget) => {
    if (target.scope === 'global') return t('memory.scope.global');
    if (target.scope === 'workspace') return workspaceName(target.workspaceId);
    const name = bot === undefined ? persona?.name ?? target.personaId ?? '' : t('memory.source.bot', { name: bot.name });
    return target.scope === 'persona' ? name : `${name} · ${workspaceName(target.workspaceId)}`;
  };
  return {
    personaSnapshot: definition.data,
    botWorkspaceId,
    effectiveWorkspaceId: validatedWorkspaceId,
    sources: rangeLoading || rangeError !== null ? [] : memorySourceTargets(validatedWorkspaceId, persona?.id, botWorkspaceId, settings, definition.data?.definition.memory?.shared)
      .map((target) => ({ target, label: sourceLabel(target) })),
    rangeLoading,
    rangeError,
    loading: rangeLoading || personaLoading,
    error: rangeError ?? (persona === undefined ? null : definition.error ?? bots.error ?? home.error),
    retry: () => { if (persona !== undefined) { void definition.refetch(); void bots.refetch(); if (bot?.homeSessionId !== undefined) void home.refetch(); } },
  };
}
