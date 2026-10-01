import type { NamedAgentProfile, ShippedAgentProfile } from '../../../lib/client';
import type { NamedAgentOverrideRelation } from '@kiki/session-core/settings';
import { isExternalExecutor } from './profileDraft';

/**
 * What the editor can honestly say about one profile. Each entry is a fact
 * the loaded data proves; nothing here is inferred from logs.
 */
export type ProfileDiagnostic =
  /** An alias the model catalog does not list (skipped for external engines: they bring their own ids). */
  | { readonly kind: 'aliasMissing'; readonly field: 'model_alias' | 'model_profiles' | 'allowed_models' | 'lease'; readonly alias: string; readonly via?: string }
  /** A `subagents` entry no loaded profile answers to. */
  | { readonly kind: 'subagentMissing'; readonly name: string }
  /** This file is loaded but a same-name profile runs instead. */
  | { readonly kind: 'shadowedBy'; readonly winner: NamedAgentProfile }
  /** This file runs and hides same-name files (other sources, or duplicates in its own source). */
  | { readonly kind: 'shadows'; readonly hidden: readonly string[] }
  /** The managed copy of a shipped profile was edited. */
  | { readonly kind: 'builtinModified'; readonly status: ShippedAgentProfile['status'] }
  | { readonly kind: 'overridesBuiltin' }
  | { readonly kind: 'modelMenuEmpty' }
  /** The executor ignores fields this profile sets. */
  | { readonly kind: 'executorIgnored'; readonly fields: readonly string[] };

export interface DiagnosticContext {
  readonly profiles: readonly NamedAgentProfile[];
  /** Same-name winners for the selected workspace; undefined without a workspace. */
  readonly effective?: readonly NamedAgentProfile[];
  /** Catalog ids; undefined while unknown (no alias checks then). */
  readonly modelIds?: ReadonlySet<string>;
  readonly shippedEntry?: ShippedAgentProfile;
  readonly overrideRelation?: NamedAgentOverrideRelation;
}

export const sameProfile = (left: NamedAgentProfile, right: NamedAgentProfile) =>
  left.name === right.name && left.source === right.source && left.source_file === right.source_file;

export function profileLocation(profile: NamedAgentProfile): string {
  return profile.source_file ?? profile.source;
}

/** Wire keys that count as "set" for the executor-applicability check. */
const SET_CHECKS: Readonly<Record<string, (profile: NamedAgentProfile) => boolean>> = {
  tools: (profile) => profile.tools !== undefined,
  disallowed_tools: (profile) => profile.disallowed_tools !== undefined,
  service_tier: (profile) => profile.service_tier !== undefined,
  request_params: (profile) => profile.request_params !== undefined,
  thinking_effort: (profile) => profile.thinking_effort !== undefined,
  pinned_model_alias: (profile) => profile.pinned_model_alias !== undefined,
  auto_compact: (profile) => profile.auto_compact !== undefined,
  subagents: (profile) => profile.subagents !== undefined,
};

export function ignoredSetFields(profile: NamedAgentProfile): string[] {
  return Object.entries(profile.executor_fields ?? {})
    .filter(([key, field]) => field.state === 'ignored' && (SET_CHECKS[key]?.(profile) ?? false))
    .map(([key]) => key);
}

export function profileDiagnostics(profile: NamedAgentProfile, context: DiagnosticContext): ProfileDiagnostic[] {
  const out: ProfileDiagnostic[] = [];
  if (profile.restrict_models_to_menu === true && profile.effective_model_aliases?.length === 0) out.push({ kind: 'modelMenuEmpty' });
  const { modelIds } = context;
  if (modelIds !== undefined && modelIds.size > 0 && !isExternalExecutor(profile.executor)) {
    const missing = (alias: string | null | undefined): alias is string =>
      typeof alias === 'string' && alias !== '' && alias !== 'inherit' && alias !== '*' && !modelIds.has(alias);
    if (missing(profile.pinned_model_alias)) out.push({ kind: 'aliasMissing', field: 'model_alias', alias: profile.pinned_model_alias! });
    for (const entry of profile.model_profiles ?? []) {
      if (missing(entry.alias)) out.push({ kind: 'aliasMissing', field: 'model_profiles', alias: entry.alias });
    }
    for (const alias of profile.allowed_models ?? []) {
      if (missing(alias)) out.push({ kind: 'aliasMissing', field: 'allowed_models', alias });
    }
    for (const entry of profile.subagents ?? []) {
      if (typeof entry === 'string') continue;
      for (const alias of [entry.model_alias, ...(entry.allowed_models ?? [])]) {
        if (missing(alias)) out.push({ kind: 'aliasMissing', field: 'lease', alias: alias!, via: entry.name });
      }
    }
  }
  const names = new Set(context.profiles.map((candidate) => candidate.name));
  for (const entry of profile.subagents ?? []) {
    const name = typeof entry === 'string' ? entry : entry.name;
    // Scoped leases resolve a private source file; their status says it.
    const scoped = typeof entry !== 'string' && entry.source !== undefined;
    if (name !== '*' && !scoped && !names.has(name)) out.push({ kind: 'subagentMissing', name });
  }
  const siblings = context.profiles.filter((candidate) => candidate.name === profile.name && !sameProfile(candidate, profile));
  const winner = context.effective?.find((candidate) => candidate.name === profile.name);
  if (winner !== undefined && !sameProfile(winner, profile)) {
    out.push({ kind: 'shadowedBy', winner });
  } else {
    const hidden = [
      ...(winner !== undefined ? siblings.map(profileLocation) : []),
      ...(profile.shadowed_files ?? []),
    ];
    if (hidden.length > 0) out.push({ kind: 'shadows', hidden });
  }
  if (context.shippedEntry !== undefined && (context.shippedEntry.status === 'custom' || context.shippedEntry.status === 'update-available')) {
    out.push({ kind: 'builtinModified', status: context.shippedEntry.status });
  }
  if (context.overrideRelation?.kind === 'overrides_builtin') out.push({ kind: 'overridesBuiltin' });
  const ignored = ignoredSetFields(profile);
  if (ignored.length > 0) out.push({ kind: 'executorIgnored', fields: ignored });
  return out;
}

/** Warnings change what runs; notes only explain provenance. */
export function diagnosticTone(diagnostic: ProfileDiagnostic): 'warning' | 'note' {
  return diagnostic.kind === 'overridesBuiltin' || diagnostic.kind === 'builtinModified' || diagnostic.kind === 'shadows'
    ? 'note' : 'warning';
}
