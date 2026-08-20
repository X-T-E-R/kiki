import { Error2, ErrorCodes } from '#/errors';
import type { AgentModelProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveModelProfileEntry } from '#/app/agentProfileCatalog/modelProfileOverlay';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import type { IModelService } from '#/kosong/model/model';

export interface SubagentRoleModelConstraints {
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly origin?: string;
}

export function roleConstraintsFromProfile(
  profile: {
    readonly allowedModels?: readonly string[];
    readonly denyModels?: readonly string[];
    readonly allowedEfforts?: readonly string[];
    readonly modelProfiles?: readonly AgentModelProfile[];
  },
  origin?: string,
): SubagentRoleModelConstraints {
  return {
    allowedModels: profile.allowedModels,
    denyModels: profile.denyModels,
    allowedEfforts: profile.allowedEfforts,
    modelProfiles: profile.modelProfiles,
    ...(origin === undefined ? {} : { origin }),
  };
}

export function resolveRoleThinkingDefault(
  constraints: SubagentRoleModelConstraints | undefined,
  model: string,
  models?: IModelService,
): string | undefined {
  return resolveModelProfileEntry(constraints?.modelProfiles, model, resolveId(models))
    ?.thinkingEffort;
}

export function assertRoleSpawnConstraints(
  model: string,
  constraints: SubagentRoleModelConstraints | undefined,
  models: IModelService | undefined,
  machineDenied: ReadonlySet<string>,
  thinking?: string,
): void {
  if (constraints === undefined) return;
  assertRoleModelAllowDeny(model, constraints, models, machineDenied);
  assertRoleEffortAllowlist(model, thinking, constraints, models);
}

export function humanProfileDeviations(input: {
  readonly model: string;
  readonly thinking?: string;
  readonly constraints?: SubagentRoleModelConstraints;
  readonly models?: IModelService;
  readonly profileName?: string;
  readonly checkModel?: boolean;
  readonly checkThinking?: boolean;
}): readonly string[] {
  const constraints = input.constraints;
  if (constraints === undefined) return [];
  const messages: string[] = [];
  const checkModel = input.checkModel !== false;
  const checkThinking = input.checkThinking !== false;
  const canonicalModel = resolveModelIdentity(input.model, input.models);
  const roleDenied = identitySet(constraints.denyModels, input.models);
  const profile =
    input.profileName !== undefined
      ? `profile "${input.profileName}"`
      : (constraints.origin ?? 'this profile');
  if (checkModel) {
    if (roleDenied.has(canonicalModel)) {
      messages.push(
        `Model "${canonicalModel}" is listed in ${profile} deny_models; continuing with the explicit choice.`,
      );
    } else {
      const allowed = constraints.allowedModels;
      if (allowed !== undefined) {
        const allowedIds = identitySet(allowed, input.models);
        if (allowed.length === 0 || !allowedIds.has(canonicalModel)) {
          messages.push(
            `Model "${canonicalModel}" is not in ${profile} allowed_models; continuing with the explicit choice.`,
          );
        }
      }
    }
  }
  if (checkThinking) {
    const permittedEfforts = effectiveAllowedEfforts(constraints, input.model, input.models);
    if (
      permittedEfforts !== undefined &&
      input.thinking !== undefined &&
      input.thinking.trim().length > 0 &&
      !effortAllowed(input.thinking, permittedEfforts)
    ) {
      messages.push(
        `Thinking effort "${input.thinking}" is not in ${profile} allowed_efforts; continuing with the explicit choice.`,
      );
    }
  }
  return messages;
}

export function routeModelOverrideMessage(
  routeId: string | undefined,
  lockedAlias: string,
  chosenAlias: string,
): string {
  const route = routeId === undefined ? 'this route' : `Agent profile route "${routeId}"`;
  return `${route} locks model_alias to "${lockedAlias}"; continuing with "${chosenAlias}" as an explicit override.`;
}

export function routeThinkingOverrideMessage(
  routeId: string | undefined,
  lockedEffort: string,
  chosenEffort: string,
): string {
  const route = routeId === undefined ? 'this route' : `Agent profile route "${routeId}"`;
  return `${route} locks thinking_effort to "${lockedEffort}"; continuing with "${chosenEffort}" as an explicit override.`;
}

function assertRoleModelAllowDeny(
  model: string,
  constraints: SubagentRoleModelConstraints,
  models: IModelService | undefined,
  machineDenied: ReadonlySet<string>,
): void {
  const canonicalModel = resolveModelIdentity(model, models);
  const roleDenied = identitySet(constraints.denyModels, models);
  const origin = constraints.origin ?? "this agent's";
  if (roleDenied.has(canonicalModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Subagent model "${canonicalModel}" is denied by ${origin} deny_models.`,
      {
        details: {
          model: canonicalModel,
          deniedModels: [canonicalModel],
          roleDenyModels: [...roleDenied],
        },
      },
    );
  }
  const allowed = constraints.allowedModels;
  if (allowed === undefined) return;
  const allowedIds = identitySet(allowed, models);
  if (allowedIds.has(canonicalModel)) return;
  const permittedModels = allowed.filter((alias) => {
    const identity = resolveModelIdentity(alias, models);
    return !machineDenied.has(identity) && !roleDenied.has(identity);
  });
  throw new Error2(
    ErrorCodes.CONFIG_INVALID,
    `Subagent model "${canonicalModel}" is not in ${origin} allowed_models. Permitted models: ${permittedModels.join(', ') || '(none)'}.`,
    {
      details: {
        model: canonicalModel,
        allowedModels: [...allowed],
        permittedModels,
      },
    },
  );
}

function assertRoleEffortAllowlist(
  model: string,
  thinking: string | undefined,
  constraints: SubagentRoleModelConstraints,
  models: IModelService | undefined,
): void {
  const permitted = effectiveAllowedEfforts(constraints, model, models);
  if (permitted === undefined) return;
  if (thinking === undefined || thinking.trim().length === 0) return;
  if (effortAllowed(thinking, permitted)) return;
  throw new Error2(
    ErrorCodes.CONFIG_INVALID,
    `Subagent thinking effort "${thinking}" is not in ${constraints.origin ?? "this agent's"} allowed_efforts. Permitted efforts: ${permitted.join(', ') || '(none)'}.`,
    {
      details: {
        model: resolveModelIdentity(model, models),
        thinking,
        permittedEfforts: [...permitted],
      },
    },
  );
}

function effectiveAllowedEfforts(
  constraints: SubagentRoleModelConstraints,
  model: string,
  models: IModelService | undefined,
): readonly string[] | undefined {
  const role = constraints.allowedEfforts;
  const entry = resolveModelProfileEntry(constraints.modelProfiles, model, resolveId(models));
  const entryEfforts = nonemptyList(entry?.allowedEfforts);
  if (role === undefined) return entryEfforts;
  if (entryEfforts === undefined) return role;
  if (role.length === 0) return [];
  const allowed = new Set(entryEfforts.map(effortKey));
  return role.filter((effort) => allowed.has(effortKey(effort)));
}

function nonemptyList(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values;
}

function effortAllowed(thinking: string, permitted: readonly string[]): boolean {
  const wanted = effortKey(thinking);
  return permitted.some((effort) => effortKey(effort) === wanted);
}

function effortKey(value: string): string {
  return normalizeRequestedThinkingEffort(value) ?? value.trim().toLowerCase();
}

function resolveModelIdentity(model: string, models?: IModelService): string {
  return models?.resolveId(model) ?? model;
}

function identitySet(entries: readonly string[] | undefined, models?: IModelService): Set<string> {
  return new Set((entries ?? []).map((model) => resolveModelIdentity(model, models)));
}

function resolveId(models: IModelService | undefined): (id: string) => string | undefined {
  return (id) => models?.resolveId(id);
}
