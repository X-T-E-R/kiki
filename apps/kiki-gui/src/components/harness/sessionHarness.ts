import { useMemo } from 'react';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';

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
): SessionHarness | undefined {
  if (profileName === undefined) return undefined;
  const profile = profiles.find((item) => item.name === profileName && item.main);
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

export function useSessionHarness(profileName: string | undefined, profiles: readonly NamedAgentProfile[]): SessionHarness | undefined {
  const catalog = useExecutorCatalog();
  return useMemo(() => sessionHarnessOf(profileName, profiles, catalog), [profileName, profiles, catalog]);
}

/** Only a handshake that said no removes an entry; unknown keeps the native one. */
export function harnessDenies(harness: SessionHarness | undefined, capability: 'fork' | 'image'): boolean {
  return harness?.negotiated?.[capability] === false;
}

/** Codex asks before every MCP tool call; with approvals off it refuses them instead. */
export function codexRefusesKikiTools(harness: SessionHarness | undefined, permissionMode: string | undefined): boolean {
  return harness?.executorId === 'codex-app-server' && harness.kikiSubagents && permissionMode === 'yolo';
}
