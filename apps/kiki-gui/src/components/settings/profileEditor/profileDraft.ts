import { parseNamedAgentTools } from '@kiki/session-core/settings';
import type { NamedAgentProfile, UpdateNamedAgentProfileRequest } from '../../../lib/client';
import type { KikiContextGroup } from '../../harness/kikiContext';
import { subagentPolicyBody, subagentPolicyChoice, type SubagentPolicyChoice } from '../subagentPolicy';
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

/** `unrestricted`: no whitelist (absent or `"*"`); `none`: `[]`, a leaf; `list`: the names below. */
export type SubagentsMode = 'unrestricted' | 'none' | 'list';

export interface SubagentDraft {
  readonly name: string;
  /** Lease pins; '' = the lease does not pin it. */
  readonly modelAlias: string;
  readonly effort: string;
  /** Read-only lease facts carried for display. */
  readonly source?: string;
  readonly status?: 'ready' | 'unavailable';
  readonly allowedModels?: readonly string[];
}

export interface ModelProfileDraft { readonly alias: string; readonly when: string; readonly effort: string }

export interface ProfileDraft {
  readonly description: string;
  readonly whenToUse: string;
  readonly prompt: string;
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
  readonly subagentsMode: SubagentsMode;
  readonly subagents: readonly SubagentDraft[];
  readonly subagentPolicy: SubagentPolicyChoice;
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
  const subagents = profile.subagents;
  return {
    description: profile.description ?? '',
    whenToUse: profile.when_to_use ?? '',
    prompt: profile.prompt ?? '',
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
    subagentsMode: subagents === undefined ? 'unrestricted' : subagents.length === 0 ? 'none' : 'list',
    subagents: (subagents ?? []).map((entry) => typeof entry === 'string'
      ? { name: entry, modelAlias: '', effort: '' }
      : {
          name: entry.name, modelAlias: entry.model_alias ?? '', effort: entry.thinking_effort ?? '',
          source: entry.source, status: entry.status, allowedModels: entry.allowed_models,
        }),
    subagentPolicy: subagentPolicyChoice(profile.subagent_policy),
    modelProfiles: (profile.model_profiles ?? []).map((entry) => ({
      alias: entry.alias, when: entry.when ?? '', effort: entry.thinking_effort ?? '',
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
  if (changed.has('subagentPolicy')) body.subagent_policy = subagentPolicyBody(draft.subagentPolicy);
  if (changed.has('subagentsMode') || changed.has('subagents')) {
    const before = new Map(baseline.subagents.map((entry) => [entry.name, entry]));
    body.subagents = draft.subagentsMode === 'unrestricted' ? null
      : draft.subagentsMode === 'none' ? []
        : draft.subagents.map((entry) => {
            const prior = before.get(entry.name);
            if (prior !== undefined && prior.modelAlias === entry.modelAlias && prior.effort === entry.effort) return entry.name;
            return { name: entry.name, model_alias: textOrNull(entry.modelAlias), thinking_effort: textOrNull(entry.effort) };
          });
  }
  if (changed.has('modelProfiles')) {
    body.model_profiles = draft.modelProfiles.length === 0 ? null : draft.modelProfiles.map((entry) => ({
      alias: entry.alias.trim(), when: textOrNull(entry.when), thinking_effort: textOrNull(entry.effort),
    }));
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

/** Reasons the current draft cannot be saved, as i18n keys (empty = savable). */
export function draftProblems(draft: ProfileDraft): ('description' | 'mainInherit' | 'tools' | 'subagents' | 'modelProfiles' | 'executorPrompt')[] {
  const problems: ('description' | 'mainInherit' | 'tools' | 'subagents' | 'modelProfiles' | 'executorPrompt')[] = [];
  if (!executorPromptIncludesValid(draft.executorPrompt)) problems.push('executorPrompt');
  if (draft.description.trim() === '') problems.push('description');
  if (draft.main && draft.modelAlias.trim() === 'inherit') problems.push('mainInherit');
  if (toolFieldUnnamed(draft.tools) || toolFieldUnnamed(draft.disallowedTools)) problems.push('tools');
  const names = draft.subagents.map((entry) => entry.name.trim());
  if (draft.subagentsMode === 'list' && (names.length === 0 || names.some((name) => name === '') || new Set(names).size !== names.length)) {
    problems.push('subagents');
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
