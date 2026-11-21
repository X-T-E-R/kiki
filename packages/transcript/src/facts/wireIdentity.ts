export function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function nonEmptyStringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function isUndoAnchorOrigin(value: unknown): boolean {
  const raw = objectOf(value);
  const payload = objectOf(raw?.['payload']);
  const origin = payload !== undefined && typeof payload['kind'] === 'string' ? payload : raw;
  const kind = stringOf(origin?.['kind']);
  if (kind === 'merged') {
    const origins = Array.isArray(origin?.['origins']) ? origin['origins'] : [];
    return origins.some(isUndoAnchorOrigin);
  }
  if (
    kind === undefined ||
    kind === 'user' ||
    kind === 'peer_thread' ||
    kind === 'bridged_peer' ||
    kind === 'agent_message' ||
    kind === 'branch_fold' ||
    kind === 'external_thread' ||
    kind === 'unknown' ||
    (kind === 'system_trigger' && stringOf(origin?.['name']) === 'thread_create') ||
    (kind === 'room_message' && origin?.['targeted'] === true)
  ) return true;
  return (kind === 'skill_activation' || kind === 'plugin_command') && origin?.['trigger'] === 'user-slash';
}

export function isVisibleLegacyTurnOrigin(
  agentId: string,
  origin: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const kind = stringOf(origin?.['kind']);
  if (kind === 'system_trigger') {
    const name = stringOf(origin?.['name']);
    if (name === 'goal_continuation' || name === 'thread_create') return true;
    return name === 'subagent' && agentId !== 'main';
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') return origin?.['trigger'] === 'user-slash';
  return kind !== 'injection' && kind !== 'retry' && kind !== 'compaction_summary';
}

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: string;
}

/** Skill activations occupy the opening input parts; they render as markers, not prompt text. */
export function bundledSkillActivations(value: unknown): readonly BundledSkillActivation[] {
  const origin = objectOf(value);
  if (stringOf(origin?.['kind']) !== 'user') return [];
  const activations = Array.isArray(origin?.['skillActivations']) ? origin['skillActivations'] : [];
  return activations.flatMap((value) => {
    const activation = objectOf(value);
    const activationId = stringOf(activation?.['activationId']);
    const skillName = stringOf(activation?.['skillName']);
    if (activationId === undefined || skillName === undefined) return [];
    return [{ activationId, skillName,
      skillArgs: stringOf(activation?.['skillArgs']), skillType: stringOf(activation?.['skillType']),
      skillPath: stringOf(activation?.['skillPath']), skillSource: stringOf(activation?.['skillSource']) }];
  });
}
