export interface SubagentPermissions {
  readonly canSpawnSubagents?: boolean;
  readonly allowedSubagents?: readonly string[];
  readonly preferredSubagents?: readonly string[];
  readonly denySubagents?: readonly string[];
}

export function overlaySubagentPermissions(base: SubagentPermissions, overlay: SubagentPermissions): SubagentPermissions {
  return {
    canSpawnSubagents: base.canSpawnSubagents === false || overlay.canSpawnSubagents === false
      ? false : overlay.canSpawnSubagents ?? base.canSpawnSubagents,
    allowedSubagents: base.allowedSubagents === undefined ? overlay.allowedSubagents
      : overlay.allowedSubagents === undefined ? base.allowedSubagents
        : base.allowedSubagents.filter((name) => overlay.allowedSubagents!.includes(name)),
    denySubagents: base.denySubagents === undefined && overlay.denySubagents === undefined ? undefined
      : [...new Set([...(base.denySubagents ?? []), ...(overlay.denySubagents ?? [])])],
    preferredSubagents: overlay.preferredSubagents ?? base.preferredSubagents,
  };
}
