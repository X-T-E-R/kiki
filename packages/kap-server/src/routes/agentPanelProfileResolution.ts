import type {
  AgentProfile,
  AgentProfileCatalogSnapshot,
  ISessionAgentProfileCatalog,
  ProfileData,
} from '@kiki/agent-core-v2';

export type PanelProfileDefinition = AgentProfile | NonNullable<ProfileData['boundProfile']>;

export interface PanelProfileResolution {
  readonly profile?: PanelProfileDefinition;
  readonly sourceId?: string;
}

export function resolveBoundPanelProfile(
  catalog: ISessionAgentProfileCatalog,
  profileName: string | undefined,
  definitionId: string | undefined,
  options: {
    readonly frozen?: AgentProfileCatalogSnapshot;
    readonly bound?: NonNullable<ProfileData['boundProfile']>;
  } = {},
): PanelProfileResolution {
  if (matchesProfileIdentity(options.bound, profileName, definitionId)) {
    return {
      profile: options.bound,
      sourceId: sourceIdForProfile(catalog, options.bound),
    };
  }
  const frozen = findSnapshotProfile(options.frozen, profileName, definitionId);
  if (frozen !== undefined) {
    return { profile: frozen, sourceId: sourceIdForProfile(catalog, frozen) };
  }
  const current = findSnapshotProfile(catalog.snapshot?.(), profileName, definitionId);
  if (current !== undefined) {
    return { profile: current, sourceId: sourceIdForProfile(catalog, current) };
  }
  const inspection = profileName === undefined ? undefined : catalog.inspect(profileName);
  if (inspection !== undefined && matchesProfileIdentity(inspection.profile, profileName, definitionId)) {
    return {
      profile: inspection.profile,
      sourceId: panelProfileSourceId(inspection.sourceId),
    };
  }
  if (definitionId !== undefined) return {};
  const profile = profileName === undefined ? undefined : catalog.get(profileName);
  return {
    profile,
    sourceId: profile === undefined ? undefined : sourceIdForProfile(catalog, profile),
  };
}

function findSnapshotProfile(
  snapshot: AgentProfileCatalogSnapshot | undefined,
  profileName: string | undefined,
  definitionId: string | undefined,
): AgentProfile | undefined {
  if (snapshot === undefined) return undefined;
  if (definitionId !== undefined) {
    const profile = snapshot.sourceDefinitions.get(definitionId)
      ?? [...snapshot.publicProfiles.values()].find((candidate) => candidate.definitionId === definitionId)
      ?? [...(snapshot.resolvableProfiles?.values() ?? [])]
        .find((candidate) => candidate.definitionId === definitionId)
      ?? (snapshot.defaultProfile?.definitionId === definitionId ? snapshot.defaultProfile : undefined);
    return matchesProfileIdentity(profile, profileName, definitionId) ? profile : undefined;
  }
  if (profileName === undefined) return undefined;
  return snapshot.publicProfiles.get(profileName)
    ?? snapshot.resolvableProfiles?.get(profileName)
    ?? (snapshot.defaultProfile?.name === profileName ? snapshot.defaultProfile : undefined);
}

function matchesProfileIdentity(
  profile: PanelProfileDefinition | undefined,
  profileName: string | undefined,
  definitionId: string | undefined,
): profile is PanelProfileDefinition {
  if (profile === undefined) return false;
  return (profileName === undefined || profile.name === profileName)
    && (definitionId === undefined || profile.definitionId === definitionId);
}

function sourceIdForProfile(
  catalog: ISessionAgentProfileCatalog,
  profile: PanelProfileDefinition,
): 'builtin' | 'user' | 'workspace' | 'custom' {
  const inspection = catalog.inspect(profile.name);
  return inspection !== undefined && matchesProfileIdentity(
    inspection.profile,
    profile.name,
    profile.definitionId,
  ) ? panelProfileSourceId(inspection.sourceId) : 'custom';
}

function panelProfileSourceId(sourceId: string): 'builtin' | 'user' | 'workspace' | 'custom' {
  return sourceId === 'builtin' || sourceId === 'user' || sourceId === 'workspace'
    ? sourceId : 'custom';
}
