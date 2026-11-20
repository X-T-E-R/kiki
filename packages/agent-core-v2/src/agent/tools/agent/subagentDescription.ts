import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { sliceUtf16 } from '#/_base/text/utf16';
import { buildSubagentModelDescriptions } from '#/session/subagent/configSection';

export { buildProfileDescriptions } from '#/session/dispatch/profileCatalogProjection';

export const AGENT_RUN_ADVERTISED_MODELS_LIMIT_ENV = 'KIKI_AGENT_RUN_ADVERTISED_MODELS_LIMIT';
export const DEFAULT_AGENT_RUN_ADVERTISED_MODELS_LIMIT = 48;
export const AGENT_RUN_ADVERTISED_PROFILES_LIMIT_ENV = 'KIKI_AGENT_RUN_ADVERTISED_PROFILES_LIMIT';
export const DEFAULT_AGENT_RUN_ADVERTISED_PROFILES_LIMIT = 8;
export const AGENT_RUN_ADVERTISED_ROUTES_LIMIT_ENV = 'KIKI_AGENT_RUN_ADVERTISED_ROUTES_LIMIT';
export const DEFAULT_AGENT_RUN_ADVERTISED_ROUTES_LIMIT = 4;
export const AGENT_RUN_PROFILE_MENU_MODELS_LIMIT_ENV = 'KIKI_AGENT_RUN_PROFILE_MENU_MODELS_LIMIT';
export const DEFAULT_AGENT_RUN_PROFILE_MENU_MODELS_LIMIT = 24;
export const AGENT_RUN_PROFILE_DIAGNOSTICS_LIMIT_ENV = 'KIKI_AGENT_RUN_PROFILE_DIAGNOSTICS_LIMIT';
export const DEFAULT_AGENT_RUN_PROFILE_DIAGNOSTICS_LIMIT = 8;

function resolvePositiveIntEnv(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAgentRunAdvertisedModelsLimit(): number {
  return resolvePositiveIntEnv(
    AGENT_RUN_ADVERTISED_MODELS_LIMIT_ENV,
    DEFAULT_AGENT_RUN_ADVERTISED_MODELS_LIMIT,
  );
}

export function resolveAgentRunAdvertisedProfilesLimit(): number {
  return resolvePositiveIntEnv(
    AGENT_RUN_ADVERTISED_PROFILES_LIMIT_ENV,
    DEFAULT_AGENT_RUN_ADVERTISED_PROFILES_LIMIT,
  );
}

export function resolveAgentRunAdvertisedRoutesLimit(): number {
  return resolvePositiveIntEnv(
    AGENT_RUN_ADVERTISED_ROUTES_LIMIT_ENV,
    DEFAULT_AGENT_RUN_ADVERTISED_ROUTES_LIMIT,
  );
}

export function resolveAgentRunProfileMenuModelsLimit(): number {
  return resolvePositiveIntEnv(
    AGENT_RUN_PROFILE_MENU_MODELS_LIMIT_ENV,
    DEFAULT_AGENT_RUN_PROFILE_MENU_MODELS_LIMIT,
  );
}

function resolveAgentRunProfileDiagnosticsLimit(): number {
  return resolvePositiveIntEnv(
    AGENT_RUN_PROFILE_DIAGNOSTICS_LIMIT_ENV,
    DEFAULT_AGENT_RUN_PROFILE_DIAGNOSTICS_LIMIT,
  );
}

export function selectAdvertisedModelAliases(
  aliases: readonly string[],
  priorityAliases: readonly string[] = [],
  limit: number = resolveAgentRunAdvertisedModelsLimit(),
): { readonly advertised: readonly string[]; readonly omitted: number } {
  const safeLimit = Math.max(1, limit);
  if (aliases.length <= safeLimit) {
    return { advertised: aliases, omitted: 0 };
  }
  const available = new Set(aliases);
  const selected: string[] = [];
  const picked = new Set<string>();
  for (const alias of priorityAliases) {
    if (selected.length >= safeLimit) break;
    if (!available.has(alias) || picked.has(alias)) continue;
    picked.add(alias);
    selected.push(alias);
  }
  for (const alias of aliases) {
    if (selected.length >= safeLimit) break;
    if (picked.has(alias)) continue;
    picked.add(alias);
    selected.push(alias);
  }
  return { advertised: selected, omitted: aliases.length - selected.length };
}

export function formatAdvertisedModelDescriptions(
  aliases: readonly string[],
  priorityAliases: readonly string[] = [],
  limit: number = resolveAgentRunAdvertisedModelsLimit(),
): string {
  const { advertised, omitted } = selectAdvertisedModelAliases(aliases, priorityAliases, limit);
  const base = buildSubagentModelDescriptions(advertised);
  if (omitted <= 0 || advertised.length === 0) return base;
  const newline = base.indexOf('\n');
  const suffix = `, ... and ${omitted} more configured models`;
  if (newline < 0) return `${base}${suffix}`;
  return `${base.slice(0, newline)}${suffix}${base.slice(newline)}`;
}

function formatBoundedAliasList(aliases: readonly string[], limit: number): string {
  const unique = [...new Set(aliases)];
  if (unique.length === 0) return '';
  if (unique.length <= limit) return unique.join(', ');
  const shown = unique.slice(0, limit).join(', ');
  return `${shown}, ... and ${unique.length - limit} more`;
}

export function compactProfileDescriptions(
  profiles: readonly AgentProfile[],
  limit: number = resolveAgentRunAdvertisedProfilesLimit(),
  menuModelLimit: number = resolveAgentRunProfileMenuModelsLimit(),
): string {
  const diagnosticsLimit = resolveAgentRunProfileDiagnosticsLimit();
  return profiles.slice(0, limit).map((profile) => {
    const menuList = profile.restrictModelsToMenu === true
      ? formatBoundedAliasList(profile.effectiveModelAliases ?? [], menuModelLimit) || 'no effective candidates'
      : '';
    const menu = profile.restrictModelsToMenu === true
      ? ` Model menu restriction (hard): ${menuList}; pins cannot expand the declared menu.`
      : '';
    const rawDiagnostics = profile.modelMenuDiagnostics ?? [];
    const diagnostics = rawDiagnostics
      .slice(0, diagnosticsLimit)
      .map((message) => ` Configuration diagnostic: ${message}`)
      .join('');
    const omittedDiagnostics = rawDiagnostics.length > diagnosticsLimit
      ? ` (${rawDiagnostics.length - diagnosticsLimit} more diagnostics omitted)`
      : '';
    return `- ${profile.name}: ${firstSentence(profile.whenToUse ?? profile.description ?? 'Use when this profile fits the task.')}${menu}${diagnostics}${omittedDiagnostics}`;
  }).join('\n');
}

export function compactRouteDescriptions(
  routes: readonly AgentProfileRouteCatalogEntry[],
  limit: number = resolveAgentRunAdvertisedRoutesLimit(),
): string {
  return routes.slice(0, limit).map((route) =>
    `- ${route.id}: ${firstSentence(route.whenToUse ?? route.description ?? `Use the ${route.profile} route.`)}`,
  ).join('\n');
}

function firstSentence(text: string): string {
  const sentence = text.replaceAll(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]!;
  if (sentence.length <= 180) return sentence;
  const prefix = sliceUtf16(sentence, 0, 179);
  const boundary = prefix.lastIndexOf(' ');
  return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}…`;
}

export function buildRouteDescriptions(
  routes: readonly (AgentProfileRouteCatalogEntry & { readonly allowedModels?: readonly string[] })[],
  menuModelLimit: number = resolveAgentRunProfileMenuModelsLimit(),
): string {
  return routes
    .map((route) => {
      const details = [route.description, route.whenToUse].filter(Boolean).join(' ');
      const bindings = [
        route.modelAlias === undefined ? undefined : `model_alias=${route.modelAlias}`,
        route.thinkingEffort === undefined
          ? undefined
          : `thinking_effort=${route.thinkingEffort}`,
      ].filter((value): value is string => value !== undefined);
      const allowedList = route.allowedModels === undefined
        ? undefined
        : formatBoundedAliasList(route.allowedModels, menuModelLimit) || 'none';
      const suffix = [
        bindings.length === 0 ? undefined : bindings.join(', '),
        `overrides=${route.overriddenFields.join(',') || 'none'}`,
        allowedList === undefined ? undefined : `Allowed models: ${allowedList}`,
      ]
        .filter((value): value is string => value !== undefined)
        .join('; ');
      return `- ${route.id} (base: ${route.profile}): ${details}\n  ${suffix}`;
    })
    .join('\n');
}
