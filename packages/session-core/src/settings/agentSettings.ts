import type { NamedAgentModelProfile, NamedAgentProfile, NamedAgentSubagentLease } from '@kiki/protocol';

import type { KikiConfigPatch, KikiConfigResponse } from '../transport';
import { configObjectOrEmpty, normalizeConfigStringList } from './settings';

export interface SubagentGovernanceDraft {
  readonly denyModels: string;
}

export function parseNamedAgentTools(value: string): string[] | null {
  const tools = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return tools.length === 0 ? null : tools;
}

export function resolveSelectedEffort(
  efforts: readonly string[] | undefined,
  effortOverride: string | undefined,
  defaultEffort: string | undefined,
): string | undefined {
  if (efforts === undefined || efforts.length === 0) return undefined;
  if (effortOverride !== undefined && efforts.includes(effortOverride)) return effortOverride;
  if (defaultEffort !== undefined && efforts.includes(defaultEffort)) return defaultEffort;
  return efforts[0];
}

export function subagentGovernanceFromConfig(config: unknown): SubagentGovernanceDraft {
  const subagent = configObjectOrEmpty(configObjectOrEmpty(config)['subagent']);
  return { denyModels: normalizeConfigStringList(subagent['denyModels']).join('\n') };
}

export function subagentGovernancePatch(draft: SubagentGovernanceDraft): KikiConfigPatch {
  return {
    subagent: {
      deny_models: draft.denyModels
        .split(/\r?\n/)
        .map((model) => model.trim())
        .filter(Boolean),
    },
  };
}
export interface ExperimentalFlagRow {
  readonly id: string;
  readonly effective: boolean;
  readonly override?: boolean;
}

export function experimentalFlagRows(
  meta: { readonly experimental_flags?: Record<string, boolean> },
  config: Pick<KikiConfigResponse, 'experimental'>,
): ExperimentalFlagRow[] {
  const effective = meta.experimental_flags ?? {};
  const overrides = config.experimental ?? {};
  return [...new Set([...Object.keys(effective), ...Object.keys(overrides)])]
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({ id, effective: effective[id] === true, override: overrides[id] }));
}

/**
 * Two disable channels: built-in profiles ride `disabled_builtin_profiles`,
 * every named (user/project/extra/…) profile rides `disabled_named_profiles`
 * and is disabled globally by name.
 */
export function disabledProfilePatch(
  config: Pick<KikiConfigResponse, 'disabled_builtin_profiles' | 'disabled_named_profiles'>,
  profile: Pick<NamedAgentProfile, 'name' | 'source'>,
  enabled: boolean,
): KikiConfigPatch {
  const current = profile.source === 'builtin'
    ? (config.disabled_builtin_profiles ?? [])
    : (config.disabled_named_profiles ?? []);
  const next = enabled
    ? current.filter((name) => name !== profile.name)
    : [...new Set([...current, profile.name])];
  return profile.source === 'builtin'
    ? { disabled_builtin_profiles: next }
    : { disabled_named_profiles: next };
}

/**
 * Merged-view normalization for /agents. New servers collapse duplicate
 * name+source+file rows across workspaces into one item carrying
 * `workspace_ids`; older servers (or `?expand=1`) return one row per
 * workspace. This pass is idempotent over already-merged payloads, so the
 * client renders one row per agent regardless of server version. `disabled`
 * is OR-ed: a name disabled anywhere shows disabled in the merged row.
 */
export function mergeNamedAgentProfiles(
  items: readonly NamedAgentProfile[],
): NamedAgentProfile[] {
  const merged: NamedAgentProfile[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    const key = `${item.name}\n${item.source}\n${item.source_file ?? ''}`;
    const ids = item.workspace_ids ?? (item.workspace_id === undefined ? [] : [item.workspace_id]);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({ ...item, workspace_ids: ids });
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      workspace_ids: [...new Set([...(existing.workspace_ids ?? []), ...ids])],
      disabled: existing.disabled || item.disabled,
    };
  }
  return merged;
}

/**
 * Main/sub split for the settings agents section: the engine catalog flags
 * curated main profiles (`main: true`); every other named profile — built-in
 * or file-backed — is a subagent profile.
 */
export function partitionNamedAgentProfiles(
  profiles: readonly NamedAgentProfile[],
): { readonly main: NamedAgentProfile[]; readonly sub: NamedAgentProfile[] } {
  const main: NamedAgentProfile[] = [];
  const sub: NamedAgentProfile[] = [];
  for (const profile of profiles) {
    (profile.main ? main : sub).push(profile);
  }
  return { main, sub };
}

/**
 * Same-name override relation between a built-in profile and file-backed
 * profiles, mirroring the engine merge rules:
 * - A file profile carrying `override: true` wins over an enabled built-in
 *   of the same name: the file row is the effective one (`overrides_builtin`)
 *   and the built-in collapses to a shadow note (`overridden`).
 * - A file profile without `override` loses to an enabled same-name built-in
 *   (`shadowed`) — the row stays visible with a not-in-effect warning.
 * - A disabled built-in does not participate in the merge, so a same-name
 *   file profile takes effect with no override flag and no annotation.
 *   A disabled file profile overrides nothing either — the built-in row
 *   returns to its plain enabled/disabled presentation.
 */
export type NamedAgentOverrideRelation =
  | { readonly kind: 'overrides_builtin'; readonly builtinName: string }
  | { readonly kind: 'overridden'; readonly file: string }
  | { readonly kind: 'shadowed'; readonly builtinName: string };

export function namedAgentOverrideRelations(
  profiles: readonly NamedAgentProfile[],
): ReadonlyMap<NamedAgentProfile, NamedAgentOverrideRelation> {
  const relations = new Map<NamedAgentProfile, NamedAgentOverrideRelation>();
  const builtinsByName = new Map<string, NamedAgentProfile>();
  for (const profile of profiles) {
    if (profile.source === 'builtin' && !builtinsByName.has(profile.name)) {
      builtinsByName.set(profile.name, profile);
    }
  }
  const overridingFileByName = new Map<string, NamedAgentProfile>();
  for (const profile of profiles) {
    if (profile.source === 'builtin' || profile.disabled) continue;
    const builtin = builtinsByName.get(profile.name);
    if (builtin === undefined || builtin.disabled) continue;
    if (profile.override === true) {
      relations.set(profile, { kind: 'overrides_builtin', builtinName: builtin.name });
      if (!overridingFileByName.has(profile.name)) overridingFileByName.set(profile.name, profile);
    } else {
      relations.set(profile, { kind: 'shadowed', builtinName: builtin.name });
    }
  }
  for (const [name, file] of overridingFileByName) {
    const builtin = builtinsByName.get(name);
    if (builtin !== undefined) {
      relations.set(builtin, {
        kind: 'overridden',
        file: file.source_file ?? file.name,
      });
    }
  }
  return relations;
}

/**
 * /new deep link preselecting a named profile. Prefers the profile's own
 * workspace; workspace-less (builtin) profiles fall back to the most recent
 * workspace; with no workspace at all the link carries only the agent.
 */
export function namedAgentSessionHref(
  profile: Pick<NamedAgentProfile, 'name' | 'workspace_id' | 'workspace_ids'>,
  fallbackWorkspaceId?: string,
): string {
  const workspace = profile.workspace_ids?.[0] ?? profile.workspace_id ?? fallbackWorkspaceId;
  const params = new URLSearchParams();
  if (workspace !== undefined) params.set('workspace', workspace);
  params.set('agent', profile.name);
  return `/new?${params.toString()}`;
}

/**
 * Whether the row's new-session button must stay disabled. A shadowed file
 * profile (same-named enabled built-in, no `override: true`) never runs under
 * its name — the session would silently run the built-in instead, so the
 * button is blocked rather than misleading. A disabled main profile keeps
 * the button (main sessions still run it); a disabled subagent profile loses
 * it.
 */
export function namedAgentNewSessionBlocked(
  profile: Pick<NamedAgentProfile, 'disabled' | 'main'>,
  relation?: NamedAgentOverrideRelation,
): boolean {
  if (relation?.kind === 'shadowed') return true;
  return profile.disabled && profile.main !== true;
}

/** Semantic labels for the read-only lease detail rows; the component maps
 * each to its i18n label key. */
export type NamedAgentLeaseDetailLabel =
  | 'description'
  | 'whenToUse'
  | 'contextBudget'
  | 'maxCompletionTokens'
  | 'serviceTier'
  | 'delegationNotice'
  | 'promptMode'
  | 'allowedModels'
  | 'deniedModels'
  | 'allowedEfforts'
  | 'tools'
  | 'disallowedTools'
  | 'subagents'
  | 'prompt'
  | 'requestParams'
  | 'modelProfile'
  | 'leaseSource';

export interface NamedAgentLeaseSummary {
  /** `name · model_alias · thinking_effort`, skipping empty parts. */
  readonly headline: string;
  /** One entry per non-empty constraint/detail field, in contract order. */
  readonly details: readonly { readonly label: NamedAgentLeaseDetailLabel; readonly value: string }[];
  /** Scoped source lease (dedicated subagent): badge + status rows apply. */
  readonly scoped: boolean;
  /** Resolution status projected by the server for a scoped source lease. */
  readonly status?: 'ready' | 'unavailable';
  /** Short reason a scoped source lease failed to resolve. */
  readonly diagnostic?: string;
}

export interface NamedAgentModelProfileSummary {
  /** `alias → when · thinking_effort`, skipping optional fields. */
  readonly headline: string;
  /** One entry per non-empty model profile parameter or prompt field. */
  readonly details: readonly { readonly label: NamedAgentLeaseDetailLabel; readonly value: string }[];
}

/**
 * Shared read-only formatting for a model-profile entry, used both for the
 * profile's own `model_profiles` rows and for lease-nested ones: every
 * non-empty contract field (allowed_efforts, prompt_mode, prompt included)
 * produces a visible detail.
 */
export function summarizeNamedAgentModelProfile(entry: NamedAgentModelProfile): NamedAgentModelProfileSummary {
  const when = entry.when?.trim();
  const headline = `${entry.alias}${when === undefined || when === '' ? '' : ` → ${when}`}${entry.thinking_effort === undefined ? '' : ` · ${entry.thinking_effort}`}`;
  const details: { readonly label: NamedAgentLeaseDetailLabel; readonly value: string }[] = [];
  if (entry.context_budget !== undefined && entry.context_budget > 0) details.push({ label: 'contextBudget', value: String(entry.context_budget) });
  if (entry.max_completion_tokens !== undefined && entry.max_completion_tokens > 0) details.push({ label: 'maxCompletionTokens', value: String(entry.max_completion_tokens) });
  if (entry.service_tier !== undefined) details.push({ label: 'serviceTier', value: entry.service_tier });
  if (entry.request_params !== undefined && Object.keys(entry.request_params).length > 0) {
    details.push({ label: 'requestParams', value: JSON.stringify(entry.request_params) });
  }
  if (entry.allowed_efforts !== undefined && entry.allowed_efforts.length > 0) {
    details.push({ label: 'allowedEfforts', value: entry.allowed_efforts.join(', ') });
  }
  if (entry.prompt_mode !== undefined) details.push({ label: 'promptMode', value: entry.prompt_mode });
  if (entry.prompt !== undefined && entry.prompt !== '') details.push({ label: 'prompt', value: entry.prompt });
  return { headline, details };
}

/**
 * Read-only summary model for a structured subagent lease: every non-empty
 * field of the protocol lease becomes visible in the settings detail block,
 * so nothing the server projects is silently hidden.
 */
export function summarizeNamedAgentLease(lease: NamedAgentSubagentLease): NamedAgentLeaseSummary {
  const nonEmpty = (value: string | undefined | null): value is string =>
    value !== undefined && value !== null && value !== '';
  const headline = [lease.name, lease.model_alias, lease.thinking_effort].filter(nonEmpty).join(' · ');
  const scoped = lease.scope === 'private';
  const details: { readonly label: NamedAgentLeaseDetailLabel; readonly value: string }[] = [];
  if (scoped && nonEmpty(lease.source)) details.push({ label: 'leaseSource', value: lease.source });
  if (nonEmpty(lease.description)) details.push({ label: 'description', value: lease.description });
  if (nonEmpty(lease.when_to_use)) details.push({ label: 'whenToUse', value: lease.when_to_use });
  if (lease.service_tier !== undefined && lease.service_tier !== null) {
    details.push({ label: 'serviceTier', value: lease.service_tier });
  }
  if (lease.delegation_notice !== undefined) details.push({ label: 'delegationNotice', value: lease.delegation_notice });
  if (lease.prompt_mode !== undefined) details.push({ label: 'promptMode', value: lease.prompt_mode });
  const listFields = [
    ['allowedModels', lease.allowed_models],
    ['deniedModels', lease.deny_models],
    ['allowedEfforts', lease.allowed_efforts],
    ['tools', lease.tools],
    ['disallowedTools', lease.disallowed_tools],
    ['subagents', lease.subagents],
  ] as const;
  for (const [label, values] of listFields) {
    if (values !== undefined && values !== null && values.length > 0) {
      details.push({ label, value: values.join(', ') });
    }
  }
  if (nonEmpty(lease.prompt)) details.push({ label: 'prompt', value: lease.prompt });
  if (lease.request_params !== undefined && lease.request_params !== null && Object.keys(lease.request_params).length > 0) {
    details.push({ label: 'requestParams', value: JSON.stringify(lease.request_params) });
  }
  for (const entry of lease.model_profiles ?? []) {
    const modelProfile = summarizeNamedAgentModelProfile(entry);
    details.push({ label: 'modelProfile', value: modelProfile.headline });
    details.push(...modelProfile.details);
  }
  return {
    headline,
    details,
    scoped,
    status: scoped ? lease.status : undefined,
    diagnostic: scoped && nonEmpty(lease.diagnostic) ? lease.diagnostic : undefined,
  };
}

/** Compact workspace chip model: the first `max` ids plus an overflow count. */
export function workspaceChipDisplay(
  ids: readonly string[],
  max = 2,
): { readonly shown: readonly string[]; readonly extra: number } {
  return { shown: ids.slice(0, max), extra: Math.max(0, ids.length - max) };
}

export function composerDefaultsForProfile(
  profiles: readonly NamedAgentProfile[],
  name: string,
): { readonly model?: string; readonly thinking?: string } {
  const profile = profiles.find((item) => item.name === name);
  const model = profile?.pinned_model_alias?.trim();
  const thinking = profile?.thinking_effort?.trim();
  return {
    model: model === undefined || model === '' ? undefined : model,
    thinking: thinking === undefined || thinking === '' ? undefined : thinking,
  };
}
