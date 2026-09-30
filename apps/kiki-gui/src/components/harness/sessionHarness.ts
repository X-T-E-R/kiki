import { useMemo } from 'react';

import type { ExecutorCatalogItem, NamedAgentProfile, Session } from '@kiki/protocol';

import { isExternalExecutor } from '../settings/profileEditor/profileDraft';
import { useExecutorCatalog } from '../settings/profileEditor/engines';

type Negotiated = NonNullable<NonNullable<ExecutorCatalogItem['capabilities']>['negotiated']>;

/**
 * The external engine a session's main agent runs on, with what its last
 * handshake agreed to. `negotiated` is absent until the engine has been
 * started once; every gate reads "unknown" as "leave the native entry", and
 * only an explicit `false` hides one.
 */
export interface SessionHarness {
  readonly executorId: string;
  readonly label: string;
  readonly protocol: string;
  /** The engine's own version from the handshake, else the discovered binary's. */
  readonly version: string | undefined;
  readonly negotiated: Negotiated | undefined;
  /** The profile injects the Kiki MCP bridge (dispatch Kiki subagents). */
  readonly kikiSubagents: boolean;
}

export function sessionHarnessOf(
  profileName: string | undefined,
  profiles: readonly NamedAgentProfile[],
  catalog: readonly ExecutorCatalogItem[],
  session?: Pick<Session, 'executor_id' | 'negotiated' | 'allow_kiki_subagents'>,
): SessionHarness | undefined {
  const profile = profiles.find((item) => item.name === profileName && item.main);
  if (session?.executor_id !== undefined) {
    if (!isExternalExecutor(session.executor_id)) return undefined;
    const item = catalog.find((entry) => entry.id === session.executor_id);
    return {
      executorId: session.executor_id,
      label: item?.label ?? session.executor_id,
      protocol: item?.protocol ?? '',
      version: session.negotiated?.agent_version ?? item?.version,
      negotiated: session.negotiated,
      kikiSubagents: session.allow_kiki_subagents ?? (profile?.allow_kiki_subagents === true),
    };
  }
  if (profileName === undefined) return undefined;
  if (profile === undefined || !isExternalExecutor(profile.executor)) return undefined;
  const item = catalog.find((entry) => entry.id === profile.executor);
  const negotiated = item?.capabilities?.negotiated;
  return {
    executorId: profile.executor!,
    label: item?.label ?? profile.executor!,
    protocol: item?.protocol ?? profile.executor_protocol ?? '',
    version: negotiated?.agent_version ?? item?.version,
    negotiated,
    kikiSubagents: profile.allow_kiki_subagents === true,
  };
}

export function useSessionHarness(profileName: string | undefined, profiles: readonly NamedAgentProfile[], session?: Session): SessionHarness | undefined {
  const catalog = useExecutorCatalog();
  return useMemo(() => sessionHarnessOf(profileName, profiles, catalog, session), [profileName, profiles, catalog, session]);
}

/** Only a handshake that said no removes an entry; unknown keeps the native one. */
export function harnessDenies(harness: SessionHarness | undefined, capability: 'fork' | 'image'): boolean {
  return harness?.negotiated?.[capability] === false;
}
