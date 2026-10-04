import { parseNamedAgentTools } from '@kiki/session-core/settings';
import type { NamedAgentProfile, UpdateNamedAgentProfileRequest } from '../../../lib/client';
import type { KikiContextGroup } from '../../harness/kikiContext';
import { modelPromptBody, modelPromptDraft, modelPromptIdentityBody, modelPromptProblem, promptIdentityBody, promptIdentityDraft, promptIdentityProblem, promptOverridesBody, promptOverridesDraft, promptOverridesProblem, type ModelPromptDraft, type PromptIdentityDraft, type PromptOverridesDraft } from '../promptIdentityDraft';
import {
  executorPromptBody, executorPromptDraftFrom, executorPromptIncludesValid, type ExecutorPromptDraft,
} from './executorPromptDraft';

/**
 * Three-way state of one frontmatter tool list. `inherit` writes nothing (the
 * layer does not restrict), `empty` writes an explicit empty list, and `list`
 * writes the parsed names. The engine keeps an absent field and `[]` apart,
 * so the editor round-trips all three.
 */
export type ToolFieldMode = 'inherit' | 'empty' | 'list';
export interface ToolFieldValue { readonly mode: ToolFieldMode; readonly text: string }

export function toolFieldFrom(value: readonly string[] | undefined): ToolFieldValue {
  if (value === undefined) return { mode: 'inherit', text: '' };
  return { mode: value.length === 0 ? 'empty' : 'list', text: value.join(', ') };
}
export function toolFieldsEqual(left: ToolFieldValue, right: ToolFieldValue): boolean {
  return left.mode === right.mode && (left.mode !== 'list' || left.text === right.text);
}
/** `null` deletes the frontmatter field, `[]` writes an empty list. */
export function toolFieldBody(field: ToolFieldValue): string[] | null {
  if (field.mode === 'inherit') return null;
  if (field.mode === 'empty') return [];
  return parseNamedAgentTools(field.text) ?? [];
}
export function toolFieldUnnamed(field: ToolFieldValue): boolean {
  return field.mode === 'list' && parseNamedAgentTools(field.text) === null;
}

/**
 * The hard/soft split of one profile's dispatch rights, as the editor models
 * it. `canSpawnSubagents` is the single on/off switch and the only thing that
 * makes a profile a leaf; the three lists only speak about the named presets
 * and routes a preset list can reach. An absent list is its own state: this
 * layer adds no hard scope, which is different from an empty list (this layer
 * allows no preset) and different again from the switch being off.
 */
export interface SubagentPolicyDraft {
  /** `undefined` = this layer declares nothing; `false` = a hard leaf. */
  readonly canSpawnSubagents: boolean | undefined;
  /** `undefined` = no preset scope added here; `[]` = no preset selectable here. */
  readonly allowedSubagents: readonly SubagentLeaseDraft[] | undefined;
  /** Pure names: a recommendation never widens or narrows what may run. */
  readonly preferredSubagents: readonly string[] | undefined;
  readonly denySubagents: readonly string[] | undefined;
}

export interface SubagentLeaseDraft {
  readonly name: string;
  /** Lease pins; '' = the lease does not pin it. */
  readonly modelAlias: string;
  readonly effort: string;
  /** Read-only lease facts carried for display and round-trip. */
  readonly source?: string;
  readonly status?: 'ready' | 'unavailable';
  readonly allowedModels?: readonly string[];
  readonly modelPrompts?: 'preserve' | 'replace';
  readonly modelProfiles?: readonly import('@kiki/protocol').NamedAgentModelProfile[];
  /** Complete existing mapping; unedited configuration stays owned by the writer's sparse merge. */
  readonly lease?: import('@kiki/protocol').NamedAgentSubagentLease;
}

/**
 * The name that opens the preset domain instead of naming a preset. It can sit
 * in the same list as lease mappings: `['*', { name: 'explore', … }]` means
 * "no preset scope added here, but pin explore", and the mapping must survive
 * a later edit of the scope.
 */
export const PRESET_DOMAIN_OPEN = '*';

function leaseIsBare(entry: SubagentLeaseDraft): boolean {
  return entry.lease === undefined && entry.modelAlias === '' && entry.effort === '' && entry.source === undefined
    && entry.allowedModels === undefined && entry.modelPrompts === undefined && entry.modelProfiles === undefined;
}

/** Whether a name is `*` without depending on the wire constant. */
export function isOpenDomain(name: string): boolean {
  return name === PRESET_DOMAIN_OPEN;
}

/**
 * "Stop limiting this layer", as a draft list: the key is dropped when nothing
 * is pinned, and otherwise the domain is left open while the pins stay. A bare
 * name beside `*` says nothing the wildcard does not, so it is dropped here
 * rather than written and normalised back on the next read.
 */
export function openAllowedSubagents(entries: readonly SubagentLeaseDraft[] | undefined): SubagentLeaseDraft[] | undefined {
  const pinned = (entries ?? []).filter((entry) => !isOpenDomain(entry.name) && !leaseIsBare(entry));
  return pinned.length === 0 ? undefined : [{ name: PRESET_DOMAIN_OPEN, modelAlias: '', effort: '' }, ...pinned];
}

/** Whether the list already leaves the preset domain open. */
export function allowedSubagentsOpen(entries: readonly SubagentLeaseDraft[] | undefined): boolean {
  return (entries ?? []).some((entry) => isOpenDomain(entry.name));
}

/** A profile that declares no `can_spawn_subagents` follows the layers above it. */
export function canSpawnDraft(value: boolean | undefined): boolean {
  return value !== false;
}

/**
 * The four dispatch fields, read and written through the wire contract the
 * agent-profiles lane owns. `NamedAgentProfile` and
 * `UpdateNamedAgentProfileRequest` are the only shapes named here: the editor
 * holds no copy of this schema, so the two `Pick`s below are the entire seam
 * to delete once the naming settles.
 */
type SubagentPolicyRead = Pick<NamedAgentProfile,
  'can_spawn_subagents' | 'allowed_subagents' | 'preferred_subagents' | 'deny_subagents'>;
type SubagentPolicyWrite = Pick<UpdateNamedAgentProfileRequest,
  'can_spawn_subagents' | 'allowed_subagents' | 'preferred_subagents' | 'deny_subagents'>;
type SubagentPolicyPatch = SubagentPolicyWrite;

function dispatchFields(profile: NamedAgentProfile): SubagentPolicyRead {
  return profile;
}

/** The same read projection for display-only callers outside the editor. */
export function dispatchFieldsOf(profile: NamedAgentProfile): SubagentPolicyRead {
  return dispatchFields(profile);
}

function assignSubagentPolicy(body: UpdateNamedAgentProfileRequest, patch: SubagentPolicyPatch): void {
  Object.assign(body, patch);
}

/**
 * The switch on its own, for editors that expose only that one control: the
 * same three-state binding, so a dialog cannot write `true` where the profile
 * said nothing and thereby turn an inherited value into a declaration.
 */
export function canSpawnSubagentsPatch(
  baseline: boolean | undefined,
  draft: boolean | undefined,
): SubagentPolicyPatch | undefined {
  return baseline === draft ? undefined : { can_spawn_subagents: draft ?? null };
}

export function assignCanSpawnSubagents(body: UpdateNamedAgentProfileRequest, patch: SubagentPolicyPatch | undefined): void {
  if (patch !== undefined) assignSubagentPolicy(body, patch);
}

type LeaseWireEntry = NonNullable<SubagentPolicyRead['allowed_subagents']>[number];

function leaseFromWire(entry: LeaseWireEntry): SubagentLeaseDraft {
  if (typeof entry === 'string') return { name: entry, modelAlias: '', effort: '' };
  return {
    name: entry.name, modelAlias: entry.model_alias ?? '', effort: entry.thinking_effort ?? '',
    source: entry.source, status: entry.status, allowedModels: entry.allowed_models,
    modelPrompts: entry.model_prompts, modelProfiles: entry.model_profiles, lease: entry,
  };
}

export function subagentPolicyFromProfile(profile: NamedAgentProfile): SubagentPolicyDraft {
  const wire = dispatchFields(profile);
  return {
    canSpawnSubagents: wire.can_spawn_subagents,
    allowedSubagents: wire.allowed_subagents === undefined ? undefined : wire.allowed_subagents.map(leaseFromWire),
    preferredSubagents: wire.preferred_subagents ?? undefined,
    denySubagents: wire.deny_subagents ?? undefined,
  };
}

/**
 * The PATCH for the four fields. Only a field the draft actually changed
 * rides along, so touching one list never rewrites the others: editing
 * `preferred_subagents` alone must not write `allowed_subagents: []` or
 * `can_spawn_subagents: false`, which would turn a recommendation into a
 * restriction. `null` drops this layer's declaration, which is not the same
 * as writing an empty list.
 */
export function subagentPolicyPatch(
  baseline: SubagentPolicyDraft,
  draft: SubagentPolicyDraft,
): SubagentPolicyPatch | undefined {
  const patch: Record<string, unknown> = {};
  if (baseline.canSpawnSubagents !== draft.canSpawnSubagents) {
    patch['can_spawn_subagents'] = draft.canSpawnSubagents ?? null;
  }
  if (baseline.allowedSubagents !== draft.allowedSubagents) {
    const before = new Map((baseline.allowedSubagents ?? []).map((entry) => [entry.name, entry]));
    if (draft.allowedSubagents === undefined) {
      patch['allowed_subagents'] = null;
    } else {
      const open = allowedSubagentsOpen(draft.allowedSubagents);
      // A bare name leaves the entry's whole lease mapping (source, pins,
      // per-child prompts and model profiles) exactly as it is on disk. The
      // baseline is matched on names alone, so opening the domain — which adds
      // a `*` row and changes no pin — still finds each entry it came from.
      const rows = draft.allowedSubagents.filter((entry) => !isOpenDomain(entry.name)).map((entry) => {
        const prior = before.get(entry.name);
        const promptsChanged = entry.modelPrompts !== prior?.modelPrompts;
        const pinChanged = prior === undefined
          || prior.modelAlias !== entry.modelAlias || prior.effort !== entry.effort;
        if (!pinChanged && !promptsChanged) return open && leaseIsBare(entry) ? null : entry.name;
        return {
          name: entry.name, model_alias: textOrNull(entry.modelAlias), thinking_effort: textOrNull(entry.effort),
          model_prompts: promptsChanged ? entry.modelPrompts : undefined,
          model_profiles: promptsChanged && entry.modelProfiles !== undefined ? [...entry.modelProfiles] : undefined,
        };
      }).filter((row) => row !== null);
      patch['allowed_subagents'] = open ? [PRESET_DOMAIN_OPEN, ...rows] : rows;
    }
  }
  if (baseline.preferredSubagents !== draft.preferredSubagents) {
    patch['preferred_subagents'] = draft.preferredSubagents === undefined ? null : [...draft.preferredSubagents];
  }
  if (baseline.denySubagents !== draft.denySubagents) {
    patch['deny_subagents'] = draft.denySubagents === undefined ? null : [...draft.denySubagents];
  }
  return Object.keys(patch).length === 0 ? undefined : (patch as SubagentPolicyPatch);
}

export interface ModelProfileDraft {
  readonly alias: string;
  readonly when: string;
  readonly effort: string;
  readonly modelPrompt?: PromptIdentityDraft<ModelPromptDraft>;
  readonly promptOverrides?: PromptIdentityDraft<PromptOverridesDraft>;
}

export interface ProfileDraft {
  readonly description: string;
  readonly whenToUse: string;
  readonly prompt: string;
  readonly promptOverrides: PromptIdentityDraft<PromptOverridesDraft>;
  readonly main: boolean;
  /** '' = native (field absent). */
  readonly executor: string;
  /** External main only: inject the Kiki MCP bridge so the engine can dispatch Kiki subagents. */
  readonly allowKikiSubagents: boolean;
  /**
   * External main only: Kiki groups handed to the engine. `undefined` = the
   * field is absent (all off by default); `[]` = written as explicitly all off.
   */
  readonly kikiContext: readonly KikiContextGroup[] | undefined;
  readonly modelAlias: string;
  readonly effort: string;
  readonly restrictModelsToMenu: boolean;
  readonly preferredModels: readonly string[];
  readonly discouragedModels: readonly string[];
  readonly preferredEfforts: readonly string[];
  readonly allowedModels: readonly string[];
  readonly denyModels: readonly string[];
  readonly allowedEfforts: readonly string[];
  /** The one place dispatch rights live: the switch plus the three lists. */
  readonly subagentPolicy: SubagentPolicyDraft;
  readonly modelProfiles: readonly ModelProfileDraft[];
  readonly serviceTier: '' | NonNullable<NamedAgentProfile['service_tier']>;
  readonly autoCompact: number | undefined;
  readonly tools: ToolFieldValue;
  readonly disallowedTools: ToolFieldValue;
  readonly routeAliases: Readonly<Record<string, string>>;
  /** Ceiling on every subagent this agent spawns; all-empty = the field is absent. */
  readonly spawnConstraints: SpawnConstraintsDraft;
  /** How the profile reaches an external engine; `null` = the field is absent. */
  readonly executorPrompt: ExecutorPromptDraft | null;
}

export interface SpawnConstraintsDraft {
  readonly allowedModels: readonly string[];
  readonly denyModels: readonly string[];
  readonly allowedEfforts: readonly string[];
  /** Comma or newline separated tool names. */
  readonly disallowedTools: string;
}

export const EMPTY_SPAWN_CONSTRAINTS: SpawnConstraintsDraft = { allowedModels: [], denyModels: [], allowedEfforts: [], disallowedTools: '' };

export function spawnConstraintsSet(value: SpawnConstraintsDraft): boolean {
  return value.allowedModels.length > 0 || value.denyModels.length > 0 || value.allowedEfforts.length > 0
    || (parseNamedAgentTools(value.disallowedTools) ?? []).length > 0;
}

/** `null` removes the frontmatter key; otherwise only the non-empty lists are written. */
export function spawnConstraintsBody(value: SpawnConstraintsDraft): UpdateNamedAgentProfileRequest['spawn_constraints'] {
  if (!spawnConstraintsSet(value)) return null;
  const tools = parseNamedAgentTools(value.disallowedTools) ?? [];
  return {
    allowed_models: value.allowedModels.length > 0 ? [...value.allowedModels] : undefined,
    deny_models: value.denyModels.length > 0 ? [...value.denyModels] : undefined,
    allowed_efforts: value.allowedEfforts.length > 0 ? [...value.allowedEfforts] : undefined,
    disallowed_tools: tools.length > 0 ? tools : undefined,
  };
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Display form of an effort level, matching the composer's picker ("High"); the value stays as stored. */
export function effortLabel(level: string): string {
  return level === '' ? level : level.charAt(0).toUpperCase() + level.slice(1);
}

export function isExternalExecutor(executor: string | undefined): boolean {
  return executor !== undefined && executor !== '' && executor !== 'native';
}

/** Whether the draft's Kiki-subagents switch applies: only an external engine running as main. */
export function kikiSubagentsApplicable(draft: Pick<ProfileDraft, 'executor' | 'main'>): boolean {
  return draft.main && isExternalExecutor(draft.executor);
}

function kikiSubagentsEffective(draft: ProfileDraft): boolean {
  return draft.allowKikiSubagents && kikiSubagentsApplicable(draft);
}

export const KIKI_CONTEXT_ORDER: readonly KikiContextGroup[] = ['memory', 'board', 'cron', 'threads', 'history', 'hooks'];

/** A group list in the editor's fixed order, duplicates dropped; `undefined` stays absent. */
export function normalizeKikiContext(value: readonly KikiContextGroup[] | undefined): readonly KikiContextGroup[] | undefined {
  return value === undefined ? undefined : KIKI_CONTEXT_ORDER.filter((group) => value.includes(group));
}

/**
 * Flip one group. Turning the last group off returns to the baseline's empty
 * form, so switching a group on and off again leaves an absent field absent;
 * a list that had groups goes to an explicit `[]`.
 */
export function toggleKikiContext(
  current: readonly KikiContextGroup[] | undefined,
  group: KikiContextGroup,
  on: boolean,
  baseline: readonly KikiContextGroup[] | undefined,
): readonly KikiContextGroup[] | undefined {
  const next = normalizeKikiContext([...(current ?? []).filter((item) => item !== group), ...(on ? [group] : [])])!;
  if (next.length > 0) return next;
  return baseline === undefined || baseline.length === 0 ? baseline : [];
}

export function draftFromProfile(profile: NamedAgentProfile): ProfileDraft {
  return {
    description: profile.description ?? '',
    whenToUse: profile.when_to_use ?? '',
    prompt: profile.prompt ?? '',
    promptOverrides: promptIdentityDraft(profile.prompt_overrides, promptOverridesDraft),
    main: profile.main,
    executor: isExternalExecutor(profile.executor) ? profile.executor! : '',
    allowKikiSubagents: profile.allow_kiki_subagents === true,
    kikiContext: normalizeKikiContext(profile.kiki_context),
    modelAlias: profile.pinned_model_alias ?? '',
    effort: profile.thinking_effort ?? '',
    restrictModelsToMenu: profile.restrict_models_to_menu === true,
    preferredModels: profile.preferred_models ?? [],
    discouragedModels: profile.discouraged_models ?? [],
    preferredEfforts: profile.preferred_efforts ?? [],
    allowedModels: profile.allowed_models ?? [],
    denyModels: profile.deny_models ?? [],
    allowedEfforts: profile.allowed_efforts ?? [],
    subagentPolicy: subagentPolicyFromProfile(profile),
    modelProfiles: (profile.model_profiles ?? []).map((entry) => ({
      alias: entry.alias, when: entry.when ?? '', effort: entry.thinking_effort ?? '',
      modelPrompt: promptIdentityDraft(entry, modelPromptDraft),
      promptOverrides: promptIdentityDraft(entry.prompt_overrides, promptOverridesDraft),
    })),
    serviceTier: profile.service_tier ?? '',
    autoCompact: profile.auto_compact,
    tools: toolFieldFrom(profile.tools),
    disallowedTools: toolFieldFrom(profile.disallowed_tools),
    routeAliases: Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])),
    spawnConstraints: {
      allowedModels: profile.spawn_constraints?.allowed_models ?? [],
      denyModels: profile.spawn_constraints?.deny_models ?? [],
      allowedEfforts: profile.spawn_constraints?.allowed_efforts ?? [],
      disallowedTools: (profile.spawn_constraints?.disallowed_tools ?? []).join(', '),
    },
    executorPrompt: executorPromptDraftFrom(profile.executor_prompt),
  };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const listOrNull = (list: readonly string[]) => list.length === 0 ? null : [...list];
const textOrNull = (text: string) => text.trim() === '' ? null : text.trim();

/** Frontmatter-level fields the draft changed, for the dirty flag and the field counters. */
export function changedFields(baseline: ProfileDraft, draft: ProfileDraft): (keyof ProfileDraft)[] {
  return (Object.keys(draft) as (keyof ProfileDraft)[]).filter((key) =>
    key === 'tools' || key === 'disallowedTools'
      ? !toolFieldsEqual(draft[key], baseline[key])
      : !same(draft[key], baseline[key]));
}

/**
 * The PATCH for one save: only fields that changed ride along, so an untouched
 * `tools: []` stays an explicit empty list and untouched lease keys survive.
 */
export function patchBody(
  profile: NamedAgentProfile,
  baseline: ProfileDraft,
  draft: ProfileDraft,
): UpdateNamedAgentProfileRequest {
  const changed = new Set(changedFields(baseline, draft));
  const body: UpdateNamedAgentProfileRequest = {
    scope: writeScope(profile), workspace_id: profile.workspace_id!, source_file: profile.source_file,
  };
  if (changed.has('description')) body.description = draft.description.trim();
  if (changed.has('whenToUse')) body.when_to_use = textOrNull(draft.whenToUse);
  if (changed.has('prompt')) body.prompt = draft.prompt;
  if (changed.has('main')) body.main = draft.main;
  if (changed.has('executor')) body.executor = textOrNull(draft.executor);
  // Off deletes the key: an absent flag and `false` keep the same binding
  // fingerprint. The flag only means something on an external main, so a
  // draft that stops being one clears it instead of saving a binding the
  // engine would refuse.
  const kikiSubagents = kikiSubagentsEffective(draft);
  if (kikiSubagents !== kikiSubagentsEffective(baseline) || (changed.has('allowKikiSubagents') && kikiSubagents !== (profile.allow_kiki_subagents === true))) {
    body.allow_kiki_subagents = kikiSubagents ? true : null;
  }
  // `null` removes the key, `[]` writes an explicit all-off; an untouched list
  // never rides along. A draft that stops being an external main drops the
  // key rather than keep groups nothing can use.
  if (kikiSubagentsApplicable(draft)) {
    if (changed.has('kikiContext')) body.kiki_context = draft.kikiContext === undefined ? null : [...draft.kikiContext];
  } else if (kikiSubagentsApplicable(baseline) && profile.kiki_context !== undefined) {
    body.kiki_context = null;
  }
  if (changed.has('modelAlias')) body.pinned_model_alias = textOrNull(draft.modelAlias);
  if (changed.has('effort')) body.thinking_effort = textOrNull(draft.effort);
  if (changed.has('restrictModelsToMenu')) body.restrict_models_to_menu = draft.restrictModelsToMenu;
  if (changed.has('preferredModels')) body.preferred_models = listOrNull(draft.preferredModels);
  if (changed.has('discouragedModels')) body.discouraged_models = listOrNull(draft.discouragedModels);
  if (changed.has('preferredEfforts')) body.preferred_efforts = listOrNull(draft.preferredEfforts);
  if (changed.has('allowedModels')) body.allowed_models = listOrNull(draft.allowedModels);
  if (changed.has('denyModels')) body.deny_models = listOrNull(draft.denyModels);
  if (changed.has('allowedEfforts')) body.allowed_efforts = listOrNull(draft.allowedEfforts);
  const dispatch = subagentPolicyPatch(baseline.subagentPolicy, draft.subagentPolicy);
  if (dispatch !== undefined) assignSubagentPolicy(body, dispatch);
  if (changed.has('promptOverrides')) body.prompt_overrides = overridesPatch(draft.promptOverrides);
  if (changed.has('modelProfiles')) {
    body.model_profiles = draft.modelProfiles.length === 0 ? null : draft.modelProfiles.map((entry) => {
      const previous = baseline.modelProfiles.find((item) => item.alias === entry.alias);
      const patch: NonNullable<UpdateNamedAgentProfileRequest['model_profiles']>[number] = {
        alias: entry.alias.trim(), when: textOrNull(entry.when), thinking_effort: textOrNull(entry.effort),
      };
      if (entry.modelPrompt !== undefined && !same(entry.modelPrompt, previous?.modelPrompt)) {
        const prompt = modelPromptIdentityBody(entry.modelPrompt);
        patch.prompt_mode = prompt.prompt_mode ?? null;
        patch.prompt = prompt.prompt ?? null;
        patch.main = prompt.main ?? null;
        patch.independent = prompt.independent ?? null;
      }
      if (entry.promptOverrides !== undefined && !same(entry.promptOverrides, previous?.promptOverrides)) patch.prompt_overrides = overridesPatch(entry.promptOverrides);
      return patch;
    });
  }
  if (changed.has('serviceTier')) body.service_tier = draft.serviceTier === '' ? null : draft.serviceTier;
  if (changed.has('autoCompact')) body.auto_compact = draft.autoCompact ?? null;
  if (changed.has('tools')) body.tools = toolFieldBody(draft.tools);
  if (changed.has('disallowedTools')) body.disallowed_tools = toolFieldBody(draft.disallowedTools);
  if (changed.has('spawnConstraints')) body.spawn_constraints = spawnConstraintsBody(draft.spawnConstraints);
  if (changed.has('executorPrompt')) body.executor_prompt = executorPromptBody(draft.executorPrompt);
  if (changed.has('routeAliases')) {
    body.routes = profile.routes
      .filter((route) => (draft.routeAliases[route.id] ?? '') !== (baseline.routeAliases[route.id] ?? ''))
      .map((route) => ({ id: route.id, model_alias: textOrNull(draft.routeAliases[route.id] ?? '') }));
  }
  return body;
}

function overridesPatch(draft: PromptIdentityDraft<PromptOverridesDraft>) {
  const value = promptIdentityBody(draft, promptOverridesBody);
  return Object.values(value).some((item) => item !== undefined) ? value : null;
}

/** Reasons the current draft cannot be saved, as i18n keys (empty = savable). */
export function draftProblems(draft: ProfileDraft): ('description' | 'mainInherit' | 'tools' | 'subagents' | 'modelProfiles' | 'executorPrompt' | 'promptOverrides')[] {
  const problems: ('description' | 'mainInherit' | 'tools' | 'subagents' | 'modelProfiles' | 'executorPrompt' | 'promptOverrides')[] = [];
  if (promptIdentityProblem(draft.promptOverrides, promptOverridesBody, promptOverridesProblem) !== undefined) problems.push('promptOverrides');
  if (draft.modelProfiles.some((entry) =>
    (entry.modelPrompt !== undefined && promptIdentityProblem(entry.modelPrompt, modelPromptBody, modelPromptProblem) !== undefined)
    || (entry.promptOverrides !== undefined && promptIdentityProblem(entry.promptOverrides, promptOverridesBody, promptOverridesProblem) !== undefined))) problems.push('promptOverrides');
  if (!executorPromptIncludesValid(draft.executorPrompt)) problems.push('executorPrompt');
  if (draft.description.trim() === '') problems.push('description');
  if (draft.main && draft.modelAlias.trim() === 'inherit') problems.push('mainInherit');
  if (toolFieldUnnamed(draft.tools) || toolFieldUnnamed(draft.disallowedTools)) problems.push('tools');
  // Each list is checked on its own: a recommendation naming a preset that is
  // already allowed is the normal case, not a conflict. A hard leaf is not
  // checked at all, because the switch is off and the lists are kept as they
  // are rather than edited.
  if (draft.subagentPolicy.canSpawnSubagents !== false) {
    const lists = [
      (draft.subagentPolicy.allowedSubagents ?? []).map((entry) => entry.name.trim()),
      (draft.subagentPolicy.preferredSubagents ?? []).map((name) => name.trim()),
      (draft.subagentPolicy.denySubagents ?? []).map((name) => name.trim()),
    ];
    const broken = lists.some((names) => names.some((name) => name === '') || new Set(names).size !== names.length);
    if (broken) problems.push('subagents');
  }
  const aliases = draft.modelProfiles.map((entry) => entry.alias.trim());
  if (aliases.some((alias) => !/^\S+$/.test(alias)) || new Set(aliases).size !== aliases.length) problems.push('modelProfiles');
  return problems;
}

export function writeScope(profile: NamedAgentProfile): UpdateNamedAgentProfileRequest['scope'] {
  return profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra';
}

export function isWritable(profile: NamedAgentProfile): boolean {
  return profile.workspace_id !== undefined && profile.source_file !== undefined
    && ['user', 'workspace', 'extra'].includes(profile.source);
}
