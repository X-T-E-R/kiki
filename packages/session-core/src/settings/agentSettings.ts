import type { NamedAgentModelProfile, NamedAgentProfile, NamedAgentSubagentLease, ShippedAgentProfile } from '@kiki/protocol';

import type { I18nKey } from '../i18n';
import type { KikiConfigPatch, KikiConfigResponse } from '../transport';
import type { RuntimeConfigDraft } from './settings';
import { configObjectOrEmpty, normalizeConfigStringList, normalizeTags } from './settings';

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

/**
 * Composer-side mirror of the engine's `resolveModelId` over the `/models`
 * catalog: an exact key wins first, a bare id matches any `provider/id` key
 * tail, and a qualified `provider/tail` id matches the bare key of that
 * provider (including `managed:`-prefixed provider ids). An ambiguous bare id
 * is not an error — the first catalog row in server order resolves it, which
 * is the candidate the engine picks as well.
 */
export function resolveCatalogModel<
  T extends { readonly id: string; readonly remote_id: string; readonly provider_id: string },
>(items: readonly T[], id: string): T | undefined {
  const exact = items.find((item) => item.id === id);
  if (exact !== undefined) return exact;
  if (!id.includes('/')) {
    return items.find((item) => item.id.endsWith(`/${id}`));
  }
  const slash = id.lastIndexOf('/');
  const prefix = id.slice(0, slash);
  const tail = id.slice(slash + 1);
  if (tail === '') return undefined;
  return items.find(
    (item) =>
      item.id === tail &&
      (item.provider_id === prefix || item.provider_id.endsWith(`:${prefix}`)),
  );
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

/**
 * Mirror of the engine's `DEFAULT_SUBAGENT_PROFILE` (`[subagent].default_profile`
 * falls back to it when the key is unset). The engine resolves
 * `undefined → this name`, a blank string → strict mode (omitted targets fail),
 * anything else → that profile name.
 */
export const DEFAULT_SUBAGENT_PROFILE_NAME = 'general';

export type SubagentDefaultTarget =
  | { readonly mode: 'strict' }
  | { readonly mode: 'profile'; readonly name: string };

export function subagentDefaultTargetFromConfig(config: unknown): SubagentDefaultTarget {
  const subagent = configObjectOrEmpty(configObjectOrEmpty(config)['subagent']);
  const raw = subagent['defaultProfile'];
  if (typeof raw !== 'string') return { mode: 'profile', name: DEFAULT_SUBAGENT_PROFILE_NAME };
  const trimmed = raw.trim();
  return trimmed.length === 0 ? { mode: 'strict' } : { mode: 'profile', name: trimmed };
}

export function subagentDefaultTargetPatch(target: SubagentDefaultTarget): KikiConfigPatch {
  return { subagent: { default_profile: target.mode === 'strict' ? '' : target.name } };
}

/**
 * Locates the shipped-template management entry for a catalog row by its exact
 * on-disk path — never by name alone, so a same-named user file elsewhere is
 * not mistaken for the managed built-in copy.
 */
export function shippedEntryForProfile(
  profile: Pick<NamedAgentProfile, 'source_file'>,
  entries: readonly ShippedAgentProfile[],
): ShippedAgentProfile | undefined {
  const sourceFile = profile.source_file;
  if (sourceFile === undefined) return undefined;
  const normalized = normalizeShippedProfilePath(sourceFile);
  return entries.find(
    (entry) =>
      entry.managed &&
      entry.active_path !== undefined &&
      normalizeShippedProfilePath(entry.active_path) === normalized,
  );
}

function normalizeShippedProfilePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/u, '');
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

/** Disable or enable a profile name across every profile source. */
export function disabledProfilePatch(
  config: Pick<KikiConfigResponse, 'disabled_named_profiles'>,
  profile: Pick<NamedAgentProfile, 'name'>,
  enabled: boolean,
): KikiConfigPatch {
  const current = config.disabled_named_profiles ?? [];
  const next = enabled
    ? current.filter((name) => name !== profile.name)
    : [...new Set([...current, profile.name])];
  return { disabled_named_profiles: next };
}

export interface AgentIdentitySparsePatch {
  readonly identityName?: boolean;
  readonly identitySlug?: boolean;
  readonly advertiseAsKimiCode?: boolean;
  readonly extraAgentDirs?: boolean;
  readonly disabledNamedProfiles?: boolean;
}

/**
 * Replace only edited domains. Identity replacement must carry all its fields,
 * including unchanged siblings, while untouched profile lists are omitted.
 */
export function agentIdentitySparsePatch(
  draft: Pick<
    RuntimeConfigDraft,
    'identityName' | 'identitySlug' | 'advertiseAsKimiCode' | 'extraAgentDirs' | 'disabledNamedProfiles'
  >,
  touched: AgentIdentitySparsePatch,
): KikiConfigPatch {
  const patch: {
    identity?: NonNullable<KikiConfigPatch['identity']>;
    extra_agent_dirs?: string[];
    disabled_named_profiles?: string[];
    replace_domains: string[];
  } = { replace_domains: [] };
  if (touched.identityName || touched.identitySlug || touched.advertiseAsKimiCode) {
    patch.identity = {
      name: draft.identityName.trim() || undefined,
      slug: draft.identitySlug.trim() || undefined,
      advertise_as_kimi_code: draft.advertiseAsKimiCode,
    };
    patch.replace_domains.push('identity');
  }
  if (touched.extraAgentDirs) {
    patch.extra_agent_dirs = normalizeTags(draft.extraAgentDirs);
    patch.replace_domains.push('extra_agent_dirs');
  }
  if (touched.disabledNamedProfiles) {
    patch.disabled_named_profiles = normalizeTags(draft.disabledNamedProfiles);
    patch.replace_domains.push('disabled_named_profiles');
  }
  return patch;
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

/** i18n label key for each semantic lease detail label, shared by every
 * surface that renders `summarizeNamedAgentLease` / model-profile details. */
export const NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS: Record<NamedAgentLeaseDetailLabel, I18nKey> = {
  description: 'st.namedAgents.description',
  whenToUse: 'st.namedAgents.whenToUse',
  contextBudget: 'st.namedAgents.contextBudget',
  maxCompletionTokens: 'st.namedAgents.maxCompletionTokens',
  serviceTier: 'st.namedAgents.serviceTier',
  delegationNotice: 'st.namedAgents.delegationNotice',
  promptMode: 'st.namedAgents.promptMode',
  allowedModels: 'st.namedAgents.allowedModels',
  deniedModels: 'st.namedAgents.deniedModels',
  allowedEfforts: 'st.namedAgents.allowedEfforts',
  tools: 'st.namedAgents.tools',
  disallowedTools: 'st.namedAgents.disallowedTools',
  subagents: 'st.namedAgents.subagentLease',
  prompt: 'st.namedAgents.prompt',
  requestParams: 'st.namedAgents.requestParams',
  modelProfile: 'st.namedAgents.modelProfile',
  leaseSource: 'st.namedAgents.leaseSource',
};

/** Provenance values the panel can label, mirroring the `model_source` /
 * `effort_source` enums of the capabilities contract (`diagnostics.source.*`). */
const AGENT_PROFILE_VALUE_SOURCE_KEYS: Readonly<Record<string, I18nKey>> = {
  'caller-lease': 'diagnostics.source.caller-lease',
  route: 'diagnostics.source.route',
  profile: 'diagnostics.source.profile',
  'model-profile': 'diagnostics.source.model-profile',
  model: 'diagnostics.source.model',
  config: 'diagnostics.source.config',
  executor: 'diagnostics.source.executor',
};

export interface AgentProfileValueOrigin {
  readonly locked: boolean;
  readonly labelKey: I18nKey;
}

/**
 * Where an effective model/effort value came from, as far as the panel can
 * prove it. A locked value is the profile binding. Otherwise the server's own
 * `model_source` / `effort_source` wins when reported; without one, a source
 * is only attributed when the bound definition declares exactly the effective
 * value — anything else stays "not reported" instead of claiming a source.
 */
export function agentProfileValueOrigin(args: {
  readonly reported?: string;
  readonly effective?: string;
  readonly declared?: string;
  readonly locked: boolean;
}): AgentProfileValueOrigin {
  if (args.locked) return { locked: true, labelKey: 'diagnostics.source.profile' };
  const reportedKey = args.reported === undefined
    ? undefined
    : AGENT_PROFILE_VALUE_SOURCE_KEYS[args.reported];
  if (reportedKey !== undefined) return { locked: false, labelKey: reportedKey };
  return {
    locked: false,
    labelKey: args.declared !== undefined && args.declared === args.effective
      ? 'diagnostics.source.profile'
      : 'diagnostics.unknown',
  };
}

/** Label keys for the known profile source ids; unknown ids stay raw. */
const AGENT_PROFILE_SOURCE_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  builtin: 'agentPanel.sourceId.builtin',
  user: 'agentPanel.sourceId.user',
  workspace: 'agentPanel.sourceId.workspace',
  custom: 'agentPanel.sourceId.custom',
  extra: 'agentPanel.sourceId.extra',
  plugin: 'agentPanel.sourceId.plugin',
  explicit: 'agentPanel.sourceId.explicit',
};

/** i18n label key for a profile source id, or `undefined` when the id is not
 * a known source — callers render the raw string then. */
export function agentProfileSourceLabelKey(source: string | undefined): I18nKey | undefined {
  return source === undefined ? undefined : AGENT_PROFILE_SOURCE_LABEL_KEYS[source];
}

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
