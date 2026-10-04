export function upgradePersistedSubagentPermissions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(upgradePersistedSubagentPermissions) as T;
  if (typeof value !== 'object' || value === null) return value;
  const input = value as Record<string, unknown>;
  const output = { ...input };
  for (const key of ['boundProfile', 'fileDefinition', 'fileSources', 'root', 'callerCeiling', 'appliedLease', 'lease', 'profile']) {
    if (Object.hasOwn(input, key)) output[key] = upgradePersistedSubagentPermissions(input[key]);
  }
  for (const key of ['subagentLeases', 'sourceDefinitions']) {
    if (typeof input[key] === 'object' && input[key] !== null) {
      output[key] = Object.fromEntries(Object.entries(input[key]).map(([name, item]) => [name, upgradePersistedSubagentPermissions(item)]));
    }
  }
  if (typeof input['scopedBindings'] === 'object' && input['scopedBindings'] !== null) {
    output['scopedBindings'] = Object.fromEntries(Object.entries(input['scopedBindings']).map(([id, table]) => [id,
      Object.fromEntries(Object.entries(table as Record<string, unknown>).map(([name, item]) => [name, upgradePersistedSubagentPermissions(item)])),
    ]));
  }
  if (!Object.hasOwn(input, 'subagents') && !Object.hasOwn(input, 'subagentDeclaration') && !Object.hasOwn(input, 'subagentPolicy')) return output as T;
  const declaration = input['subagentDeclaration'] as { kind?: string; names?: readonly string[] } | undefined;
  const names = declaration?.kind === 'set' ? declaration.names : declaration?.kind === 'all' ? undefined
    : Array.isArray(input['subagents']) ? input['subagents'] as readonly string[] : undefined;
  if (input['subagentPolicy'] === 'advisory') {
    output['preferredSubagents'] ??= names;
  } else {
    output['allowedSubagents'] ??= names?.includes('*') ? undefined : names;
    if (names?.length === 0 && output['canSpawnSubagents'] === undefined) output['canSpawnSubagents'] = false;
  }
  delete output['subagents'];
  delete output['subagentPolicy'];
  delete output['subagentDeclaration'];
  return output as T;
}
